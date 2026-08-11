import { SessionIdSchema } from "@peye/journal";
import {
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Schema,
  Scope,
  TestClock,
  TestContext,
  Tracer,
} from "effect";
import { expect, test } from "vitest";

import { createCapabilityGrants } from "./capability.js";
import { defineHookContribution } from "./contribution.js";
import {
  DEFAULT_HOOK_TIMEOUT_MILLIS,
  type HookDiagnostic,
  type HookEmitError,
  HookEmitter,
  HookEmitterLive,
  type HookEmitterOptions,
} from "./emitter.js";
import { type ContributionRegistryError, GateRejected, HookInputInvalid } from "./errors.js";
import {
  CompactionGateHookOutputSchema,
  CompactionGateResultSchema,
  HOOK_POINT_NAMES,
  HOOK_POINTS,
} from "./hook-points.js";
import { ContributionRegistry, ContributionRegistryLive } from "./registry.js";

const grants = (capabilities: ReadonlyArray<string> = []) =>
  createCapabilityGrants(Schema.decodeSync(SessionIdSchema)("hook-emitter-session"), capabilities);

const emitterLayer = (options: HookEmitterOptions = {}) => {
  const registryLayer = ContributionRegistryLive();
  return Layer.merge(registryLayer, HookEmitterLive(options).pipe(Layer.provide(registryLayer)));
};

const manifest = (name: string) => ({ capabilities: [], name, version: "1.0.0" });

const contextInput = (messages: ReadonlyArray<unknown> = []) => ({
  messages,
  tokenBudget: 4_096,
});

const progressInput = (completed: number) => ({
  completed,
  message: `step-${completed}`,
  total: 3,
});

const toolCallInput = () => ({
  arguments: { command: "pwd" },
  toolCallId: "call-1",
  toolName: "shell",
});

const toolResultInput = () => ({
  content: "original",
  isError: false,
  metadata: {},
  toolCallId: "call-1",
  toolName: "shell",
});

type Equal<TLeft, TRight> =
  (<TValue>() => TValue extends TLeft ? 1 : 2) extends <TValue>() => TValue extends TRight ? 1 : 2
    ? true
    : false;

const chainErrorsAreNarrow: Equal<
  HookEmitError<"context">,
  ContributionRegistryError | HookInputInvalid
> = true;
const gateErrorsIncludeRejection: Equal<
  HookEmitError<"tool-call-gate">,
  ContributionRegistryError | GateRejected | HookInputInvalid
> = true;

test("emit error unions narrow from each point's failure policy", () => {
  expect({ chainErrorsAreNarrow, gateErrorsIncludeRejection }).toEqual({
    chainErrorsAreNarrow: true,
    gateErrorsIncludeRejection: true,
  });
});

test("Compaction gate schema is veto-only and has typed compact or skip host results", () => {
  expect(Schema.is(CompactionGateHookOutputSchema)({ action: "compact" })).toBe(true);
  expect(
    Schema.is(CompactionGateHookOutputSchema)({
      action: "skip",
      reason: "Keep the current Context.",
    }),
  ).toBe(true);
  expect(
    Schema.is(CompactionGateHookOutputSchema)({
      decision: "replace",
      value: { action: "skip", reason: "unsupported" },
    }),
  ).toBe(false);
  expect(Schema.is(CompactionGateResultSchema)({ action: "compact" })).toBe(true);
  expect(Schema.is(CompactionGateResultSchema)({ action: "skip", reason: "Plugin vetoed." })).toBe(
    true,
  );
});

interface CapturedSpan {
  readonly attributes: Map<string, unknown>;
  exit: Exit.Exit<unknown, unknown> | undefined;
  readonly name: string;
}

