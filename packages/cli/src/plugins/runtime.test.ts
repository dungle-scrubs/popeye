/**
 * Covers per-Session Tool grant variation through the CLI Tool registry
 * (RFC-04 §5, issue #54). Two Sessions alive in one runtime hold their own
 * Tool views; a Session without filters keeps exactly the process-level view;
 * Session filters only narrow, survive a Plugin reload, and are dropped on
 * release; capability-gated Tools follow each Session's grant.
 *
 * Issue #89: a Tool call's gate Hooks see the calling Session's id in
 * CurrentGrantsFiberRef, whatever id the process-wide cache's wrappers carry,
 * and a Turn holds no Generation lease: a reload completes while a Turn is
 * open, and the Turn's later calls run the reloaded Tools.
 *
 * Issue #93: a running Tool call holds a lease on its Generation, with a drain
 * timeout; the swap refreshes the process Tool cache; and the CLI runtime's
 * Driver (CliRuntimeDriverDefault) follows the current Generation for
 * Commands, `/reload`, and the session-lifecycle Tap.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMemoryJournalBacking,
  JournalMemory,
  type SessionId,
  SessionIdSchema,
} from "@dungle-scrubs/popeye-journal";
import {
  ContributionRegistryError,
  CurrentGrantsFiberRef,
  defineCommandContribution,
  defineHookContribution,
  defineToolContribution,
  PluginInteractions,
  PluginInteractionsNullLive,
  type PluginInteractionsService,
  ToolContributionError,
} from "@dungle-scrubs/popeye-plugins";
import { Deferred, Effect, Fiber, FiberRef, Layer, Option, Schema, Stream } from "effect";
import { expect, test, vi } from "vitest";

import {
  CliRuntimeDriverDefault,
  Driver,
  GenerationDriverDefault,
  InvokeCommandError,
  Provider,
  type ProviderService,
  type SessionToolView,
  ToolRegistry,
} from "../compose.js";
import { defaultFirstPartyPlugins } from "../features/first-party-suite.js";
import { toolVettingPlugin } from "../features/tool-vetting.js";
import * as toolAdapter from "../tools/adapter.js";
import type { ToolGrantFilter } from "../tools/grants.js";
import type { FirstPartyPlugin } from "./pipeline.js";
import { ReloadBusyError, ReloadDrainTimeoutError } from "./reload.js";
import { type CliRuntime, makeCliRuntime } from "./runtime.js";

interface FixtureTool {
  readonly name: string;
  readonly requiredCapabilities?: ReadonlyArray<string>;
}

const toolPlugin = (
  name: string,
  tools: ReadonlyArray<FixtureTool>,
  capabilities: ReadonlyArray<string> = [],
): FirstPartyPlugin => ({
  contributions: tools.map((tool) =>
    defineToolContribution({
      description: `Run ${tool.name}.`,
      execute: () => Effect.succeed({ content: `${tool.name}-result` }),
      name: tool.name,
      parameters: Schema.Struct({}),
      ...(tool.requiredCapabilities === undefined
        ? {}
        : { requiredCapabilities: tool.requiredCapabilities }),
    }),
  ),
  manifest: {
    capabilities: capabilities.map((capability) => ({ name: capability })),
    name,
    version: "1.0.0",
  },
});

const fixturePlugins: ReadonlyArray<FirstPartyPlugin> = [
  toolPlugin("fixture-tools", [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }]),
];

const filter = (overrides: Partial<ToolGrantFilter>): ToolGrantFilter => ({
  access: undefined,
  excludeTools: [],
  tools: [],
  ...overrides,
});

const sessionA = SessionIdSchema.make("session-a");
const sessionB = SessionIdSchema.make("session-b");
const sessionC = SessionIdSchema.make("session-c");

const viewNames = (runtime: CliRuntime, sessionId: SessionId) =>
  runtime.toolRegistry.view(sessionId).pipe(
    Effect.map((view) =>
      view
        .list()
        .map((tool) => tool.name)
        .sort(),
    ),
  );

const withRuntime = <A>(
  options: {
    readonly drainTimeoutMillis?: number;
    readonly firstPartyPlugins?: ReadonlyArray<FirstPartyPlugin>;
    readonly interactions?: Layer.Layer<PluginInteractions>;
    readonly toolGrants?: ToolGrantFilter;
  },
  body: (runtime: CliRuntime) => Effect.Effect<A, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "popeye-cli-runtime-session-grants-"))),
      (projectPath) =>
        Effect.gen(function* () {
          const runtime = yield* makeCliRuntime(
            {
              firstPartyPlugins: options.firstPartyPlugins ?? fixturePlugins,
              noProjectPlugins: true,
              pluginPaths: [],
              projectPath,
              ...(options.toolGrants === undefined ? {} : { toolGrants: options.toolGrants }),
            },
            options.drainTimeoutMillis === undefined
              ? {}
              : { drainTimeoutMillis: options.drainTimeoutMillis },
          ).pipe(Effect.provide(options.interactions ?? PluginInteractionsNullLive));
          return yield* body(runtime).pipe(Effect.ensuring(runtime.close));
        }),
      (projectPath) => Effect.promise(() => rm(projectPath, { force: true, recursive: true })),
    ),
  );

test("two Sessions alive in one runtime hold different Tool views when one is narrowed", async () => {
  const result = await withRuntime({}, (runtime) =>
    Effect.gen(function* () {
      yield* runtime.sessionToolGrants.narrow(sessionB, filter({ tools: ["alpha"] }));
      const viewB = yield* runtime.toolRegistry.view(sessionB);
      return {
        a: yield* viewNames(runtime, sessionA),
        b: viewB.list().map((tool) => tool.name),
        bGetsBeta: viewB.get("beta"),
      };
    }),
  );

  expect(result.a).toEqual(["alpha", "beta", "gamma"]);
  expect(result.b).toEqual(["alpha"]);
  expect(result.bGetsBeta).toBeUndefined();
});

test("a Session without filters keeps exactly the process-level view while another Session is narrowed", async () => {
  const result = await withRuntime({ toolGrants: filter({ excludeTools: ["gamma"] }) }, (runtime) =>
    Effect.gen(function* () {
      const before = yield* viewNames(runtime, sessionA);
      yield* runtime.sessionToolGrants.narrow(sessionB, filter({ tools: ["alpha"] }));
      // The narrowed Session's view is computed last, and the process-wide
      // surface is read before any other view: the narrowed view must not
      // replace it (an unconditional cache assignment fails here).
      const narrowed = yield* viewNames(runtime, sessionB);
      const processGetBeta = runtime.toolRegistry.get("beta")?.name;
      const processList = runtime.toolRegistry
        .list()
        .map((tool) => tool.name)
        .sort();
      const startup = yield* viewNames(runtime, SessionIdSchema.make("startup-toolcount"));
      const after = yield* viewNames(runtime, sessionA);
      return { after, before, narrowed, processGetBeta, processList, startup };
    }),
  );

  expect(result.before).toEqual(["alpha", "beta"]);
  expect(result.narrowed).toEqual(["alpha"]);
  expect(result.processList).toEqual(["alpha", "beta"]);
  expect(result.processGetBeta).toBe("beta");
  expect(result.startup).toEqual(["alpha", "beta"]);
  expect(result.after).toEqual(["alpha", "beta"]);
});

test("a Session view admits exactly the names its grant admits", async () => {
  const result = await withRuntime({ toolGrants: filter({ excludeTools: ["gamma"] }) }, (runtime) =>
    Effect.gen(function* () {
      yield* runtime.sessionToolGrants.narrow(sessionB, filter({ tools: ["alpha", "gamma"] }));
      const viewA = yield* runtime.toolRegistry.view(sessionA);
      const viewB = yield* runtime.toolRegistry.view(sessionB);
      const admitted = (view: SessionToolView) =>
        ["alpha", "beta", "gamma", "missing"].map((name) => view.admits?.(name));
      return { a: admitted(viewA), b: admitted(viewB) };
    }),
  );

  // The process filter excludes gamma; a name no Tool carries is admitted by
  // the grant and resolves to no Tool at execution.
  expect(result.a).toEqual([true, true, false, true]);
  expect(result.b).toEqual([true, false, false, false]);
});

test("a Session filter narrows the process grant and never widens it", async () => {
  const result = await withRuntime(
    { toolGrants: filter({ tools: ["alpha", "beta"] }) },
    (runtime) =>
      Effect.gen(function* () {
        yield* runtime.sessionToolGrants.narrow(sessionB, filter({ tools: ["beta", "gamma"] }));
        const once = yield* viewNames(runtime, sessionB);
        yield* runtime.sessionToolGrants.narrow(sessionB, filter({ excludeTools: ["beta"] }));
        const twice = yield* viewNames(runtime, sessionB);
        return { once, twice };
      }),
  );

  expect(result.once).toEqual(["beta"]);
  expect(result.twice).toEqual([]);
});

test("release returns a Session to the process-level view", async () => {
  const result = await withRuntime({}, (runtime) =>
    Effect.gen(function* () {
      yield* runtime.sessionToolGrants.narrow(sessionB, filter({ agentTools: ["gamma"] }));
      const narrowed = yield* viewNames(runtime, sessionB);
      yield* runtime.sessionToolGrants.release(sessionB);
      const released = yield* viewNames(runtime, sessionB);
      return { narrowed, released };
    }),
  );

  expect(result.narrowed).toEqual(["gamma"]);
  expect(result.released).toEqual(["alpha", "beta", "gamma"]);
});

test("Session filters survive a Plugin reload and still bind only their own Session", async () => {
  const result = await withRuntime({}, (runtime) =>
    Effect.gen(function* () {
      yield* runtime.sessionToolGrants.narrow(sessionB, filter({ tools: ["alpha"] }));
      yield* runtime.reload;
      return {
        a: yield* viewNames(runtime, sessionA),
        b: yield* viewNames(runtime, sessionB),
        processList: runtime.toolRegistry
          .list()
          .map((tool) => tool.name)
          .sort(),
      };
    }),
  );

  expect(result.a).toEqual(["alpha", "beta", "gamma"]);
  expect(result.b).toEqual(["alpha"]);
  expect(result.processList).toEqual(["alpha", "beta", "gamma"]);
});

test("a capability-gated Tool is available to exactly the Sessions whose grants carry it", async () => {
  const plugins: ReadonlyArray<FirstPartyPlugin> = [
    toolPlugin("plain-plugin", [{ name: "plain-tool" }]),
    toolPlugin(
      "gated-plugin",
      [{ name: "shell-tool", requiredCapabilities: ["shell"] }],
      ["shell"],
    ),
    // Requires a Capability its manifest never declares: no Session grant carries it.
    toolPlugin("undeclared-plugin", [
      { name: "undeclared-tool", requiredCapabilities: ["network"] },
    ]),
  ];
  const result = await withRuntime({ firstPartyPlugins: plugins }, (runtime) =>
    Effect.gen(function* () {
      yield* runtime.sessionToolGrants.narrow(sessionB, filter({ tools: ["plain-tool"] }));
      yield* runtime.sessionToolGrants.narrow(
        sessionC,
        filter({ agentTools: ["shell-tool", "undeclared-tool"] }),
      );
      const viewC = yield* runtime.toolRegistry.view(sessionC);
      return {
        a: yield* viewNames(runtime, sessionA),
        b: yield* viewNames(runtime, sessionB),
        c: viewC.list().map((tool) => tool.name),
        cShellCapabilities: viewC.get("shell-tool")?.requiredCapabilities,
      };
    }),
  );

  expect(result.a).toEqual(["plain-tool", "shell-tool"]);
  expect(result.b).toEqual(["plain-tool"]);
  expect(result.c).toEqual(["shell-tool"]);
  expect(result.cShellCapabilities).toEqual(["shell"]);
});

/**
 * Runs one Turn whose Provider pauses after Turn open, reloads the Plugins to
 * a second Tool version while it waits, then lets the model call alpha.
 */
