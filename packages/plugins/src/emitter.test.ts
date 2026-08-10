import { SessionIdSchema } from "@peye/journal";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberId,
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
  DEFAULT_GATE_TIMEOUT_MILLIS,
  type HookDiagnostic,
  HookEmitter,
  HookEmitterLive,
  type HookEmitterOptions,
} from "./emitter.js";
import { GateRejected } from "./errors.js";
import { HOOK_POINT_NAMES, type HookPointName } from "./hook-points.js";
import { ContributionRegistry, ContributionRegistryLive } from "./registry.js";

const grants = (capabilities: ReadonlyArray<string> = []) =>
  createCapabilityGrants(Schema.decodeSync(SessionIdSchema)("hook-emitter-session"), capabilities);

const emitterLayer = (options: HookEmitterOptions = {}) => {
  const registryLayer = ContributionRegistryLive();
  return Layer.merge(registryLayer, HookEmitterLive(options).pipe(Layer.provide(registryLayer)));
};

const manifest = (name: string) => ({
  capabilities: [],
  name,
  version: "1.0.0",
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

test("all twelve hook points execute through one generic emitter driven by declared semantics", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      return yield* Effect.forEach(HOOK_POINT_NAMES, (point: HookPointName) =>
        emitter
          .emit(point, { marker: point }, grants())
          .pipe(Effect.map((output) => ({ output, point }))),
      );
    }).pipe(Effect.provide(emitterLayer())),
  );

  expect(result.map(({ point }) => point)).toEqual([
    "context",
    "provider-request",
    "input-transform",
    "input-handling",
    "tool-call-gate",
    "tool-result",
    "resource-discovery",
    "compaction-gate",
    "trust",
    "turn-lifecycle",
    "progress",
    "session-lifecycle",
  ]);
  expect(result.map(({ output }) => output)).toEqual([
    { marker: "context" },
    { marker: "provider-request" },
    { marker: "input-transform" },
    undefined,
    undefined,
    { marker: "tool-result" },
    { marker: "resource-discovery" },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

test("Chain composes contributions in priority order and passes the previous output", async () => {
  const seen: Array<ReadonlyArray<string>> = [];
  const lowPriority = defineHookContribution(
    {
      mergeClass: "Chain",
      name: "context-low",
      point: "context",
      run: (input: { readonly order: ReadonlyArray<string> }) =>
        Effect.sync(() => {
          seen.push(input.order);
          return { order: [...input.order, "low"] };
        }),
    },
    10,
  );
  const highPriority = defineHookContribution(
    {
      mergeClass: "Chain",
      name: "context-high",
      point: "context",
      run: (input: { readonly order: ReadonlyArray<string> }) =>
        Effect.sync(() => {
          seen.push(input.order);
          return { order: [...input.order, "high"] };
        }),
    },
    20,
  );

  const output = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("low-plugin"), [lowPriority]);
      yield* registry.registerPlugin(manifest("high-plugin"), [highPriority]);
      return yield* emitter.emit("context", { order: [] }, grants());
    }).pipe(Effect.provide(emitterLayer())),
  );

  expect(output).toEqual({ order: ["high", "low"] });
  expect(seen).toEqual([[], ["high"]]);
});

test("FirstWins stops at the first decisive result", async () => {
  const ran: Array<string> = [];
  const contributions = [
    defineHookContribution(
      {
        mergeClass: "FirstWins",
        name: "input-decline",
        point: "input-handling",
        run: () =>
          Effect.sync(() => {
            ran.push("decline");
            return undefined;
          }),
      },
      30,
    ),
    defineHookContribution(
      {
        mergeClass: "FirstWins",
        name: "input-handle",
        point: "input-handling",
        run: () =>
          Effect.sync(() => {
            ran.push("handle");
            return { handledBy: "winner" };
          }),
      },
      20,
    ),
    defineHookContribution(
      {
        mergeClass: "FirstWins",
        name: "input-too-late",
        point: "input-handling",
        run: () =>
          Effect.sync(() => {
            ran.push("too-late");
            return { handledBy: "loser" };
          }),
      },
      10,
    ),
  ];

  const output = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("input-plugin"), contributions);
      return yield* emitter.emit("input-handling", { text: "hello" }, grants());
    }).pipe(Effect.provide(emitterLayer())),
  );

  expect(output).toEqual({ handledBy: "winner" });
  expect(ran).toEqual(["decline", "handle"]);
});