const tracerLayer = (spans: Array<CapturedSpan>): Layer.Layer<never> => {
  const tracer = Tracer.make({
    context: (evaluate) => evaluate(),
    span: (name, parent, context, links, startTime, kind, options) => {
      const captured: CapturedSpan = {
        attributes: new Map(Object.entries(options?.attributes ?? {})),
        exit: undefined,
        name,
      };
      spans.push(captured);
      return {
        _tag: "Span",
        addLinks: () => undefined,
        attribute: (key, value) => captured.attributes.set(key, value),
        attributes: captured.attributes,
        context,
        end: (_endTime, exit) => {
          captured.exit = exit;
        },
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
  return Layer.merge(Layer.setTracer(tracer), Layer.setTracerEnabled(true));
};

test("all twelve typed Hook points execute real contributions through one emitter", async () => {
  const observedTaps: Array<string> = [];
  const tapsDone = Effect.runSync(Deferred.make<void>());
  const tap = (point: string) =>
    Effect.sync(() => {
      observedTaps.push(point);
      if (observedTaps.length === 3) {
        Effect.runSync(Deferred.succeed(tapsDone, undefined));
      }
    });
  const contributions = [
    defineHookContribution({
      mergeClass: "Chain",
      name: "context-real",
      point: "context",
      run: (input: ReturnType<typeof contextInput>) =>
        Effect.succeed({ ...input, messages: [...input.messages, "context"] }),
    }),
    defineHookContribution({
      mergeClass: "Chain",
      name: "provider-real",
      point: "provider-request",
      run: (input: {
        readonly messages: ReadonlyArray<unknown>;
        readonly model: string;
        readonly options: Readonly<Record<string, unknown>>;
      }) => Effect.succeed({ ...input, model: `${input.model}-hook` }),
    }),
    defineHookContribution({
      mergeClass: "Chain",
      name: "transform-real",
      point: "input-transform",
      run: (input: { readonly text: string }) => Effect.succeed({ text: input.text.toUpperCase() }),
    }),
    defineHookContribution({
      mergeClass: "FirstWins",
      name: "handler-real",
      point: "input-handling",
      run: () =>
        Effect.succeed({
          decision: "handled" as const,
          value: { handledBy: "handler-real", response: "handled" },
        }),
    }),
    defineHookContribution({
      mergeClass: "FirstWins",
      name: "tool-gate-real",
      point: "tool-call-gate",
      run: () => Effect.succeed({ decision: "continue" as const }),
    }),
    defineHookContribution({
      mergeClass: "Accumulate",
      name: "result-real",
      point: "tool-result",
      run: () => Effect.succeed({ metadata: { annotated: true } }),
    }),
    defineHookContribution({
      mergeClass: "Accumulate",
      name: "resources-real",
      point: "resource-discovery",
      run: () => Effect.succeed({ resources: ["README.md"] }),
    }),
    defineHookContribution({
      mergeClass: "FirstWins",
      name: "compaction-real",
      point: "compaction-gate",
      run: () => Effect.succeed({ action: "compact" as const }),
    }),
    defineHookContribution({
      mergeClass: "FirstWins",
      name: "trust-real",
      point: "trust",
      run: () => Effect.succeed({ decision: "continue" as const }),
    }),
    defineHookContribution({
      mergeClass: "Tap",
      name: "turn-real",
      point: "turn-lifecycle",
      run: () => tap("turn-lifecycle"),
    }),
    defineHookContribution({
      mergeClass: "Tap",
      name: "progress-real",
      point: "progress",
      run: () => tap("progress"),
    }),
    defineHookContribution({
      mergeClass: "Tap",
      name: "session-real",
      point: "session-lifecycle",
      run: () => tap("session-lifecycle"),
    }),
  ];

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("all-points-plugin"), contributions);
      const outputs = {
        compaction: yield* emitter.emit(
          "compaction-gate",
          { reason: "overflow", tokenCount: 5_000 },
          grants(),
        ),
        context: yield* emitter.emit("context", contextInput(), grants()),
        handling: yield* emitter.emit("input-handling", { text: "hello" }, grants()),
        resources: yield* emitter.emit("resource-discovery", { query: "docs" }, grants()),
        result: yield* emitter.emit("tool-result", toolResultInput(), grants()),
        toolGate: yield* emitter.emit("tool-call-gate", toolCallInput(), grants()),
        transform: yield* emitter.emit("input-transform", { text: "hello" }, grants()),
        trust: yield* emitter.emit(
          "trust",
          {
            currentDigest: "digest",
            kind: "prompt_required",
            projectPath: "/tmp/project",
          },
          grants(),
        ),
        provider: yield* emitter.emit(
          "provider-request",
          { messages: [], model: "test", options: {} },
          grants(),
        ),
      };
      yield* emitter.emit(
        "turn-lifecycle",
        { phase: "assembling", sessionId: "session-1" },
        grants(),
      );
      yield* emitter.emit("progress", progressInput(1), grants());
      yield* emitter.emit(
        "session-lifecycle",
        { event: "created", sessionId: "session-1" },
        grants(),
      );
      yield* Deferred.await(tapsDone);
      return outputs;
    }).pipe(Effect.provide(emitterLayer())),
  );

  expect(HOOK_POINT_NAMES).toEqual(Object.keys(HOOK_POINTS));
  expect(result).toMatchObject({
    compaction: undefined,
    context: { messages: ["context"], tokenBudget: 4_096 },
    handling: { handledBy: "handler-real", response: "handled" },
    provider: { model: "test-hook" },
    resources: { query: "docs", resources: ["README.md"] },
    result: { metadata: { annotated: true }, toolName: "shell" },
    toolGate: undefined,
    transform: { text: "HELLO" },
    trust: undefined,
  });
  expect(observedTaps.sort()).toEqual(["progress", "session-lifecycle", "turn-lifecycle"]);
});