const reloadDuringTurn = (narrowTo: ReadonlyArray<string> | undefined) => {
  const version = (label: string) =>
    defineToolContribution({
      description: `Version ${label}`,
      execute: () => Effect.succeed({ content: `alpha-${label}` }),
      name: "alpha",
      parameters: Schema.Struct({}),
    });
  // Mutable so the reload recomposes the second version (composition reads it again).
  const plugin: { -readonly [K in keyof FirstPartyPlugin]: FirstPartyPlugin[K] } = {
    contributions: [version("v1")],
    manifest: { capabilities: [], name: "reload-fixture", version: "1.0.0" },
  };
  return withRuntime({ firstPartyPlugins: [plugin] }, (runtime) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let offer: ReadonlyArray<string> = [];
      const provider: ProviderService = {
        streamAssistant: (context, options) => {
          if (context.at(-1)?.role === "toolResult") {
            return Stream.make({ _tag: "done" as const, stopReason: "done" as const });
          }
          offer = (options.tools ?? []).map((tool) => tool.description);
          return Stream.fromEffect(
            Deferred.succeed(entered, undefined).pipe(
              Effect.zipRight(Deferred.await(resume)),
              Effect.as({
                _tag: "toolCall" as const,
                argumentsJson: "{}",
                id: "call-alpha",
                name: "alpha",
              }),
            ),
          ).pipe(
            Stream.concat(Stream.make({ _tag: "done" as const, stopReason: "toolCalls" as const })),
          );
        },
      };
      const generation = yield* runtime.currentGeneration;
      const layer = GenerationDriverDefault(generation).pipe(
        Layer.provide(
          Layer.mergeAll(
            JournalMemory(createMemoryJournalBacking()),
            Layer.succeed(Provider, provider),
            Layer.succeed(ToolRegistry, runtime.toolRegistry),
          ),
        ),
      );
      return yield* Effect.gen(function* () {
        const driver = yield* Driver;
        const session = yield* driver.createSession();
        if (narrowTo !== undefined) {
          yield* runtime.sessionToolGrants.narrow(session.id, filter({ tools: narrowTo }));
        }
        const running = yield* Effect.fork(driver.prompt(session.id, "Call alpha."));
        yield* Deferred.await(entered);
        plugin.contributions = [version("v2")];
        yield* runtime.reload;
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(running);
        const snapshot = yield* driver.getSnapshot(session.id);
        const output = snapshot.entries
          .map((entry) => entry.payload as Record<string, unknown>)
          .find((payload) => payload.role === "toolResult");
        return { executed: output?.content, offer };
      }).pipe(Effect.provide(layer));
    }),
  );
};

