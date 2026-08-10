import type { SessionId } from "@peye/journal";
import { Deferred, Effect, Fiber, Layer, Ref, Schema, type Scope, Tracer } from "effect";
import { expect, test } from "vitest";

import { ToolError } from "./errors.js";
import { defineTool, type Tool, ToolRegistryLive } from "./tool.js";
import { executeToolBatch } from "./tool-batch.js";

const testSessionId = "session" as SessionId;

test("tool batch runs with bounded concurrency using the default of four", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const current = yield* Ref.make(0);
      const maximum = yield* Ref.make(0);
      const release = yield* Ref.make(false);
      const started = yield* Ref.make(0);
      const tool: Tool<{ readonly value: number }> = {
        description: "Blocks until the test releases it.",
        execute: () =>
          Ref.updateAndGet(current, (count) => count + 1).pipe(
            Effect.tap((count) => Ref.update(maximum, (seen) => Math.max(seen, count))),
            Effect.zipRight(Ref.update(started, (count) => count + 1)),
            Effect.zipRight(
              Effect.repeat(Ref.get(release), {
                until: (isReleased) => isReleased,
                while: (isReleased) => !isReleased,
              }),
            ),
            Effect.zipRight(Ref.update(current, (count) => count - 1)),
            Effect.as({ content: "complete" }),
          ),
        name: "block",
        parameters: Schema.Struct({ value: Schema.Number }),
      };
      const batch = yield* Effect.fork(
        executeToolBatch(
          [
            { argumentsJson: '{"value":1}', id: "call-1", name: "block" },
            { argumentsJson: '{"value":2}', id: "call-2", name: "block" },
            { argumentsJson: '{"value":3}', id: "call-3", name: "block" },
            { argumentsJson: '{"value":4}', id: "call-4", name: "block" },
            { argumentsJson: '{"value":5}', id: "call-5", name: "block" },
          ],
          { sessionId: testSessionId },
        ).pipe(Effect.provide(ToolRegistryLive([defineTool(tool)]))),
      );
      yield* Effect.repeat(Ref.get(started), { until: (count) => count === 4 });
      const observed = {
        maximum: yield* Ref.get(maximum),
        started: yield* Ref.get(started),
      };
      yield* Ref.set(release, true);
      const completed = yield* batch.pipe(Fiber.join);
      return { completed, observed };
    }),
  );

  expect(result.observed).toEqual({ maximum: 4, started: 4 });
  expect(result.completed.results).toHaveLength(5);
});

test("tool batch accepts a configured concurrency limit", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const current = yield* Ref.make(0);
      const maximum = yield* Ref.make(0);
      const release = yield* Ref.make(false);
      const started = yield* Ref.make(0);
      const tool: Tool<{ readonly value: number }> = {
        description: "Blocks until the test releases it.",
        execute: () =>
          Ref.updateAndGet(current, (count) => count + 1).pipe(
            Effect.tap((count) => Ref.update(maximum, (seen) => Math.max(seen, count))),
            Effect.zipRight(Ref.update(started, (count) => count + 1)),
            Effect.zipRight(
              Effect.repeat(Ref.get(release), {
                until: (isReleased) => isReleased,
                while: (isReleased) => !isReleased,
              }),
            ),
            Effect.zipRight(Ref.update(current, (count) => count - 1)),
            Effect.as({ content: "complete" }),
          ),
        name: "block",
        parameters: Schema.Struct({ value: Schema.Number }),
      };
      const batch = yield* Effect.fork(
        executeToolBatch(
          [
            { argumentsJson: '{"value":1}', id: "call-1", name: "block" },
            { argumentsJson: '{"value":2}', id: "call-2", name: "block" },
            { argumentsJson: '{"value":3}', id: "call-3", name: "block" },
          ],
          { sessionId: testSessionId },
          { concurrency: 2 },
        ).pipe(Effect.provide(ToolRegistryLive([defineTool(tool)]))),
      );
      yield* Effect.repeat(Ref.get(started), { until: (count) => count === 2 });
      const observed = { maximum: yield* Ref.get(maximum), started: yield* Ref.get(started) };
      yield* Ref.set(release, true);
      yield* Fiber.join(batch);
      return observed;
    }),
  );

  expect(result).toEqual({ maximum: 2, started: 2 });
});