test("Accumulate merges contribution outputs field-wise", async () => {
  const contributions = [
    defineHookContribution(
      {
        mergeClass: "Accumulate",
        name: "tool-result-low",
        point: "tool-result",
        run: () => Effect.succeed({ low: true, shared: "low" }),
      },
      10,
    ),
    defineHookContribution(
      {
        mergeClass: "Accumulate",
        name: "tool-result-high",
        point: "tool-result",
        run: () => Effect.succeed({ high: true, shared: "high" }),
      },
      20,
    ),
  ];

  const output = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("result-plugin"), contributions);
      return yield* emitter.emit("tool-result", { original: true, shared: "original" }, grants());
    }).pipe(Effect.provide(emitterLayer())),
  );

  expect(output).toEqual({ high: true, low: true, original: true, shared: "low" });
});

test("Tap contributions run on their own fibers", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const observedFiber = yield* Deferred.make<string>();
      const contribution = defineHookContribution({
        mergeClass: "Tap",
        name: "turn-observer",
        point: "turn-lifecycle",
        run: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(observedFiber, FiberId.threadName(yield* Effect.fiberId));
          }),
      });
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("observer-plugin"), [contribution]);
      const emitFiber = FiberId.threadName(yield* Effect.fiberId);
      yield* emitter.emit("turn-lifecycle", { phase: "started" }, grants());
      yield* Effect.yieldNow();
      const observed = yield* Deferred.poll(observedFiber);
      return {
        emitFiber,
        observedFiber: Option.isSome(observed) ? yield* observed.value : undefined,
      };
    }).pipe(Effect.provide(emitterLayer())),
  );

  expect(result.observedFiber).toEqual(expect.any(String));
  expect(result.observedFiber).not.toBe(result.emitFiber);
});

test("gate contribution failure rejects and names the plugin", async () => {
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("guard-plugin"), [
        defineHookContribution({
          mergeClass: "FirstWins",
          name: "tool-guard",
          point: "tool-call-gate",
          run: () => Effect.fail("guard unavailable"),
        }),
      ]);
      return yield* Effect.flip(emitter.emit("tool-call-gate", { tool: "shell" }, grants()));
    }).pipe(Effect.provide(emitterLayer())),
  );

  expect(error).toBeInstanceOf(GateRejected);
  expect(error).toMatchObject({
    plugin: "guard-plugin",
    point: "tool-call-gate",
    reason: "guard unavailable",
    timedOut: false,
  });
});

test("gate timeout defaults to 30 seconds and rejects", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("slow-guard-plugin"), [
        defineHookContribution({
          mergeClass: "FirstWins",
          name: "slow-tool-guard",
          point: "tool-call-gate",
          run: () => Effect.never,
        }),
      ]);
      const fiber = yield* Effect.fork(
        Effect.flip(emitter.emit("tool-call-gate", { tool: "shell" }, grants())),
      );
      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow();
      const polled = yield* Fiber.poll(fiber);
      return Option.isSome(polled) ? polled.value : undefined;
    }).pipe(
      Effect.provide(emitterLayer({ gateTimeout: "1 second" })),
      Effect.provide(TestContext.TestContext),
    ),
  );

  expect(DEFAULT_GATE_TIMEOUT_MILLIS).toBe(30_000);
  expect(result).toMatchObject({
    _tag: "Success",
    value: {
      plugin: "slow-guard-plugin",
      point: "tool-call-gate",
      timedOut: true,
    },
  });
});

test("gate timeout emits a plugin-named structured diagnostic", async () => {
  const diagnostics: Array<HookDiagnostic> = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("diagnosed-guard-plugin"), [
        defineHookContribution({
          mergeClass: "FirstWins",
          name: "diagnosed-tool-guard",
          point: "tool-call-gate",
          run: () => Effect.never,
        }),
      ]);
      const fiber = yield* Effect.fork(
        Effect.exit(emitter.emit("tool-call-gate", { tool: "shell" }, grants())),
      );
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
    }).pipe(
      Effect.provide(
        emitterLayer({
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
          gateTimeout: "1 second",
        }),
      ),
      Effect.provide(TestContext.TestContext),
    ),
  );

  expect(diagnostics).toEqual([
    {
      plugin: "diagnosed-guard-plugin",
      point: "tool-call-gate",
      reason: "Hook gate timed out after 1 second.",
      timedOut: true,
      type: "hook_gate_rejected",
    },
  ]);
});