test("a Plugin reload during an unnarrowed Session's Turn executes the reloaded Tool, as today", async () => {
  const result = await reloadDuringTurn(undefined);

  // The model was offered v1 at Turn open; execution resolves the current
  // Generation's Tool, never the closed Generation's.
  expect(result.offer).toEqual(["Version v1"]);
  expect(result.executed).toBe("alpha-v2");
});

test("a Plugin reload during a narrowed Session's Turn executes the reloaded Tool its grant admits", async () => {
  const result = await reloadDuringTurn(["alpha"]);

  expect(result.offer).toEqual(["Version v1"]);
  expect(result.executed).toBe("alpha-v2");
});

test("the process Tool view ignores addressable pseudo Session filters", async () => {
  const result = await withRuntime(
    { toolGrants: filter({ tools: ["alpha", "beta"] }) },
    (runtime) =>
      Effect.gen(function* () {
        for (const id of ["startup-toolcount", "process-tool-view"]) {
          yield* runtime.sessionToolGrants.narrow(
            SessionIdSchema.make(id),
            filter({ tools: ["alpha"] }),
          );
        }
        const processView = yield* runtime.processToolView;
        return {
          process: processView
            .list()
            .map((tool) => tool.name)
            .sort(),
          session: yield* viewNames(runtime, SessionIdSchema.make("process-tool-view")),
        };
      }),
  );
  expect(result.process).toEqual(["alpha", "beta"]);
  expect(result.session).toEqual(["alpha"]);
});

// Issue #89 -----------------------------------------------------------------

interface GateObservation {
  /** The Session id the gate input names (correct before #89). */
  readonly gateSessionId: string | undefined;
  /** The Session id of the CapabilityGrants in CurrentGrantsFiberRef. */
  readonly grantsSessionId: string | undefined;
  /** Which Plugin version's Hook ran. */
  readonly hookVersion: string;
  readonly toolCallId: string;
}

/** A tool-call-gate Hook that records what CurrentGrantsFiberRef holds and continues. */
const gateProbe = (hookVersion: string, observed: Array<GateObservation>) =>
  defineHookContribution({
    mergeClass: "FirstWins",
    name: "grants-probe",
    point: "tool-call-gate",
    run: (input: { readonly sessionId?: string | undefined; readonly toolCallId: string }) =>
      FiberRef.get(CurrentGrantsFiberRef).pipe(
        Effect.map((grants) => {
          observed.push({
            gateSessionId: input.sessionId,
            grantsSessionId: Option.getOrUndefined(grants)?.sessionId,
            hookVersion,
            toolCallId: input.toolCallId,
          });
          return { decision: "continue" as const };
        }),
      ),
  });

const alphaTool = (version: string) =>
  defineToolContribution({
    description: `Version ${version}`,
    execute: () => Effect.succeed({ content: `alpha-${version}` }),
    name: "alpha",
    parameters: Schema.Struct({}),
  });

/** The call id the scripted Provider gives a Session's alpha call: `call-<prompt>`. */
const callIdFor = (prompt: string) => `call-${prompt}`;

/**
 * A Provider that calls alpha once per Turn with the id `call-<user prompt>`,
 * then ends the Turn. `pause` holds a named prompt's first response until its
 * resume Deferred completes, signalling `entered` once it is waiting.
 */
const scriptedAlphaProvider = (
  pause: ReadonlyMap<
    string,
    { readonly entered: Deferred.Deferred<void>; readonly resume: Deferred.Deferred<void> }
  > = new Map(),
): ProviderService => ({
  streamAssistant: (context) => {
    if (context.at(-1)?.role === "toolResult") {
      return Stream.make({ _tag: "done" as const, stopReason: "done" as const });
    }
    const prompt = context.find((item) => item.role === "user")?.content ?? "";
    const call = {
      _tag: "toolCall" as const,
      argumentsJson: "{}",
      id: callIdFor(prompt),
      name: "alpha",
    };
    const gate = pause.get(prompt);
    return (
      gate === undefined
        ? Stream.make(call)
        : Stream.fromEffect(
            Deferred.succeed(gate.entered, undefined).pipe(
              Effect.zipRight(Deferred.await(gate.resume)),
              Effect.as(call),
            ),
          )
    ).pipe(Stream.concat(Stream.make({ _tag: "done" as const, stopReason: "toolCalls" as const })));
  },
});

const driverLayer = (runtime: CliRuntime, provider: ProviderService) =>
  runtime.currentGeneration.pipe(
    Effect.map((generation) =>
      GenerationDriverDefault(generation).pipe(
        Layer.provide(
          Layer.mergeAll(
            JournalMemory(createMemoryJournalBacking()),
            Layer.succeed(Provider, provider),
            Layer.succeed(ToolRegistry, runtime.toolRegistry),
          ),
        ),
      ),
    ),
  );

const toolResultOf = (snapshot: {
  readonly entries: ReadonlyArray<{ readonly payload: unknown }>;
}) =>
  snapshot.entries
    .map((entry) => entry.payload as Record<string, unknown>)
    .find((payload) => payload.role === "toolResult")?.content;

test("a narrowed Session's Tool call runs its gate Hooks with that Session's grants id", async () => {
  const observed: Array<GateObservation> = [];
  const plugin: FirstPartyPlugin = {
    contributions: [alphaTool("v1"), gateProbe("v1", observed)],
    manifest: { capabilities: [], name: "grants-id-fixture", version: "1.0.0" },
  };
  const result = await withRuntime({ firstPartyPlugins: [plugin] }, (runtime) =>
    Effect.gen(function* () {
      const layer = yield* driverLayer(runtime, scriptedAlphaProvider());
      return yield* Effect.gen(function* () {
        const driver = yield* Driver;
        const unnarrowed = yield* driver.createSession();
        const narrowed = yield* driver.createSession();
        yield* runtime.sessionToolGrants.narrow(narrowed.id, filter({ tools: ["alpha"] }));
        // The process-wide cache executes wrappers adapted for another id
        // (a pseudo id, or before #93 the last unnarrowed view's); the gate
        // must still see the narrowed caller.
        yield* driver.prompt(unnarrowed.id, "unnarrowed");
        yield* driver.prompt(narrowed.id, "narrowed");
        return {
          executed: toolResultOf(yield* driver.getSnapshot(narrowed.id)),
          narrowedId: narrowed.id as string,
          unnarrowedId: unnarrowed.id as string,
        };
      }).pipe(Effect.provide(layer));
    }),
  );

  const narrowedCall = observed.find((entry) => entry.toolCallId === callIdFor("narrowed"));
  expect(result.executed).toBe("alpha-v1");
  expect(narrowedCall?.gateSessionId).toBe(result.narrowedId);
  expect(narrowedCall?.grantsSessionId).toBe(result.narrowedId);
  expect(
    observed.find((entry) => entry.toolCallId === callIdFor("unnarrowed"))?.grantsSessionId,
  ).toBe(result.unnarrowedId);
});