test("a sequential tool forces its whole batch to execute sequentially", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const current = yield* Ref.make(0);
      const maximum = yield* Ref.make(0);
      const tool: Tool<{ readonly value: number }> = {
        description: "Records simultaneous executions.",
        execute: () =>
          Ref.updateAndGet(current, (count) => count + 1).pipe(
            Effect.tap((count) => Ref.update(maximum, (seen) => Math.max(seen, count))),
            Effect.zipRight(Effect.yieldNow()),
            Effect.zipRight(Ref.update(current, (count) => count - 1)),
            Effect.as({ content: "complete" }),
          ),
        executionMode: "sequential",
        name: "ordered",
        parameters: Schema.Struct({ value: Schema.Number }),
      };
      const parallel: Tool<{ readonly value: number }> = {
        description: "Can execute in parallel.",
        execute: () => Effect.succeed({ content: "parallel" }),
        name: "parallel",
        parameters: Schema.Struct({ value: Schema.Number }),
      };
      const completed = yield* executeToolBatch(
        [
          { argumentsJson: '{"value":1}', id: "call-1", name: "ordered" },
          { argumentsJson: '{"value":2}', id: "call-2", name: "parallel" },
          { argumentsJson: '{"value":3}', id: "call-3", name: "ordered" },
        ],
        { sessionId: testSessionId },
        { concurrency: 4 },
      ).pipe(Effect.provide(ToolRegistryLive([defineTool(tool), defineTool(parallel)])));
      return { completed, maximum: yield* Ref.get(maximum) };
    }),
  );

  expect(result.completed).toMatchObject({ concurrency: 1, mode: "sequential" });
  expect(result.maximum).toBe(1);
});

test("a failed tool yields an error result in position while other tools complete", async () => {
  const failed: Tool<{ readonly value: string }> = {
    description: "Fails intentionally.",
    execute: (_arguments, context) =>
      Effect.fail(
        new ToolError({
          message: "The tool failed.",
          toolCallId: context.sessionId,
          toolName: "failed",
        }),
      ),
    name: "failed",
    parameters: Schema.Struct({ value: Schema.String }),
  };
  const succeeded: Tool<{ readonly value: string }> = {
    description: "Succeeds after a failure.",
    execute: () => Effect.succeed({ content: "success" }),
    name: "succeeded",
    parameters: Schema.Struct({ value: Schema.String }),
  };
  const result = await Effect.runPromise(
    executeToolBatch(
      [
        { argumentsJson: '{"value":"first"}', id: "failed-call", name: "failed" },
        { argumentsJson: '{"value":"second"}', id: "succeeded-call", name: "succeeded" },
      ],
      { sessionId: testSessionId },
    ).pipe(Effect.provide(ToolRegistryLive([defineTool(failed), defineTool(succeeded)]))),
  );

  expect(result.results).toEqual([
    { content: "The tool failed.", isError: true, toolCallId: "failed-call" },
    { content: "success", toolCallId: "succeeded-call" },
  ]);
});

test("invalid tool arguments become a model-visible error result before execution", async () => {
  let executed = false;
  const tool: Tool<{ readonly count: number }> = {
    description: "Requires a number.",
    execute: () =>
      Effect.sync(() => {
        executed = true;
        return { content: "should not run" };
      }),
    name: "requires-number",
    parameters: Schema.Struct({ count: Schema.Number }),
  };
  const result = await Effect.runPromise(
    executeToolBatch(
      [{ argumentsJson: '{"count":"wrong"}', id: "invalid-call", name: "requires-number" }],
      { sessionId: testSessionId },
    ).pipe(Effect.provide(ToolRegistryLive([defineTool(tool)]))),
  );

  expect(executed).toBe(false);
  expect(result.results).toHaveLength(1);
  expect(result.results[0]).toMatchObject({ isError: true, toolCallId: "invalid-call" });
  expect(result.results[0]?.content).toContain("Invalid arguments for tool requires-number:");
  expect(result.results[0]?.content).toContain('Expected number, actual "wrong"');
});

