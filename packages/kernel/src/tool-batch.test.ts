import type { SessionId } from "@peye/journal";
import { Deferred, Effect, Fiber, Ref, Schema, type Scope } from "effect";
import { expect, test } from "vitest";

import { ToolError } from "./errors.js";
import { type Tool, ToolRegistryLive } from "./tool.js";
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
        ).pipe(Effect.provide(ToolRegistryLive([tool]))),
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
        ).pipe(Effect.provide(ToolRegistryLive([tool]))),
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
      const completed = yield* executeToolBatch(
        [
          { argumentsJson: '{"value":1}', id: "call-1", name: "ordered" },
          { argumentsJson: '{"value":2}', id: "call-2", name: "ordered" },
          { argumentsJson: '{"value":3}', id: "call-3", name: "ordered" },
        ],
        { sessionId: testSessionId },
        { concurrency: 4 },
      ).pipe(Effect.provide(ToolRegistryLive([tool])));
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
    ).pipe(Effect.provide(ToolRegistryLive([failed, succeeded]))),
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
    ).pipe(Effect.provide(ToolRegistryLive([tool]))),
  );

  expect(executed).toBe(false);
  expect(result.results).toEqual([
    {
      content: "Invalid arguments for tool requires-number.",
      isError: true,
      toolCallId: "invalid-call",
    },
  ]);
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
        }).pipe(Effect.provide(ToolRegistryLive([tool]))),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(running);
      return yield* Ref.get(finalized);
    }),
  );

  expect(observed).toBe(true);
});