test("Chain composes in priority order and passes the previous decoded output", async () => {
  const seen: Array<ReadonlyArray<unknown>> = [];
  const contribution = (name: string, marker: string, priority: number) =>
    defineHookContribution(
      {
        mergeClass: "Chain",
        name,
        point: "context",
        run: (input: ReturnType<typeof contextInput>) =>
          Effect.sync(() => {
            seen.push(input.messages);
            return { ...input, messages: [...input.messages, marker] };
          }),
      },
      priority,
    );
  const output = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("low-plugin"), [
        contribution("context-low", "low", 10),
      ]);
      yield* registry.registerPlugin(manifest("high-plugin"), [
        contribution("context-high", "high", 20),
      ]);
      return yield* emitter.emit("context", contextInput(), grants());
    }).pipe(Effect.provide(emitterLayer())),
  );

  expect(output.messages).toEqual(["high", "low"]);
  expect(seen).toEqual([[], ["high"]]);
});

test("input handling uses explicit continue and handled decisions", async () => {
  const ran: Array<string> = [];
  const output = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("input-plugin"), [
        defineHookContribution(
          {
            mergeClass: "FirstWins",
            name: "decline",
            point: "input-handling",
            run: () =>
              Effect.sync(() => {
                ran.push("continue");
                return { decision: "continue" as const };
              }),
          },
          30,
        ),
        defineHookContribution(
          {
            mergeClass: "FirstWins",
            name: "handle",
            point: "input-handling",
            run: () =>
              Effect.sync(() => {
                ran.push("handled");
                return { decision: "handled" as const, value: { handledBy: "winner" } };
              }),
          },
          20,
        ),
        defineHookContribution(
          {
            mergeClass: "FirstWins",
            name: "too-late",
            point: "input-handling",
            run: () =>
              Effect.sync(() => {
                ran.push("too-late");
                return { decision: "handled" as const, value: { handledBy: "loser" } };
              }),
          },
          10,
        ),
      ]);
      return yield* emitter.emit("input-handling", { text: "hello" }, grants());
    }).pipe(Effect.provide(emitterLayer())),
  );

  expect(output).toEqual({ handledBy: "winner" });
  expect(ran).toEqual(["continue", "handled"]);
});