test("an unnarrowed Session's Tool call keeps its own grants id when another Session's Turn opened after its own", async () => {
  const observed: Array<GateObservation> = [];
  const plugin: FirstPartyPlugin = {
    contributions: [alphaTool("v1"), gateProbe("v1", observed)],
    manifest: { capabilities: [], name: "grants-id-fixture", version: "1.0.0" },
  };
  const result = await withRuntime({ firstPartyPlugins: [plugin] }, (runtime) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const layer = yield* driverLayer(
        runtime,
        scriptedAlphaProvider(new Map([["first", { entered, resume }]])),
      );
      return yield* Effect.gen(function* () {
        const driver = yield* Driver;
        const first = yield* driver.createSession();
        const second = yield* driver.createSession();
        const running = yield* Effect.fork(driver.prompt(first.id, "first"));
        yield* Deferred.await(entered);
        // The second Session's Turn opens while the first is waiting (before
        // #93 its view also refreshed the process-wide cache with its own id).
        yield* driver.prompt(second.id, "second");
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(running);
        return { firstId: first.id as string, secondId: second.id as string };
      }).pipe(Effect.provide(layer));
    }),
  );

  expect(observed.find((entry) => entry.toolCallId === callIdFor("second"))?.grantsSessionId).toBe(
    result.secondId,
  );
  const firstCall = observed.find((entry) => entry.toolCallId === callIdFor("first"));
  expect(firstCall?.gateSessionId).toBe(result.firstId);
  expect(firstCall?.grantsSessionId).toBe(result.firstId);
});

/**
 * Opens one Turn whose Provider pauses after Turn open, reloads the Plugins to
 * a second version of alpha and of the gate Hook while it waits, samples the
 * Generation's lease count, then lets the model call alpha.
 */
const reloadMidTurnWithGateProbe = (narrowTo: ReadonlyArray<string> | undefined) => {
  const observed: Array<GateObservation> = [];
  // Mutable so the reload recomposes the second version (composition reads it again).
  const plugin: { -readonly [K in keyof FirstPartyPlugin]: FirstPartyPlugin[K] } = {
    contributions: [alphaTool("v1"), gateProbe("v1", observed)],
    manifest: { capabilities: [], name: "reload-grants-fixture", version: "1.0.0" },
  };
  return withRuntime({ firstPartyPlugins: [plugin] }, (runtime) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let offer: ReadonlyArray<string> = [];
      const scripted = scriptedAlphaProvider(new Map([["reload", { entered, resume }]]));
      const provider: ProviderService = {
        streamAssistant: (context, options) => {
          if (context.at(-1)?.role !== "toolResult") {
            offer = (options.tools ?? []).map((tool) => tool.description);
          }
          return scripted.streamAssistant(context, options);
        },
      };
      const layer = yield* driverLayer(runtime, provider);
      return yield* Effect.gen(function* () {
        const driver = yield* Driver;
        const session = yield* driver.createSession();
        if (narrowTo !== undefined) {
          yield* runtime.sessionToolGrants.narrow(session.id, filter({ tools: narrowTo }));
        }
        const running = yield* Effect.fork(driver.prompt(session.id, "reload"));
        yield* Deferred.await(entered);
        const inFlightDuringTurn = (yield* runtime.debugInfo).inFlight;
        plugin.contributions = [alphaTool("v2"), gateProbe("v2", observed)];
        // A Turn lease would hold this reload at its drain barrier until the
        // Turn ends, and the Turn waits for this reload: the test would hang.
        const swap = yield* runtime.reload;
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(running);
        return {
          executed: toolResultOf(yield* driver.getSnapshot(session.id)),
          inFlightDuringTurn,
          leaseCount: swap.leaseCount,
          observed,
          offer,
          sessionId: session.id as string,
        };
      }).pipe(Effect.provide(layer));
    }),
  );
};

test.each([
  ["an unnarrowed", undefined],
  ["a narrowed", ["alpha"]],
] as const)(
  "a reload completes while %s Session's Turn is open: the Turn holds no Generation lease and its call runs the reloaded Tool and gate Hook",
  async (_label, narrowTo) => {
    const result = await reloadMidTurnWithGateProbe(narrowTo);

    // #89 Decision 2 (guard): no Turn lease, so the reload drains at once.
    expect(result.inFlightDuringTurn).toBe(0);
    expect(result.leaseCount).toBe(0);
    // The offer is pinned at Turn open; execution resolves through the
    // refreshed process-wide cache, so the reloaded Tool and Hook run.
    expect(result.offer).toEqual(["Version v1"]);
    expect(result.executed).toBe("alpha-v2");
    expect(result.observed.map((entry) => entry.hookVersion)).toEqual(["v2"]);
  },
);

test.each([
  ["an unnarrowed", undefined],
  ["a narrowed", ["alpha"]],
] as const)(
  "after a reload completes mid-Turn, %s Session's call runs its gate Hook with that Session's grants id",
  async (_label, narrowTo) => {
    const result = await reloadMidTurnWithGateProbe(narrowTo);

    // The refreshed cache was adapted for the reload pseudo id; the gate must
    // still see the calling Session.
    expect(result.observed).toHaveLength(1);
    expect(result.observed[0]?.gateSessionId).toBe(result.sessionId);
    expect(result.observed[0]?.grantsSessionId).toBe(result.sessionId);
  },
);

// Issue #93 -----------------------------------------------------------------

/** Polls until the runtime's current Generation is no longer `fromId`. */
const awaitSwap = (runtime: CliRuntime, fromId: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      if ((yield* runtime.debugInfo).currentGenerationId !== fromId) {
        return;
      }
      yield* Effect.sleep("1 millis");
    }
    return yield* Effect.die("The reload never swapped the current Generation.");
  });