test("Chain and Accumulate failures skip contributions with diagnostics", async () => {
  const diagnostics: Array<HookDiagnostic> = [];
  const layer = emitterLayer({
    diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("broken-plugin"), [
        defineHookContribution(
          {
            mergeClass: "Chain",
            name: "broken-context",
            point: "context",
            run: () => Effect.fail("context broke"),
          },
          20,
        ),
        defineHookContribution(
          {
            mergeClass: "Accumulate",
            name: "broken-result",
            point: "tool-result",
            run: () => Effect.fail("result broke"),
          },
          20,
        ),
      ]);
      yield* registry.registerPlugin(manifest("healthy-plugin"), [
        defineHookContribution(
          {
            mergeClass: "Chain",
            name: "healthy-context",
            point: "context",
            run: (input: { readonly value: string }) =>
              Effect.succeed({ value: `${input.value}-healthy` }),
          },
          10,
        ),
        defineHookContribution(
          {
            mergeClass: "Accumulate",
            name: "healthy-result",
            point: "tool-result",
            run: () => Effect.succeed({ healthy: true }),
          },
          10,
        ),
      ]);
      return {
        accumulated: yield* emitter.emit("tool-result", { original: true }, grants()),
        chained: yield* emitter.emit("context", { value: "original" }, grants()),
      };
    }).pipe(Effect.provide(layer)),
  );

  expect(result).toEqual({
    accumulated: { healthy: true, original: true },
    chained: { value: "original-healthy" },
  });
  expect(diagnostics).toEqual([
    {
      mergeClass: "Accumulate",
      plugin: "broken-plugin",
      point: "tool-result",
      reason: "result broke",
      type: "hook_contribution_skipped",
    },
    {
      mergeClass: "Chain",
      plugin: "broken-plugin",
      point: "context",
      reason: "context broke",
      type: "hook_contribution_skipped",
    },
  ]);
});

test("Tap failures are logged and dropped", async () => {
  const diagnostics: Array<HookDiagnostic> = [];
  const logs: Array<{ readonly level: string; readonly message: string }> = [];
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    logs.push({ level: logLevel.label, message: String(message) });
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("broken-observer-plugin"), [
        defineHookContribution({
          mergeClass: "Tap",
          name: "broken-progress-observer",
          point: "progress",
          run: () => Effect.fail("observer broke"),
        }),
      ]);
      yield* emitter.emit("progress", { detail: "working" }, grants());
      yield* Effect.yieldNow();
      yield* Effect.yieldNow();
    }).pipe(
      Effect.provide(
        emitterLayer({
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
        }),
      ),
      Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
    ),
  );

  expect(diagnostics).toEqual([
    {
      plugin: "broken-observer-plugin",
      point: "progress",
      reason: "observer broke",
      type: "hook_tap_failed",
    },
  ]);
  expect(logs).toEqual([
    expect.objectContaining({
      level: "WARN",
      message: expect.stringContaining("hook_tap_failed"),
    }),
  ]);
});

test("Tap queues are bounded sliding and report cumulative drop counts", async () => {
  const diagnostics: Array<HookDiagnostic> = [];
  const seen: Array<number> = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("queue-observer-plugin"), [
        defineHookContribution({
          mergeClass: "Tap",
          name: "queued-progress-observer",
          point: "progress",
          run: (input: { readonly sequence: number }) =>
            Effect.gen(function* () {
              seen.push(input.sequence);
              if (input.sequence === 1) {
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(releaseFirst);
              }
              if (input.sequence === 4) {
                yield* Deferred.succeed(finished, undefined);
              }
            }),
        }),
      ]);
      yield* emitter.emit("progress", { sequence: 1 }, grants());
      yield* Deferred.await(firstStarted);
      yield* emitter.emit("progress", { sequence: 2 }, grants());
      yield* emitter.emit("progress", { sequence: 3 }, grants());
      yield* emitter.emit("progress", { sequence: 4 }, grants());
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Deferred.await(finished);
    }).pipe(
      Effect.provide(
        emitterLayer({
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
          tapQueueCapacity: 2,
        }),
      ),
    ),
  );

  expect(seen).toEqual([1, 3, 4]);
  expect(diagnostics).toEqual([
    {
      droppedCount: 1,
      plugin: "queue-observer-plugin",
      point: "progress",
      type: "hook_tap_dropped",
    },
  ]);
});

test("a slow Tap does not extend emit latency under the test clock", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const finished = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("slow-observer-plugin"), [
        defineHookContribution({
          mergeClass: "Tap",
          name: "slow-turn-observer",
          point: "turn-lifecycle",
          run: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Effect.sleep("1 hour");
              yield* Deferred.succeed(finished, undefined);
            }),
        }),
      ]);
      const before = yield* TestClock.currentTimeMillis;
      yield* emitter.emit("turn-lifecycle", { phase: "started" }, grants());
      const after = yield* TestClock.currentTimeMillis;
      yield* Deferred.await(started);
      return {
        elapsed: after - before,
        finished: Option.isSome(yield* Deferred.poll(finished)),
      };
    }).pipe(Effect.provide(emitterLayer()), Effect.provide(TestContext.TestContext)),
  );

  expect(result).toEqual({ elapsed: 0, finished: false });
});