test("strict argument decoding rejects excess properties and names the offending key", async () => {
  const tool: Tool<{ readonly count: number }> = {
    description: "Requires only a count.",
    execute: () => Effect.succeed({ content: "should not run" }),
    name: "strict",
    parameters: Schema.Struct({ count: Schema.Number }),
  };
  const result = await Effect.runPromise(
    executeToolBatch(
      [{ argumentsJson: '{"count":1,"unexpected":true}', id: "strict-call", name: "strict" }],
      { sessionId: testSessionId },
    ).pipe(Effect.provide(ToolRegistryLive([defineTool(tool)]))),
  );

  expect(result.results[0]).toMatchObject({ isError: true, toolCallId: "strict-call" });
  expect(result.results[0]?.content).toContain("unexpected");
  expect(result.results[0]?.content).toContain("is unexpected");
});

test("throwing and dying tools become in-position errors while healthy siblings complete", async () => {
  const healthy: Tool<{ readonly value: string }> = {
    description: "Succeeds.",
    execute: (arguments_) => Effect.succeed({ content: arguments_.value }),
    name: "healthy",
    parameters: Schema.Struct({ value: Schema.String }),
  };
  const throwing: Tool<{ readonly value: string }> = {
    description: "Throws a foreign exception.",
    execute: () =>
      Effect.sync(() => {
        throw new Error("thrown defect");
      }),
    name: "throwing",
    parameters: Schema.Struct({ value: Schema.String }),
  };
  const dying: Tool<{ readonly value: string }> = {
    description: "Dies intentionally.",
    execute: () => Effect.die(new Error("explicit defect")),
    name: "dying",
    parameters: Schema.Struct({ value: Schema.String }),
  };
  const result = await Effect.runPromise(
    executeToolBatch(
      [
        { argumentsJson: '{"value":"before"}', id: "healthy-before", name: "healthy" },
        { argumentsJson: '{"value":"throw"}', id: "throw-call", name: "throwing" },
        { argumentsJson: '{"value":"die"}', id: "die-call", name: "dying" },
        { argumentsJson: '{"value":"after"}', id: "healthy-after", name: "healthy" },
      ],
      { sessionId: testSessionId },
    ).pipe(
      Effect.provide(
        ToolRegistryLive([defineTool(healthy), defineTool(throwing), defineTool(dying)]),
      ),
    ),
  );

  expect(result.results.map((item) => item.toolCallId)).toEqual([
    "healthy-before",
    "throw-call",
    "die-call",
    "healthy-after",
  ]);
  expect(result.results[0]).toMatchObject({ content: "before" });
  expect(result.results[1]).toMatchObject({ isError: true });
  expect(result.results[1]?.content).toContain("thrown defect");
  expect(result.results[2]).toMatchObject({ isError: true });
  expect(result.results[2]?.content).toContain("explicit defect");
  expect(result.results[3]).toMatchObject({ content: "after" });
});