test("gate decisions continue, block, and replace", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("continue-gate"), [
        defineHookContribution({
          mergeClass: "FirstWins",
          name: "continue",
          point: "tool-call-gate",
          run: () => Effect.succeed({ decision: "continue" as const }),
        }),
      ]);
      const continued = yield* emitter.emit("tool-call-gate", toolCallInput(), grants());
      yield* registry.removePlugin("continue-gate");
      yield* registry.registerPlugin(manifest("replace-gate"), [
        defineHookContribution({
          mergeClass: "FirstWins",
          name: "replace",
          point: "tool-call-gate",
          run: () =>
            Effect.succeed({
              decision: "replace" as const,
              value: { ...toolCallInput(), toolName: "safe-shell" },
            }),
        }),
      ]);
      const replaced = yield* emitter.emit("tool-call-gate", toolCallInput(), grants());
      yield* registry.removePlugin("replace-gate");
      yield* registry.registerPlugin(manifest("block-gate"), [
        defineHookContribution({
          mergeClass: "FirstWins",
          name: "block",
          point: "tool-call-gate",
          run: () => Effect.succeed({ decision: "block" as const, reason: "not allowed" }),
        }),
      ]);
      const blocked = yield* Effect.flip(emitter.emit("tool-call-gate", toolCallInput(), grants()));
      return { blocked, continued, replaced };
    }).pipe(Effect.provide(emitterLayer())),
  );

  expect(result.continued).toBeUndefined();
  expect(result.replaced).toMatchObject({ toolName: "safe-shell" });
  expect(result.blocked).toMatchObject({
    cause: "block(not allowed)",
    plugin: "block-gate",
    point: "tool-call-gate",
    rejection: "block",
    reason: "not allowed",
  });
});

test("Accumulate keeps the highest-priority field and diagnoses lower conflicts", async () => {
  const diagnostics: Array<HookDiagnostic> = [];
  const output = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("low-result"), [
        defineHookContribution(
          {
            mergeClass: "Accumulate",
            name: "low",
            point: "tool-result",
            run: () => Effect.succeed({ content: "low", isError: true }),
          },
          10,
        ),
      ]);
      yield* registry.registerPlugin(manifest("high-result"), [
        defineHookContribution(
          {
            mergeClass: "Accumulate",
            name: "high",
            point: "tool-result",
            run: () => Effect.succeed({ content: "high" }),
          },
          20,
        ),
      ]);
      return yield* emitter.emit("tool-result", toolResultInput(), grants());
    }).pipe(
      Effect.provide(
        emitterLayer({
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
        }),
      ),
    ),
  );

  expect(output).toMatchObject({ content: "high", isError: true });
  expect(diagnostics).toContainEqual({
    field: "content",
    point: "tool-result",
    selectedPlugin: "high-result",
    skippedPlugin: "low-result",
    type: "hook_field_conflict",
  });
  expect(HOOK_POINTS["tool-result"].conflictPolicy).toBe("highest-priority-wins");
});

test("throwing and dying Chain and Accumulate contributions skip with diagnostics", async () => {
  const diagnostics: Array<HookDiagnostic> = [];
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("defective-plugin"), [
        defineHookContribution({
          mergeClass: "Chain",
          name: "chain-throw",
          point: "context",
          run: () =>
            Effect.sync(() => {
              throw new Error("chain throw");
            }),
        }),
        defineHookContribution({
          mergeClass: "Chain",
          name: "chain-die",
          point: "context",
          run: () => Effect.die("chain die"),
        }),
        defineHookContribution({
          mergeClass: "Accumulate",
          name: "accumulate-throw",
          point: "tool-result",
          run: () =>
            Effect.sync(() => {
              throw new Error("accumulate throw");
            }),
        }),
        defineHookContribution({
          mergeClass: "Accumulate",
          name: "accumulate-die",
          point: "tool-result",
          run: () => Effect.die("accumulate die"),
        }),
      ]);
      return {
        context: yield* emitter.emit("context", contextInput(), grants()),
        toolResult: yield* emitter.emit("tool-result", toolResultInput(), grants()),
      };
    }).pipe(
      Effect.provide(
        emitterLayer({
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
        }),
      ),
    ),
  );

  expect(result.context).toEqual(contextInput());
  expect(result.toolResult).toEqual(toolResultInput());
  expect(
    diagnostics.filter((diagnostic) => diagnostic.type === "hook_contribution_skipped"),
  ).toHaveLength(4);
  expect(diagnostics.map((diagnostic) => ("cause" in diagnostic ? diagnostic.cause : ""))).toEqual(
    expect.arrayContaining([
      expect.stringContaining("chain throw"),
      expect.stringContaining("chain die"),
      expect.stringContaining("accumulate throw"),
      expect.stringContaining("accumulate die"),
    ]),
  );
});