test("Hook spans name the point, plugin, outcome, and duration", async () => {
  const spans: Array<CapturedSpan> = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("span-broken-plugin"), [
        defineHookContribution(
          {
            mergeClass: "Chain",
            name: "span-broken-context",
            point: "context",
            run: () => Effect.fail("span context broke"),
          },
          20,
        ),
      ]);
      yield* registry.registerPlugin(manifest("span-healthy-plugin"), [
        defineHookContribution(
          {
            mergeClass: "Chain",
            name: "span-healthy-context",
            point: "context",
            run: (input: { readonly value: string }) => Effect.succeed(input),
          },
          10,
        ),
      ]);
      yield* registry.registerPlugin(manifest("span-guard-plugin"), [
        defineHookContribution({
          mergeClass: "FirstWins",
          name: "span-tool-guard",
          point: "tool-call-gate",
          run: () => Effect.fail("span gate broke"),
        }),
      ]);
      yield* emitter.emit("context", { value: "context" }, grants());
      yield* Effect.exit(emitter.emit("tool-call-gate", { tool: "shell" }, grants()));
    }).pipe(Effect.provide(emitterLayer()), Effect.provide(tracerLayer(spans))),
  );

  const hookSpans = spans.filter((span) => span.name === "plugins.hook");
  expect(
    hookSpans.map((span) => ({
      contributionCount: span.attributes.get("contributionCount"),
      outcome: span.attributes.get("outcome"),
      point: span.attributes.get("point"),
      rejectedPlugins: span.attributes.get("rejectedPlugins"),
      skippedPlugins: span.attributes.get("skippedPlugins"),
    })),
  ).toEqual([
    {
      contributionCount: 2,
      outcome: "success",
      point: "context",
      rejectedPlugins: [],
      skippedPlugins: ["span-broken-plugin"],
    },
    {
      contributionCount: 1,
      outcome: "rejected",
      point: "tool-call-gate",
      rejectedPlugins: ["span-guard-plugin"],
      skippedPlugins: [],
    },
  ]);
  const contributionSpans = spans.filter((span) => span.name === "plugins.hook.contribution");
  expect(
    contributionSpans.map((span) => ({
      durationMillis: span.attributes.get("durationMillis"),
      outcome: span.attributes.get("outcome"),
      plugin: span.attributes.get("plugin"),
      point: span.attributes.get("point"),
    })),
  ).toEqual([
    {
      durationMillis: expect.any(Number),
      outcome: "failure",
      plugin: "span-broken-plugin",
      point: "context",
    },
    {
      durationMillis: expect.any(Number),
      outcome: "success",
      plugin: "span-healthy-plugin",
      point: "context",
    },
    {
      durationMillis: expect.any(Number),
      outcome: "failure",
      plugin: "span-guard-plugin",
      point: "tool-call-gate",
    },
  ]);
});

test("Tap worker fibers are interrupted when the emitter layer Scope closes", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const finalized = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const scope = yield* Scope.make();
      const services = yield* Layer.build(emitterLayer()).pipe(Scope.extend(scope));
      const emitter = Context.get(services, HookEmitter);
      const registry = Context.get(services, ContributionRegistry);
      yield* registry.registerPlugin(manifest("scoped-observer-plugin"), [
        defineHookContribution({
          mergeClass: "Tap",
          name: "scoped-turn-observer",
          point: "turn-lifecycle",
          run: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.zipRight(Effect.never),
              Effect.ensuring(Deferred.succeed(finalized, undefined)),
            ),
        }),
      ]);
      yield* emitter.emit("turn-lifecycle", { phase: "started" }, grants());
      yield* Deferred.await(started);
      yield* Scope.close(scope, Exit.void);
      return yield* Deferred.poll(finalized);
    }),
  );

  expect(Option.isSome(result)).toBe(true);
});

test("emit filters Hook contributions through per-session grants", async () => {
  const ran: Array<string> = [];
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const emitter = yield* HookEmitter;
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(
        {
          capabilities: [{ name: "network", required: true }],
          name: "network-hook-plugin",
          version: "1.0.0",
        },
        [
          defineHookContribution({
            mergeClass: "Chain",
            name: "network-context",
            point: "context",
            run: (input: { readonly value: string }) =>
              Effect.sync(() => {
                ran.push(input.value);
                return { value: `${input.value}-network` };
              }),
          }),
        ],
      );
      return {
        granted: yield* emitter.emit("context", { value: "granted" }, grants(["network"])),
        ungranted: yield* emitter.emit("context", { value: "ungranted" }, grants()),
      };
    }).pipe(Effect.provide(emitterLayer())),
  );

  expect(result).toEqual({
    granted: { value: "granted-network" },
    ungranted: { value: "ungranted" },
  });
  expect(ran).toEqual(["granted"]);
});