test("interrupting a tool runs its execution Scope finalizer", async () => {
  const started = await Effect.runPromise(Deferred.make<void>());
  const finalized = await Effect.runPromise(Ref.make(false));
  const tool: Tool<{ readonly value: string }, Scope.Scope> = {
    description: "Waits until interrupted.",
    execute: () =>
      Effect.addFinalizer(() => Ref.set(finalized, true)).pipe(
        Effect.zipRight(Deferred.succeed(started, undefined)),
        Effect.zipRight(Effect.never),
      ),
    name: "wait",
    parameters: Schema.Struct({ value: Schema.String }),
  };
  const observed = await Effect.runPromise(
    Effect.gen(function* () {
      const running = yield* Effect.fork(
        executeToolBatch([{ argumentsJson: '{"value":"wait"}', id: "wait-call", name: "wait" }], {
          sessionId: testSessionId,
        }).pipe(Effect.provide(ToolRegistryLive([defineTool(tool)]))),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(running);
      return yield* Ref.get(finalized);
    }),
  );

  expect(observed).toBe(true);
});

test("each execution Scope finalizer runs exactly once across a multi-call batch", async () => {
  const finalized = await Effect.runPromise(Ref.make(0));
  const tool: Tool<{ readonly value: string }, Scope.Scope> = {
    description: "Finalizes each invocation.",
    execute: (arguments_) =>
      Effect.addFinalizer(() => Ref.update(finalized, (count) => count + 1)).pipe(
        Effect.as({ content: arguments_.value }),
      ),
    name: "finalized",
    parameters: Schema.Struct({ value: Schema.String }),
  };
  const result = await Effect.runPromise(
    executeToolBatch(
      [
        { argumentsJson: '{"value":"one"}', id: "one", name: "finalized" },
        { argumentsJson: '{"value":"two"}', id: "two", name: "finalized" },
        { argumentsJson: '{"value":"three"}', id: "three", name: "finalized" },
      ],
      { sessionId: testSessionId },
    ).pipe(Effect.provide(ToolRegistryLive([defineTool(tool)]))),
  );

  expect(result.results).toHaveLength(3);
  expect(await Effect.runPromise(Ref.get(finalized))).toBe(3);
});

test("tool and batch spans expose correlation, outcomes, mode, and concurrency", async () => {
  const spans: Array<{ readonly attributes: Map<string, unknown>; readonly name: string }> = [];
  const tracer = Tracer.make({
    context: (evaluate) => evaluate(),
    span: (name, parent, context, links, startTime, kind, options) => {
      const captured = {
        attributes: new Map(Object.entries(options?.attributes ?? {})),
        name,
      };
      spans.push(captured);
      return {
        _tag: "Span",
        addLinks: () => undefined,
        attribute: (key, value) => captured.attributes.set(key, value),
        attributes: captured.attributes,
        context,
        end: () => undefined,
        event: () => undefined,
        kind,
        links,
        name,
        parent,
        sampled: true,
        spanId: `${spans.length}`,
        status: { _tag: "Started", startTime },
        traceId: "captured",
      } satisfies Tracer.Span;
    },
  });
  const traceLayer = Layer.merge(Layer.setTracer(tracer), Layer.setTracerEnabled(true));
  const successful: Tool<{ readonly value: string }> = {
    description: "Succeeds.",
    execute: () => Effect.succeed({ content: "success" }),
    name: "successful",
    parameters: Schema.Struct({ value: Schema.String }),
  };
  const failed: Tool<{ readonly value: string }> = {
    description: "Fails sequentially.",
    execute: (_arguments, context) =>
      Effect.fail(
        new ToolError({
          message: "failed",
          toolCallId: "failed-call",
          toolName: context.sessionId,
        }),
      ),
    executionMode: "sequential",
    name: "failed",
    parameters: Schema.Struct({ value: Schema.String }),
  };

  await Effect.runPromise(
    executeToolBatch(
      [
        { argumentsJson: '{"value":"ok"}', id: "success-call", name: "successful" },
        { argumentsJson: '{"value":"bad"}', id: "failed-call", name: "failed" },
        { argumentsJson: "{}", id: "unknown-call", name: "unknown" },
      ],
      { sessionId: testSessionId },
      { concurrency: 3 },
    ).pipe(
      Effect.provide(ToolRegistryLive([defineTool(successful), defineTool(failed)])),
      Effect.provide(traceLayer),
    ),
  );

  const toolSpans = spans.filter((span) => span.name === "kernel.tool");
  expect(toolSpans).toHaveLength(3);
  expect(
    toolSpans.map((span) => ({
      name: span.attributes.get("name"),
      outcome: span.attributes.get("outcome"),
      sessionId: span.attributes.get("sessionId"),
      toolCallId: span.attributes.get("toolCallId"),
    })),
  ).toEqual([
    {
      name: "successful",
      outcome: "success",
      sessionId: testSessionId,
      toolCallId: "success-call",
    },
    {
      name: "failed",
      outcome: "error",
      sessionId: testSessionId,
      toolCallId: "failed-call",
    },
    {
      name: "unknown",
      outcome: "error",
      sessionId: testSessionId,
      toolCallId: "unknown-call",
    },
  ]);
  const batchSpan = spans.find((span) => span.name === "kernel.toolBatch");
  expect(batchSpan?.attributes.get("concurrency")).toBe(1);
  expect(batchSpan?.attributes.get("mode")).toBe("sequential");
});

test("tool concurrency rejects zero and non-integer capacities", () => {
  expect(() => executeToolBatch([], { sessionId: testSessionId }, { concurrency: 0 })).toThrow(
    "Tool concurrency must be a positive safe integer.",
  );
  expect(() => executeToolBatch([], { sessionId: testSessionId }, { concurrency: 1.5 })).toThrow(
    "Tool concurrency must be a positive safe integer.",
  );
});