test("throwing and dying gate contributions fail closed with bounded causes", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("throwing-gate"), [
        defineHookContribution({
          mergeClass: "FirstWins",
          name: "throw",
          point: "tool-call-gate",
          run: () =>
            Effect.sync(() => {
              throw new Error("gate throw");
            }),
        }),
      ]);
      yield* registry.registerPlugin(manifest("dying-gate"), [
        defineHookContribution({
          mergeClass: "FirstWins",
          name: "die",
          point: "compaction-gate",
          run: () => Effect.die("gate die"),
        }),
      ]);
      return {
        died: yield* Effect.flip(
          emitter.emit("compaction-gate", { reason: "overflow", tokenCount: 5_000 }, grants()),
        ),
        threw: yield* Effect.flip(emitter.emit("tool-call-gate", toolCallInput(), grants())),
      };
    }).pipe(Effect.provide(emitterLayer())),
  );

  expect(result.threw).toBeInstanceOf(GateRejected);
  expect(result.died).toBeInstanceOf(GateRejected);
  if (!(result.threw instanceof GateRejected) || !(result.died instanceof GateRejected)) {
    throw new Error("Expected both defects to become GateRejected values.");
  }
  expect(result.threw.cause).toContain("gate throw");
  expect(result.died.cause).toContain("gate die");
  expect(result.threw.rejection).toBe("failure");
  expect(result.died.rejection).toBe("failure");
  expect(result.threw.cause.length).toBeLessThanOrEqual(1_024);
});

test("Tap workers log and drop throws and dies, then keep consuming", async () => {
  const diagnostics: Array<HookDiagnostic> = [];
  const logs: Array<string> = [];
  const recovered = Effect.runSync(Deferred.make<void>());
  let dieRuns = 0;
  let throwRuns = 0;
  const logger = Logger.make<unknown, void>(({ message }) => logs.push(String(message)));

  await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("defective-taps"), [
        defineHookContribution({
          mergeClass: "Tap",
          name: "throwing-tap",
          point: "progress",
          run: () =>
            Effect.sync(() => {
              throwRuns += 1;
              if (throwRuns === 1) throw new Error("tap throw");
            }),
        }),
        defineHookContribution({
          mergeClass: "Tap",
          name: "dying-tap",
          point: "progress",
          run: () =>
            Effect.suspend(() => {
              dieRuns += 1;
              if (dieRuns === 1) return Effect.die("tap die");
              return Deferred.succeed(recovered, undefined);
            }),
        }),
      ]);
      yield* emitter.emit("progress", progressInput(1), grants());
      yield* Effect.yieldNow();
      yield* Effect.yieldNow();
      yield* emitter.emit("progress", progressInput(2), grants());
      yield* Deferred.await(recovered);
    }).pipe(
      Effect.provide(
        emitterLayer({
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
        }),
      ),
      Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
    ),
  );

  expect({ dieRuns, throwRuns }).toEqual({ dieRuns: 2, throwRuns: 2 });
  expect(diagnostics.filter((diagnostic) => diagnostic.type === "hook_tap_failed")).toHaveLength(2);
  expect(logs.filter((message) => message.includes("hook_tap_failed"))).toHaveLength(2);
});

class DetailedFailure extends Data.TaggedError("DetailedFailure")<{
  readonly code: number;
  readonly resource: string;
}> {}

test("TaggedError reasons and diagnostics retain the tag and payload", async () => {
  const diagnostics: Array<HookDiagnostic> = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("tagged-plugin"), [
        defineHookContribution({
          mergeClass: "Chain",
          name: "tagged",
          point: "context",
          run: () => Effect.fail(new DetailedFailure({ code: 503, resource: "context" })),
        }),
      ]);
      yield* emitter.emit("context", contextInput(), grants());
    }).pipe(
      Effect.provide(
        emitterLayer({
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
        }),
      ),
    ),
  );

  expect(diagnostics).toContainEqual(
    expect.objectContaining({
      errorPayload: { code: 503, resource: "context" },
      errorTag: "DetailedFailure",
      reason: 'DetailedFailure: {"code":503,"resource":"context"}',
    }),
  );
});