interface ToolGate {
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

const makeToolGate = (): ToolGate => ({
  entered: Effect.runSync(Deferred.make<void>()),
  release: Effect.runSync(Deferred.make<void>()),
});

/** alpha at `version`, whose execute signals `entered` and then waits for `release`. */
const heldAlphaTool = (version: string, gate: ToolGate) =>
  defineToolContribution({
    description: `Version ${version}`,
    execute: () =>
      Deferred.succeed(gate.entered, undefined).pipe(
        Effect.zipRight(Deferred.await(gate.release)),
        Effect.as({ content: `alpha-${version}` }),
      ),
    name: "alpha",
    parameters: Schema.Struct({}),
  });

const cliRuntimeDriverLayer = (runtime: CliRuntime, provider: ProviderService) =>
  CliRuntimeDriverDefault(runtime).pipe(
    Layer.provide(
      Layer.mergeAll(
        JournalMemory(createMemoryJournalBacking()),
        Layer.succeed(Provider, provider),
        Layer.succeed(ToolRegistry, runtime.toolRegistry),
      ),
    ),
  );

/**
 * Starts a Turn whose alpha call holds until released, reloads to alpha v2
 * while it runs, and reports what the reload and the call did.
 */
const reloadDuringToolCall = (drainTimeoutMillis: number | undefined) => {
  const gate = makeToolGate();
  // Mutable so the reload recomposes the second version (composition reads it again).
  const plugin: { -readonly [K in keyof FirstPartyPlugin]: FirstPartyPlugin[K] } = {
    contributions: [heldAlphaTool("v1", gate)],
    manifest: { capabilities: [], name: "held-tool-fixture", version: "1.0.0" },
  };
  return withRuntime(
    {
      firstPartyPlugins: [plugin],
      ...(drainTimeoutMillis === undefined ? {} : { drainTimeoutMillis }),
    },
    (runtime) =>
      Effect.gen(function* () {
        const layer = yield* driverLayer(runtime, scriptedAlphaProvider());
        return yield* Effect.gen(function* () {
          const driver = yield* Driver;
          const session = yield* driver.createSession();
          const initialId = (yield* runtime.currentGeneration).id;
          const turn = yield* Effect.fork(driver.prompt(session.id, "held"));
          yield* Deferred.await(gate.entered);
          plugin.contributions = [alphaTool("v2")];
          const reloading = yield* Effect.fork(Effect.either(runtime.reload));
          yield* awaitSwap(runtime, initialId);
          // Long enough for a reload that does not wait for the call to finish.
          yield* Effect.sleep("100 millis");
          const reloadDoneWhileCallRuns = Option.isSome(yield* Fiber.poll(reloading));
          yield* Deferred.succeed(gate.release, undefined);
          yield* Fiber.join(turn);
          const outcome = yield* Fiber.join(reloading);
          return {
            currentId: (yield* runtime.currentGeneration).id,
            executed: toolResultOf(yield* driver.getSnapshot(session.id)),
            initialId,
            outcome,
            reloadDoneWhileCallRuns,
          };
        }).pipe(Effect.provide(layer));
      }),
  );
};

test("a Tool call running when a reload starts holds its Generation: the reload waits for it, and the call finishes on its own Tool", async () => {
  const result = await reloadDuringToolCall(undefined);

  expect(result.reloadDoneWhileCallRuns).toBe(false);
  expect(result.outcome._tag).toBe("Right");
  if (result.outcome._tag === "Right") {
    expect(result.outcome.right).toMatchObject({
      leaseCount: 1,
      newGenerationId: result.currentId,
      oldGenerationId: result.initialId,
    });
  }
  expect(result.executed).toBe("alpha-v1");
});

test("a reload whose drain outlasts the drain timeout fails with ReloadDrainTimeoutError, keeps the swap, and the running call still finishes on its own Tool", async () => {
  const result = await reloadDuringToolCall(50);

  expect(result.reloadDoneWhileCallRuns).toBe(true);
  expect(result.outcome._tag).toBe("Left");
  if (result.outcome._tag === "Left") {
    expect(result.outcome.left).toBeInstanceOf(ReloadDrainTimeoutError);
    expect(result.outcome.left).toMatchObject({
      drainTimeoutMillis: 50,
      holders: ["tool:alpha"],
      leaseCount: 1,
      newGenerationId: result.currentId,
      oldGenerationId: result.initialId,
    });
  }
  expect(result.currentId).not.toBe(result.initialId);
  expect(result.executed).toBe("alpha-v1");
});

test("the swap publishes the reloaded Tools with the new Generation: once a reader sees the new Generation, Tool lookups resolve the reloaded Tool, during the drain", async () => {
  const plugin: { -readonly [K in keyof FirstPartyPlugin]: FirstPartyPlugin[K] } = {
    contributions: [alphaTool("v1")],
    manifest: { capabilities: [], name: "cache-swap-fixture", version: "1.0.0" },
  };
  const result = await withRuntime({ firstPartyPlugins: [plugin] }, (runtime) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* Effect.fork(
        runtime.use(() =>
          Deferred.succeed(started, undefined).pipe(Effect.zipRight(Deferred.await(release))),
        ),
      );
      yield* Deferred.await(started);
      const initialId = (yield* runtime.currentGeneration).id;
      plugin.contributions = [alphaTool("v2")];
      const reloading = yield* Effect.fork(runtime.reload);
      // Each sample reads the current Generation, then (with no barrier) the
      // process Tool lookup that Tool execution uses.
      const samples: Array<{ readonly description: string | undefined; readonly id: string }> = [];
      for (let attempt = 0; attempt < 2_000; attempt += 1) {
        const id = (yield* runtime.currentGeneration).id;
        samples.push({ description: runtime.toolRegistry.get("alpha")?.description, id });
        if (id !== initialId) {
          break;
        }
        yield* Effect.sleep("1 millis");
      }
      const duringDrain = runtime.toolRegistry.get("alpha")?.description;
      const reloadDoneDuringDrain = Option.isSome(yield* Fiber.poll(reloading));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(reloading);
      return { duringDrain, initialId, reloadDoneDuringDrain, samples };
    }),
  );

  expect(result.reloadDoneDuringDrain).toBe(false);
  expect(result.samples.at(-1)?.id).not.toBe(result.initialId);
  // A reader that has seen the new Generation never resolves the old Tool.
  for (const sample of result.samples.filter((entry) => entry.id !== result.initialId)) {
    expect(sample.description).toBe("Version v2");
  }
  expect(result.duringDrain).toBe("Version v2");
});

/** A Plugin named "added-plugin" with an `added-hello` Command. */
const addedCommandPlugin: FirstPartyPlugin = {
  contributions: [
    defineCommandContribution({
      arguments: Schema.Struct({}),
      description: "Say hello from the added Plugin.",
      execute: () => Effect.succeed("hello"),
      name: "added-hello",
    }),
  ],
  manifest: { capabilities: [], name: "added-plugin", version: "1.0.0" },
};

