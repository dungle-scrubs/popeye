/**
 * Covers per-Session Tool grant variation through the CLI Tool registry
 * (RFC-04 §5, issue #54). Two Sessions alive in one runtime hold their own
 * Tool views; a Session without filters keeps exactly the process-level view;
 * Session filters only narrow, survive a Plugin reload, and are dropped on
 * release; capability-gated Tools follow each Session's grant.
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
import { defineToolContribution, PluginInteractionsNullLive } from "@dungle-scrubs/popeye-plugins";
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { expect, test } from "vitest";

import {
  Driver,
  GenerationDriverDefault,
  Provider,
  type ProviderService,
  type SessionToolView,
  ToolRegistry,
} from "../compose.js";
import type { ToolGrantFilter } from "../tools/grants.js";
import type { FirstPartyPlugin } from "./pipeline.js";
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
    readonly firstPartyPlugins?: ReadonlyArray<FirstPartyPlugin>;
    readonly toolGrants?: ToolGrantFilter;
  },
  body: (runtime: CliRuntime) => Effect.Effect<A, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "popeye-cli-runtime-session-grants-"))),
      (projectPath) =>
        Effect.gen(function* () {
          const runtime = yield* makeCliRuntime({
            firstPartyPlugins: options.firstPartyPlugins ?? fixturePlugins,
            noProjectPlugins: true,
            pluginPaths: [],
            projectPath,
            ...(options.toolGrants === undefined ? {} : { toolGrants: options.toolGrants }),
          }).pipe(Effect.provide(PluginInteractionsNullLive));
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