test("invalid input fails typed and invalid contribution outputs follow class policy", async () => {
  const diagnostics: Array<HookDiagnostic> = [];
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("corrupt-output"), [
        defineHookContribution({
          mergeClass: "Chain",
          name: "bad-chain",
          point: "input-transform",
          run: () => Effect.succeed({ text: 42 }),
        }),
        defineHookContribution({
          mergeClass: "Accumulate",
          name: "bad-accumulate",
          point: "tool-result",
          run: () => Effect.succeed("scalar"),
        }),
      ]);
      return {
        accumulated: yield* emitter.emit("tool-result", toolResultInput(), grants()),
        chained: yield* emitter.emit("input-transform", { text: "valid" }, grants()),
        invalidInput: yield* Effect.flip(
          emitter.emit("input-transform", { text: 42 } as never, grants()),
        ),
      };
    }).pipe(
      Effect.provide(
        emitterLayer({
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
        }),
      ),
    ),
  );

  expect(result.accumulated).toEqual(toolResultInput());
  expect(result.chained).toEqual({ text: "valid" });
  expect(result.invalidInput).toBeInstanceOf(HookInputInvalid);
  expect(
    diagnostics.filter((diagnostic) => diagnostic.type === "hook_contribution_skipped"),
  ).toHaveLength(2);
});

test("the declared 30-second timeout fires exactly at the boundary for gates", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("slow-gate"), [
        defineHookContribution({
          mergeClass: "FirstWins",
          name: "slow",
          point: "tool-call-gate",
          run: () => Effect.never,
        }),
      ]);
      const fiber = yield* Effect.fork(
        Effect.flip(emitter.emit("tool-call-gate", toolCallInput(), grants())),
      );
      yield* TestClock.adjust("29999 millis");
      const before = yield* Fiber.poll(fiber);
      yield* TestClock.adjust("1 millis");
      const after = yield* Fiber.join(fiber);
      return { after, before };
    }).pipe(Effect.provide(emitterLayer()), Effect.provide(TestContext.TestContext)),
  );

  expect(DEFAULT_HOOK_TIMEOUT_MILLIS).toBe(30_000);
  expect(Option.isNone(result.before)).toBe(true);
  expect(result.after).toMatchObject({
    cause: "Hook timed out after 30000 ms.",
    reason: "Hook timed out after 30000 ms.",
    timedOut: true,
  });
});

test("non-gate timeout skips with a unit-bearing diagnostic instead of hanging", async () => {
  const diagnostics: Array<HookDiagnostic> = [];
  const output = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("slow-chain"), [
        defineHookContribution({
          mergeClass: "Chain",
          name: "slow",
          point: "context",
          run: () => Effect.never,
        }),
      ]);
      const fiber = yield* Effect.fork(emitter.emit("context", contextInput(), grants()));
      yield* TestClock.adjust("30 seconds");
      return yield* Fiber.join(fiber);
    }).pipe(
      Effect.provide(
        emitterLayer({
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
        }),
      ),
      Effect.provide(TestContext.TestContext),
    ),
  );

  expect(output).toEqual(contextInput());
  expect(diagnostics).toContainEqual(
    expect.objectContaining({
      reason: "Hook timed out after 30000 ms.",
      timedOut: true,
      type: "hook_contribution_skipped",
    }),
  );
});

test("Tap replacement uses registration identity and executes the fresh implementation", async () => {
  const seen: Array<number> = [];
  const firstDone = Effect.runSync(Deferred.make<void>());
  const secondDone = Effect.runSync(Deferred.make<void>());
  await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("replace-tap"), [
        defineHookContribution({
          mergeClass: "Tap",
          name: "observer",
          point: "progress",
          run: () =>
            Effect.sync(() => seen.push(1)).pipe(
              Effect.zipRight(Deferred.succeed(firstDone, undefined)),
            ),
        }),
      ]);
      yield* emitter.emit("progress", progressInput(1), grants());
      yield* Deferred.await(firstDone);
      yield* registry.registerPlugin(manifest("replace-tap"), [
        defineHookContribution({
          mergeClass: "Tap",
          name: "observer",
          point: "progress",
          run: () =>
            Effect.sync(() => seen.push(2)).pipe(
              Effect.zipRight(Deferred.succeed(secondDone, undefined)),
            ),
        }),
      ]);
      yield* emitter.emit("progress", progressInput(2), grants());
      yield* Deferred.await(secondDone);
    }).pipe(Effect.provide(emitterLayer())),
  );

  expect(seen).toEqual([1, 2]);
});