test("the CLI runtime Driver's /reload swaps Generations with real ids and Plugin deltas, and its PluginHost resolves the new Generation's Commands", async () => {
  // Mutable so the reload recomposes with the added Plugin (composition reads it again).
  const plugins: Array<FirstPartyPlugin> = [
    ...defaultFirstPartyPlugins,
    toolPlugin("fixture-tools", [{ name: "alpha" }]),
  ];
  const result = await withRuntime({ firstPartyPlugins: plugins }, (runtime) =>
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      const before = (yield* runtime.currentGeneration).id;
      plugins.push(addedCommandPlugin);
      const swap = yield* driver.invokeCommand(session.id, "reload", {});
      const after = (yield* runtime.currentGeneration).id;
      const hello = yield* driver.invokeCommand(session.id, "added-hello", {});
      return { after, before, hello, swap };
    }).pipe(Effect.provide(cliRuntimeDriverLayer(runtime, scriptedAlphaProvider()))),
  );

  expect(result.after).not.toBe(result.before);
  expect(result.swap).toMatchObject({
    leaseCount: 0,
    newGenerationId: result.after,
    oldGenerationId: result.before,
    pluginsAdded: ["added-plugin"],
    pluginsRemoved: [],
    pluginsReplaced: ["compact", "fixture-tools", "goal", "reload", "session-name"],
    type: "generation_swap",
  });
  expect(result.hello).toBe("hello");
});

test("the CLI runtime Driver's session-lifecycle Tap reaches the current Generation's Plugins", async () => {
  const seen: Array<string> = [];
  const lifecycleProbe = (version: string) =>
    defineHookContribution({
      mergeClass: "Tap",
      name: "lifecycle-probe",
      point: "session-lifecycle",
      run: (input: { readonly event: string; readonly sessionId: string }) =>
        Effect.sync(() => {
          seen.push(`${version}:${input.event}:${input.sessionId}`);
        }),
    });
  const plugin: { -readonly [K in keyof FirstPartyPlugin]: FirstPartyPlugin[K] } = {
    contributions: [lifecycleProbe("v1")],
    manifest: { capabilities: [], name: "lifecycle-fixture", version: "1.0.0" },
  };
  const awaitSeen = (entry: string) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 400 && !seen.includes(entry); attempt += 1) {
        yield* Effect.sleep("5 millis");
      }
      return seen.includes(entry);
    });
  const result = await withRuntime({ firstPartyPlugins: [plugin] }, (runtime) =>
    Effect.gen(function* () {
      const driver = yield* Driver;
      const first = yield* driver.createSession();
      const firstSeen = yield* awaitSeen(`v1:created:${first.id}`);
      plugin.contributions = [lifecycleProbe("v2")];
      yield* runtime.reload;
      const second = yield* driver.createSession();
      const secondSeenByV2 = yield* awaitSeen(`v2:created:${second.id}`);
      return {
        firstSeen,
        secondSeenByV1: seen.includes(`v1:created:${second.id}`),
        secondSeenByV2,
      };
    }).pipe(Effect.provide(cliRuntimeDriverLayer(runtime, scriptedAlphaProvider()))),
  );

  expect(result).toEqual({ firstSeen: true, secondSeenByV1: false, secondSeenByV2: true });
});

