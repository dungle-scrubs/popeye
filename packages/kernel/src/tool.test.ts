import { Effect, Layer, Schema } from "effect";
import { expect, test } from "vitest";

import { defineTool, ToolRegistry, ToolRegistryLive } from "./tool.js";

test("heterogeneous tools register and list their declarations", async () => {
  const text = defineTool({
    description: "Returns text.",
    execute: (arguments_: { readonly text: string }) =>
      Effect.succeed({ content: arguments_.text }),
    name: "text",
    parameters: Schema.Struct({ text: Schema.String }),
  });
  const count = defineTool({
    description: "Returns a count.",
    execute: (arguments_: { readonly count: number }) =>
      Effect.succeed({ content: String(arguments_.count) }),
    name: "count",
    parameters: Schema.Struct({ count: Schema.Number }),
  });

  const listed = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ToolRegistry;
      return registry.list();
    }).pipe(Effect.provide(ToolRegistryLive([text, count]))),
  );

  expect(listed.map((tool) => tool.name)).toEqual(["text", "count"]);
  expect(listed.map((tool) => tool.parameters)).toEqual([text.parameters, count.parameters]);
});

test("duplicate tool names fail layer construction with a typed diagnostic", async () => {
  const first = defineTool({
    description: "First declaration.",
    execute: () => Effect.succeed({ content: "first" }),
    name: "duplicate",
    parameters: Schema.Struct({ first: Schema.String }),
  });
  const second = defineTool({
    description: "Second declaration.",
    execute: () => Effect.succeed({ content: "second" }),
    name: "duplicate",
    parameters: Schema.Struct({ second: Schema.Number }),
  });

  const error = await Effect.runPromise(
    Effect.scoped(Layer.build(ToolRegistryLive([first, second]))).pipe(Effect.flip),
  );

  expect(error).toMatchObject({
    _tag: "DuplicateToolName",
    message: "Duplicate tool name: duplicate.",
    name: "duplicate",
  });
});

test("defineTool preserves safe replay and the registry defaults omitted replay to never", async () => {
  const safe = defineTool({
    description: "Safe to repeat.",
    execute: () => Effect.succeed({ content: "safe" }),
    name: "safe",
    parameters: Schema.Struct({}),
    replay: "safe" as const,
  });
  const defaulted = defineTool({
    description: "Must not repeat.",
    execute: () => Effect.succeed({ content: "never" }),
    name: "defaulted",
    parameters: Schema.Struct({}),
  });

  const listed = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ToolRegistry;
      return registry.list();
    }).pipe(Effect.provide(ToolRegistryLive([safe, defaulted]))),
  );

  expect(safe.replay).toBe("safe");
  expect(listed.map((tool) => ({ name: tool.name, replay: tool.replay }))).toEqual([
    { name: "safe", replay: "safe" },
    { name: "defaulted", replay: "never" },
  ]);
});