test("removal sweeps and interrupts orphaned Tap workers on the next emit", async () => {
  const counts = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("removable-tap"), [
        defineHookContribution({
          mergeClass: "Tap",
          name: "observer",
          point: "progress",
          run: () => Effect.void,
        }),
      ]);
      yield* emitter.emit("progress", progressInput(1), grants());
      const before = yield* emitter.activeTapWorkerCount;
      yield* registry.removePlugin("removable-tap");
      yield* emitter.emit("progress", progressInput(2), grants());
      const after = yield* emitter.activeTapWorkerCount;
      return { after, before };
    }).pipe(Effect.provide(emitterLayer())),
  );

  expect(counts).toEqual({ after: 0, before: 1 });
});

test("a session without a required capability does not prune a registered Tap worker", async () => {
  const counts = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(
        {
          capabilities: [{ name: "network", required: true }],
          name: "capability-tap",
          version: "1.0.0",
        },
        [
          defineHookContribution({
            mergeClass: "Tap",
            name: "observer",
            point: "progress",
            run: () => Effect.void,
          }),
        ],
      );
      yield* emitter.emit("progress", progressInput(1), grants(["network"]));
      const before = yield* emitter.activeTapWorkerCount;
      yield* emitter.emit("progress", progressInput(2), grants());
      const after = yield* emitter.activeTapWorkerCount;
      return { after, before };
    }).pipe(Effect.provide(emitterLayer())),
  );

  expect(counts).toEqual({ after: 1, before: 1 });
});

test("explicit eviction counts only an item actually removed under a forced interleaving", async () => {
  const diagnostics: Array<HookDiagnostic> = [];
  const evictionEntered = Effect.runSync(Deferred.make<void>());
  const resumeEviction = Effect.runSync(Deferred.make<void>());
  const releaseFirst = Effect.runSync(Deferred.make<void>());
  const secondStarted = Effect.runSync(Deferred.make<void>());
  const thirdDone = Effect.runSync(Deferred.make<void>());
  const seen: Array<number> = [];

  await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("race-tap"), [
        defineHookContribution({
          mergeClass: "Tap",
          name: "observer",
          point: "progress",
          run: (input: ReturnType<typeof progressInput>) =>
            Effect.gen(function* () {
              seen.push(input.completed);
              if (input.completed === 1) yield* Deferred.await(releaseFirst);
              if (input.completed === 2) yield* Deferred.succeed(secondStarted, undefined);
              if (input.completed === 3) yield* Deferred.succeed(thirdDone, undefined);
            }),
        }),
      ]);
      yield* emitter.emit("progress", progressInput(1), grants());
      yield* Effect.yieldNow();
      yield* emitter.emit("progress", progressInput(2), grants());
      const thirdEmit = yield* Effect.fork(emitter.emit("progress", progressInput(3), grants()));
      yield* Deferred.await(evictionEntered);
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Deferred.await(secondStarted);
      yield* Deferred.succeed(resumeEviction, undefined);
      yield* Fiber.join(thirdEmit);
      yield* Deferred.await(thirdDone);
    }).pipe(
      Effect.provide(
        emitterLayer({
          beforeTapEviction: Deferred.succeed(evictionEntered, undefined).pipe(
            Effect.zipRight(Deferred.await(resumeEviction)),
          ),
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
          tapQueueCapacity: 1,
        }),
      ),
    ),
  );

  expect(seen).toEqual([1, 2, 3]);
  expect(diagnostics.filter((diagnostic) => diagnostic.type === "hook_tap_dropped")).toEqual([]);
});