test("a /reload while another reload drains fails busy with the reload's own message", async () => {
  const result = await withRuntime(
    { firstPartyPlugins: [...defaultFirstPartyPlugins, ...fixturePlugins] },
    (runtime) =>
      Effect.gen(function* () {
        const driver = yield* Driver;
        const first = yield* driver.createSession();
        const second = yield* driver.createSession();
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* Effect.fork(
          runtime.use(() =>
            Deferred.succeed(started, undefined).pipe(Effect.zipRight(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(started);
        const initialId = (yield* runtime.currentGeneration).id;
        const reloading = yield* Effect.fork(driver.invokeCommand(first.id, "reload", {}));
        yield* awaitSwap(runtime, initialId);
        const busy = yield* Effect.either(driver.invokeCommand(second.id, "reload", {}));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        const swap = yield* Fiber.join(reloading);
        return { busy, swap };
      }).pipe(Effect.provide(cliRuntimeDriverLayer(runtime, scriptedAlphaProvider()))),
  );

  expect(result.busy._tag).toBe("Left");
  if (result.busy._tag === "Left") {
    expect(result.busy.left).toMatchObject({
      _tag: "InvokeCommandError",
      commandName: "reload",
      message: "Reload is already in progress.",
      reason: "command_failed",
    });
    expect((result.busy.left as { readonly cause?: unknown }).cause).toBeInstanceOf(
      ReloadBusyError,
    );
  }
  expect(result.swap).toMatchObject({ leaseCount: 1, type: "generation_swap" });
});

test("/reload in a host without ReloadControl fails instead of reporting a stub swap", async () => {
  const result = await withRuntime(
    { firstPartyPlugins: [...defaultFirstPartyPlugins, ...fixturePlugins] },
    (runtime) =>
      Effect.gen(function* () {
        // GenerationDriverDefault binds one fixed Generation and provides no ReloadControl.
        const layer = yield* driverLayer(runtime, scriptedAlphaProvider());
        return yield* Effect.gen(function* () {
          const driver = yield* Driver;
          const session = yield* driver.createSession();
          return yield* Effect.either(driver.invokeCommand(session.id, "reload", {}));
        }).pipe(Effect.provide(layer));
      }),
  );

  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left).toMatchObject({
      _tag: "InvokeCommandError",
      commandName: "reload",
      message: "Reload is not available in this host: it composes no ReloadControl.",
      reason: "command_failed",
    });
  }
});

// Issue #93 revision -------------------------------------------------------

test("the CLI runtime Driver's /reload returns at its drain timeout although the Session Mailbox runs Commands uninterruptibly", async () => {
  const result = await withRuntime(
    {
      drainTimeoutMillis: 50,
      firstPartyPlugins: [...defaultFirstPartyPlugins, ...fixturePlugins],
    },
    (runtime) =>
      Effect.gen(function* () {
        const driver = yield* Driver;
        const session = yield* driver.createSession();
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* Effect.fork(
          runtime.use(() =>
            Deferred.succeed(started, undefined).pipe(Effect.zipRight(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(started);
        const initialId = (yield* runtime.currentGeneration).id;
        // Releases the lease late, so a Command without a working timeout still returns.
        yield* Effect.fork(
          Effect.sleep("1500 millis").pipe(Effect.zipRight(Deferred.succeed(release, undefined))),
        );
        const startedAt = Date.now();
        const outcome = yield* Effect.either(driver.invokeCommand(session.id, "reload", {}));
        const elapsedMillis = Date.now() - startedAt;
        const currentId = (yield* runtime.currentGeneration).id;
        yield* Fiber.join(holder);
        return { currentId, elapsedMillis, initialId, outcome };
      }).pipe(Effect.provide(cliRuntimeDriverLayer(runtime, scriptedAlphaProvider()))),
  );

  expect(result.elapsedMillis).toBeLessThan(1_000);
  expect(result.currentId).not.toBe(result.initialId);
  expect(result.outcome._tag).toBe("Left");
  if (result.outcome._tag === "Left") {
    expect(result.outcome.left).toMatchObject({
      _tag: "InvokeCommandError",
      commandName: "reload",
      message: `Reload swapped to generation ${result.currentId}, but generation ${result.initialId} still has 1 running lease(s) after 50 ms (checkout); it closes when they settle.`,
      reason: "command_failed",
    });
    expect((result.outcome.left as { readonly cause?: unknown }).cause).toBeInstanceOf(
      ReloadDrainTimeoutError,
    );
  }
});

test("the CLI runtime Driver's overflow Compaction asks the current Generation's compaction gate", async () => {
  const seen: Array<string> = [];
  const compactionProbe = (
    version: string,
    decision: { readonly action: "compact" } | { readonly action: "skip"; readonly reason: string },
  ) =>
    defineHookContribution({
      mergeClass: "FirstWins",
      name: "compaction-probe",
      point: "compaction-gate",
      run: () =>
        Effect.sync(() => {
          seen.push(version);
          return decision;
        }),
    });
  const plugin: { -readonly [K in keyof FirstPartyPlugin]: FirstPartyPlugin[K] } = {
    contributions: [compactionProbe("v1", { action: "compact" })],
    manifest: { capabilities: [], name: "compaction-fixture", version: "1.0.0" },
  };
  const purposes: Array<string | undefined> = [];
  const provider: ProviderService = {
    streamAssistant: (_context, options) => {
      purposes.push((options as { readonly purpose?: string } | undefined)?.purpose);
      return Stream.make(
        { _tag: "textDelta" as const, text: "Answered." },
        { _tag: "done" as const, stopReason: "done" as const },
      );
    },
  };
  const result = await withRuntime({ firstPartyPlugins: [plugin] }, (runtime) =>
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      yield* driver.prompt(
        session.id,
        "An earlier prompt that gives Compaction something to fold.",
      );
      plugin.contributions = [compactionProbe("v2", { action: "skip", reason: "v2 vetoes." })];
      yield* runtime.reload;
      const settled = yield* driver.prompt(session.id, "This prompt overflows the budget.", {
        contextBudget: 1,
      });
      const snapshot = yield* driver.getSnapshot(session.id);
      return { last: snapshot.entries.at(-1)?.payload, settled };
    }).pipe(Effect.provide(cliRuntimeDriverLayer(runtime, provider))),
  );

  // Only the reloaded gate ran, and it vetoed: no Compaction request reached the Provider.
  expect(seen).toEqual(["v2"]);
  expect(purposes).not.toContain("compaction");
  expect(result.settled).toMatchObject({ stopReason: "error" });
  expect(JSON.stringify(result.last)).toContain("Compaction was vetoed by a Plugin: v2 vetoes.");
});

/**
 * A Provider that calls alpha once per Turn with the id `call-<latest user prompt>`, then ends
 * the Turn after the Tool result.
 */
const latestPromptAlphaProvider: ProviderService = {
  streamAssistant: (context) => {
    if (context.at(-1)?.role === "toolResult") {
      return Stream.make({ _tag: "done" as const, stopReason: "done" as const });
    }
    const prompt = context.filter((item) => item.role === "user").at(-1)?.content ?? "";
    return Stream.make(
      { _tag: "toolCall" as const, argumentsJson: "{}", id: callIdFor(prompt), name: "alpha" },
      { _tag: "done" as const, stopReason: "toolCalls" as const },
    );
  },
};

const toolResultFor = (
  snapshot: { readonly entries: ReadonlyArray<{ readonly payload: unknown }> },
  toolCallId: string,
) =>
  snapshot.entries
    .map((entry) => entry.payload as Record<string, unknown>)
    .find((payload) => payload.role === "toolResult" && payload.toolCallId === toolCallId);

test("an allow-for-session that the old Generation's vetting gate records after a reload never authorizes the new Generation's calls", async () => {
  const requests: Array<string> = [];
  const oldAsked = Effect.runSync(Deferred.make<void>());
  const oldAnswer = Effect.runSync(Deferred.make<string>());
  // The first vetting prompt (the old Generation's) waits for the test's answer; later
  // prompts (the new Generation's) are rejected.
  const interactions: PluginInteractionsService = {
    request: (request) =>
      Effect.gen(function* () {
        requests.push(request.id);
        const value =
          requests.length === 1
            ? yield* Deferred.succeed(oldAsked, undefined).pipe(
                Effect.zipRight(Deferred.await(oldAnswer)),
              )
            : "reject";
        return {
          response: {
            _tag: "interaction-response" as const,
            id: request.id,
            kind: "select" as const,
            value,
          },
          source: "head" as const,
        };
      }),
  };
  const vetting: FirstPartyPlugin = {
    contributions: [...toolVettingPlugin.contributions],
    manifest: toolVettingPlugin.manifest,
  };
  const result = await withRuntime(
    {
      firstPartyPlugins: [vetting, toolPlugin("fixture-tools", [{ name: "alpha" }])],
      interactions: Layer.succeed(PluginInteractions, interactions),
    },
    (runtime) =>
      Effect.gen(function* () {
        const layer = yield* driverLayer(runtime, latestPromptAlphaProvider);
        return yield* Effect.gen(function* () {
          const driver = yield* Driver;
          const session = yield* driver.createSession();
          const initialId = (yield* runtime.currentGeneration).id;
          const oldTurn = yield* Effect.fork(driver.prompt(session.id, "old"));
          yield* Deferred.await(oldAsked);
          const reloading = yield* Effect.fork(Effect.either(runtime.reload));
          yield* awaitSwap(runtime, initialId);
          // The old gate's question is answered after the swap.
          yield* Deferred.succeed(oldAnswer, "allow-for-session");
          yield* Fiber.join(oldTurn);
          const reload = yield* Fiber.join(reloading);
          yield* driver.prompt(session.id, "fresh");
          const snapshot = yield* driver.getSnapshot(session.id);
          return {
            fresh: toolResultFor(snapshot, callIdFor("fresh")),
            old: toolResultFor(snapshot, callIdFor("old")),
            reload,
          };
        }).pipe(
          Effect.provide(layer),
          // As the Heads do: the code driving the Driver supplies PluginInteractions.
          Effect.provide(Layer.succeed(PluginInteractions, interactions)),
        );
      }),
  );

  expect(result.reload._tag).toBe("Right");
  expect(result.old).toMatchObject({ content: "alpha-result" });
  expect(requests).toHaveLength(2);
  expect(result.fresh).toMatchObject({
    content: "Tool alpha rejected by vetting gate.",
    isError: true,
  });
});

test.each([
  ["fails", "fail"],
  ["is rejected by its gate", "reject"],
  ["is aborted", "abort"],
] as const)(
  "a Tool call that %s releases its Generation lease, and the runtime still closes",
  async (_label, exit) => {
    const gate = makeToolGate();
    const held = Effect.zipRight(
      Deferred.succeed(gate.entered, undefined),
      Deferred.await(gate.release),
    );
    const plugin: FirstPartyPlugin = {
      contributions: [
        defineToolContribution({
          description: "Alpha.",
          execute: (_arguments, context) =>
            exit === "reject"
              ? Effect.succeed({ content: "alpha-ran" })
              : held.pipe(
                  Effect.zipRight(
                    exit === "fail"
                      ? Effect.fail(
                          new ToolContributionError({
                            message: "alpha failed.",
                            toolCallId: context.toolCallId ?? "unknown",
                            toolName: "alpha",
                          }),
                        )
                      : Effect.succeed({ content: "alpha-ran" }),
                  ),
                ),
          name: "alpha",
          parameters: Schema.Struct({}),
        }),
        ...(exit === "reject"
          ? [
              defineHookContribution({
                mergeClass: "FirstWins",
                name: "held-gate",
                point: "tool-call-gate",
                run: () =>
                  held.pipe(
                    Effect.as({ decision: "block" as const, reason: "Blocked by the test gate." }),
                  ),
              }),
            ]
          : []),
      ],
      manifest: { capabilities: [], name: "lease-exit-fixture", version: "1.0.0" },
    };
    const result = await withRuntime({ firstPartyPlugins: [plugin] }, (runtime) =>
      Effect.gen(function* () {
        const layer = yield* driverLayer(runtime, scriptedAlphaProvider());
        return yield* Effect.gen(function* () {
          const driver = yield* Driver;
          const session = yield* driver.createSession();
          const turn = yield* Effect.fork(driver.prompt(session.id, "held"));
          yield* Deferred.await(gate.entered);
          const inFlightWhileRunning = (yield* runtime.debugInfo).inFlight;
          if (exit === "abort") {
            yield* driver.abortTurn(session.id);
          } else {
            yield* Deferred.succeed(gate.release, undefined);
          }
          const settled = yield* Fiber.join(turn);
          return {
            inFlightAfter: (yield* runtime.debugInfo).inFlight,
            inFlightWhileRunning,
            settled,
            toolResult: toolResultFor(yield* driver.getSnapshot(session.id), callIdFor("held")),
          };
        }).pipe(Effect.provide(layer));
      }),
    );

    expect(result.inFlightWhileRunning).toBe(1);
    expect(result.inFlightAfter).toBe(0);
    expect(result.toolResult).toMatchObject({
      content:
        exit === "fail"
          ? "alpha failed."
          : exit === "reject"
            ? "Blocked by the test gate."
            : "Tool execution interrupted.",
      isError: true,
    });
    if (exit === "abort") {
      expect(result.settled).toEqual({ stopReason: "aborted" });
    }
  },
);

test("within one Generation, the vetting gate's allow-for-session still skips the prompt for that Session's later calls", async () => {
  const requests: Array<string> = [];
  const interactions: PluginInteractionsService = {
    request: (request) =>
      Effect.sync(() => {
        requests.push(request.id);
        return {
          response: {
            _tag: "interaction-response" as const,
            id: request.id,
            kind: "select" as const,
            value: requests.length === 1 ? "allow-for-session" : "reject",
          },
          source: "head" as const,
        };
      }),
  };
  const vetting: FirstPartyPlugin = {
    contributions: [...toolVettingPlugin.contributions],
    manifest: toolVettingPlugin.manifest,
  };
  const result = await withRuntime(
    {
      firstPartyPlugins: [vetting, toolPlugin("fixture-tools", [{ name: "alpha" }])],
      interactions: Layer.succeed(PluginInteractions, interactions),
    },
    (runtime) =>
      Effect.gen(function* () {
        const layer = yield* driverLayer(runtime, latestPromptAlphaProvider);
        return yield* Effect.gen(function* () {
          const driver = yield* Driver;
          const session = yield* driver.createSession();
          const other = yield* driver.createSession();
          yield* driver.prompt(session.id, "first");
          yield* driver.prompt(session.id, "second");
          yield* driver.prompt(other.id, "other");
          return {
            first: toolResultFor(yield* driver.getSnapshot(session.id), callIdFor("first")),
            other: toolResultFor(yield* driver.getSnapshot(other.id), callIdFor("other")),
            second: toolResultFor(yield* driver.getSnapshot(session.id), callIdFor("second")),
          };
        }).pipe(
          Effect.provide(layer),
          // As the Heads do: the code driving the Driver supplies PluginInteractions.
          Effect.provide(Layer.succeed(PluginInteractions, interactions)),
        );
      }),
  );

  // One prompt for the Session's first call; its second call is remembered; another Session asks again.
  expect(requests).toHaveLength(2);
  expect(result.first).toMatchObject({ content: "alpha-result" });
  expect(result.second).toMatchObject({ content: "alpha-result" });
  expect(result.other).toMatchObject({
    content: "Tool alpha rejected by vetting gate.",
    isError: true,
  });
});

test("a reload whose fresh Tool adaptation fails keeps the current Generation and its Tool", async () => {
  const plugin: { -readonly [K in keyof FirstPartyPlugin]: FirstPartyPlugin[K] } = {
    contributions: [alphaTool("v1")],
    manifest: { capabilities: [], name: "adaptation-failure-fixture", version: "1.0.0" },
  };
  const result = await withRuntime({ firstPartyPlugins: [plugin] }, (runtime) =>
    Effect.gen(function* () {
      const initialId = (yield* runtime.debugInfo).currentGenerationId;
      plugin.contributions = [alphaTool("v2")];
      const adaptationFailure = new ContributionRegistryError({
        key: null,
        kind: "tool",
        message: "Injected Tool adaptation failure.",
        reason: "payload_invalid",
      });
      const spy = vi
        .spyOn(toolAdapter, "adaptTools")
        .mockImplementationOnce(() => Effect.fail(adaptationFailure));
      const outcome = yield* runtime.reload.pipe(
        Effect.either,
        Effect.ensuring(Effect.sync(() => spy.mockRestore())),
      );
      const currentId = (yield* runtime.debugInfo).currentGenerationId;
      const tool = runtime.toolRegistry.get("alpha");
      if (tool === undefined) {
        return yield* Effect.die("The current Generation lost alpha after adaptation failed.");
      }
      const executed = yield* Effect.scoped(
        tool.execute(
          {},
          {
            changeGoal: () => Effect.die("Unexpected changeGoal call."),
            getGoal: () => Effect.succeed(undefined),
            sessionId: sessionA,
          },
        ),
      );
      return { currentId, executed, initialId, outcome };
    }),
  );
  expect(result.outcome._tag).toBe("Left");
  if (result.outcome._tag === "Left") {
    expect(result.outcome.left).toBeInstanceOf(InvokeCommandError);
    expect(result.outcome.left).toMatchObject({
      commandName: "reload",
      reason: "command_failed",
      message: expect.stringContaining("Tool adaptation failed"),
      cause: expect.any(ContributionRegistryError),
    });
    expect((result.outcome.left as InvokeCommandError).message).toContain(
      "Injected Tool adaptation failure.",
    );
  }
  expect(result.currentId).toBe(result.initialId);
  expect(result.executed).toEqual({ content: "alpha-v1" });
});