test("a full Tap queue evicts exactly one oldest item and reports one drop", async () => {
  const diagnostics: Array<HookDiagnostic> = [];
  const firstStarted = Effect.runSync(Deferred.make<void>());
  const releaseFirst = Effect.runSync(Deferred.make<void>());
  const finished = Effect.runSync(Deferred.make<void>());
  const seen: Array<number> = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("queue-tap"), [
        defineHookContribution({
          mergeClass: "Tap",
          name: "observer",
          point: "progress",
          run: (input: ReturnType<typeof progressInput>) =>
            Effect.gen(function* () {
              seen.push(input.completed);
              if (input.completed === 1) {
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(releaseFirst);
              }
              if (input.completed === 3) yield* Deferred.succeed(finished, undefined);
            }),
        }),
      ]);
      yield* emitter.emit("progress", progressInput(1), grants());
      yield* Deferred.await(firstStarted);
      yield* emitter.emit("progress", progressInput(2), grants());
      yield* emitter.emit("progress", progressInput(3), grants());
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Deferred.await(finished);
    }).pipe(
      Effect.provide(
        emitterLayer({
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
          tapQueueCapacity: 1,
        }),
      ),
    ),
  );

  expect(seen).toEqual([1, 3]);
  expect(diagnostics).toContainEqual({
    droppedCount: 1,
    plugin: "queue-tap",
    point: "progress",
    type: "hook_tap_dropped",
  });
});

test("cross-plugin priority ties use codepoint order and emit a tie diagnostic", async () => {
  const diagnostics: Array<HookDiagnostic> = [];
  const contribution = (marker: string) =>
    defineHookContribution(
      {
        mergeClass: "Chain",
        name: "context",
        point: "context",
        run: (input: ReturnType<typeof contextInput>) =>
          Effect.succeed({ ...input, messages: [...input.messages, marker] }),
      },
      10,
    );
  const output = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("zeta-plugin"), [contribution("zeta")]);
      yield* registry.registerPlugin(manifest("alpha-plugin"), [contribution("alpha")]);
      return yield* emitter.emit("context", contextInput(), grants());
    }).pipe(
      Effect.provide(
        emitterLayer({
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
        }),
      ),
    ),
  );

  expect(output.messages).toEqual(["alpha", "zeta"]);
  expect(diagnostics).toContainEqual({
    orderedPlugins: ["alpha-plugin", "zeta-plugin"],
    point: "context",
    priority: 10,
    type: "hook_priority_tie",
  });
});

test("HOOK_POINTS is deeply frozen so mutation cannot disarm a gate", () => {
  expect(Object.isFrozen(HOOK_POINTS)).toBe(true);
  expect(Object.isFrozen(HOOK_POINTS["tool-call-gate"])).toBe(true);
  expect(() => {
    (HOOK_POINTS["tool-call-gate"] as { failurePolicy: string }).failurePolicy = "skip";
  }).toThrow();
  expect(HOOK_POINTS["tool-call-gate"].failurePolicy).toBe("reject");
});

test("Hook spans report caller interruption as interrupted", async () => {
  const spans: Array<CapturedSpan> = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("interrupt-plugin"), [
        defineHookContribution({
          mergeClass: "Chain",
          name: "never",
          point: "context",
          run: () => Effect.never,
        }),
      ]);
      const fiber = yield* Effect.fork(emitter.emit("context", contextInput(), grants()));
      yield* Effect.yieldNow();
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(emitterLayer()), Effect.provide(tracerLayer(spans))),
  );

  expect(
    spans
      .filter((span) => span.name === "plugins.hook")
      .map((span) => span.attributes.get("outcome")),
  ).toContain("interrupted");
});

test("Tap fibers are interrupted when the emitter layer Scope closes", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const finalized = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const scope = yield* Scope.make();
      const services = yield* Layer.build(emitterLayer()).pipe(Scope.extend(scope));
      const emitter = Context.get(services, HookEmitter);
      const registry = Context.get(services, ContributionRegistry);
      yield* registry.registerPlugin(manifest("scoped-tap"), [
        defineHookContribution({
          mergeClass: "Tap",
          name: "observer",
          point: "turn-lifecycle",
          run: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.zipRight(Effect.never),
              Effect.ensuring(Deferred.succeed(finalized, undefined)),
            ),
        }),
      ]);
      yield* emitter.emit(
        "turn-lifecycle",
        { phase: "assembling", sessionId: "session-1" },
        grants(),
      );
      yield* Deferred.await(started);
      yield* Scope.close(scope, Exit.void);
      return yield* Deferred.poll(finalized);
    }),
  );

  expect(Option.isSome(result)).toBe(true);
});
