/**
 * Covers per-Session Tool grants through the RPC Head (RFC-04 §5, issue #54).
 * Two Sessions alive in one rpc process hold their own Tool views, Tool
 * execution follows each Session's view, and a successful rpc close releases
 * the closed Session's filters before its response, even when delivery fails
 * or is interrupted; a failed Driver close keeps them. The rpc wire gains no
 * field here: the test narrows a Session through the SessionToolGrants seam,
 * as #55 and #56 will. These are manually assembled RPC integrations: they
 * build the rpc layer themselves, so the production composition root is
 * checked separately (entry/head-runtime.test.ts).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import {
  createMemoryJournalBacking,
  JournalMemory,
  SessionIdSchema,
} from "@dungle-scrubs/popeye-journal";
import { defineToolContribution } from "@dungle-scrubs/popeye-plugins";
import { Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect";
import { expect, test } from "vitest";

import {
  Driver,
  GenerationDriverDefault,
  Provider,
  type ProviderService,
  ToolRegistry,
} from "../compose.js";
import { type CliRuntime, makeCliRuntime } from "../plugins/runtime.js";
import { makeSessionToolGrants, SessionToolGrants } from "../tools/session-grants.js";
import { HeadWriteError, type HeadWriter } from "./head-wire.js";
import { PluginInteractionsRpcLive, RpcInteractionsLive, runRpcHead } from "./rpc.js";
import { makeRpcSessionBridge } from "./rpc-session-bridge.js";

const idleProvider: ProviderService = {
  streamAssistant: () => Stream.empty,
};

const captureWriter = (): {
  readonly lines: () => ReadonlyArray<Record<string, unknown>>;
  readonly writer: HeadWriter;
} => {
  const chunks: Array<string> = [];
  return {
    lines: () =>
      chunks
        .join("")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    writer: { write: (text) => Effect.sync(() => void chunks.push(text)) },
  };
};

/** A CLI runtime whose first-party Plugin contributes the Tools alpha and beta. */
const withGrantRuntime = <A>(
  body: (runtime: CliRuntime) => Effect.Effect<A, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "popeye-rpc-session-grants-"))),
      (projectPath) =>
        Effect.gen(function* () {
          const runtime = yield* makeCliRuntime({
            firstPartyPlugins: [
              {
                contributions: ["alpha", "beta"].map((name) =>
                  defineToolContribution({
                    description: `Run ${name}.`,
                    execute: () => Effect.succeed({ content: `${name}-result` }),
                    name,
                    parameters: Schema.Struct({}),
                  }),
                ),
                manifest: { capabilities: [], name: "grant-fixture-tools", version: "1.0.0" },
              },
            ],
            noProjectPlugins: true,
            pluginPaths: [],
            projectPath,
          });
          return yield* body(runtime).pipe(Effect.ensuring(runtime.close));
        }),
      (projectPath) => Effect.promise(() => rm(projectPath, { force: true, recursive: true })),
    ),
  );

/** The rpc composition cli-entry builds, over the given runtime and Provider. */
const grantRpcLayer = (runtime: CliRuntime, provider: ProviderService) =>
  Effect.map(runtime.currentGeneration, (generation) =>
    Layer.mergeAll(
      GenerationDriverDefault(generation).pipe(
        Layer.provide(
          Layer.mergeAll(
            JournalMemory(createMemoryJournalBacking()),
            Layer.succeed(Provider, provider),
            Layer.succeed(ToolRegistry, runtime.toolRegistry),
          ),
        ),
      ),
      RpcInteractionsLive,
      PluginInteractionsRpcLive.pipe(Layer.provide(RpcInteractionsLive)),
      Layer.succeed(SessionToolGrants, runtime.sessionToolGrants),
    ),
  );

test("two rpc Sessions in one process hold their own Tool views and execution follows them", async () => {
  const offered = new Map<string, ReadonlyArray<string>>();
  const provider: ProviderService = {
    streamAssistant: (context, options) => {
      const last = context.at(-1);
      if (last !== undefined && last.role === "toolResult") {
        return Stream.fromIterable([{ _tag: "done" as const, stopReason: "done" as const }]);
      }
      const prompt = [...context].reverse().find((item) => item.role === "user")?.content ?? "";
      offered.set(prompt, (options.tools ?? []).map((tool) => tool.name).sort());
      return Stream.fromIterable([
        { _tag: "toolCall" as const, argumentsJson: "{}", id: `call-${prompt}`, name: "beta" },
        { _tag: "done" as const, stopReason: "toolCalls" as const },
      ]);
    },
  };
  const capture = captureWriter();

  const result = await withGrantRuntime((runtime) =>
    Effect.gen(function* () {
      const layer = yield* grantRpcLayer(runtime, provider);
      return yield* Effect.gen(function* () {
        const driver = yield* Driver;
        const sessionA = yield* driver.createSession();
        const sessionB = yield* driver.createSession();
        // #55 and #56 narrow a Session right after creating it; the test stands in for them.
        yield* runtime.sessionToolGrants.narrow(sessionB.id, {
          access: undefined,
          excludeTools: [],
          tools: ["alpha"],
        });
        const input = Readable.from(
          `${[
            { _tag: "prompt", content: "prompt-a", id: "prompt-a", sessionId: sessionA.id },
            { _tag: "prompt", content: "prompt-b", id: "prompt-b", sessionId: sessionB.id },
          ]
            .map((frame) => JSON.stringify(frame))
            .join("\n")}\n`,
        );
        const exitCode = yield* runRpcHead({ input, writer: capture.writer });
        const toolResult = (
          entries: ReadonlyArray<{ readonly payload: unknown }>,
          toolCallId: string,
        ): Record<string, unknown> | undefined =>
          entries
            .map((entry) => entry.payload as Record<string, unknown>)
            .find((payload) => payload.role === "toolResult" && payload.toolCallId === toolCallId);
        const snapshotA = yield* driver.getSnapshot(sessionA.id);
        const snapshotB = yield* driver.getSnapshot(sessionB.id);
        return {
          exitCode,
          resultA: toolResult(snapshotA.entries, "call-prompt-a"),
          resultB: toolResult(snapshotB.entries, "call-prompt-b"),
        };
      }).pipe(Effect.provide(layer));
    }),
  );

  expect(result.exitCode).toBe(0);
  expect(offered.get("prompt-a")).toEqual(["alpha", "beta"]);
  expect(offered.get("prompt-b")).toEqual(["alpha"]);
  expect(result.resultA).toMatchObject({ content: "beta-result" });
  expect(result.resultB).toMatchObject({ content: "Unknown tool: beta.", isError: true });
});

test("rpc close releases the closed Session's Tool grant filters and no other Session's", async () => {
  const capture = captureWriter();

  const result = await withGrantRuntime((runtime) =>
    Effect.gen(function* () {
      const layer = yield* grantRpcLayer(runtime, idleProvider);
      return yield* Effect.gen(function* () {
        const driver = yield* Driver;
        const kept = yield* driver.createSession();
        const closed = yield* driver.createSession();
        const narrowing = { access: undefined, excludeTools: [], tools: ["alpha"] };
        yield* runtime.sessionToolGrants.narrow(kept.id, narrowing);
        yield* runtime.sessionToolGrants.narrow(closed.id, narrowing);
        const input = Readable.from(
          `${JSON.stringify({ _tag: "close", id: "close-1", sessionId: closed.id })}\n`,
        );
        const exitCode = yield* runRpcHead({ input, writer: capture.writer });
        const closedView = yield* runtime.toolRegistry.view(closed.id);
        return {
          closedFilters: yield* runtime.sessionToolGrants.filtersFor(closed.id),
          closedView: closedView
            .list()
            .map((tool) => tool.name)
            .sort(),
          exitCode,
          keptFilters: yield* runtime.sessionToolGrants.filtersFor(kept.id),
        };
      }).pipe(Effect.provide(layer));
    }),
  );

  expect(result.exitCode).toBe(0);
  expect(capture.lines()).toMatchObject([
    { id: "close-1", result: { _tag: "closed", cause: "clean" } },
  ]);
  expect(result.closedFilters).toEqual([]);
  expect(result.closedView).toEqual(["alpha", "beta"]);
  expect(result.keptFilters).toEqual([{ access: undefined, excludeTools: [], tools: ["alpha"] }]);
});

const alphaOnly = { access: undefined, excludeTools: [], tools: ["alpha"] };

/**
 * Runs one rpc close through the session bridge with the given Driver close
 * and response transport, and returns the close Exit plus the closed
 * Session's filters afterwards.
 */
const closeThroughBridge = (options: {
  readonly closeSession: Effect.Effect<{ readonly drainedWithinGrace: boolean }, unknown>;
  readonly send: (sent: Deferred.Deferred<void>) => Effect.Effect<void, HeadWriteError>;
  readonly interruptAtDelivery?: boolean;
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const grants = yield* makeSessionToolGrants;
      const sessionId = SessionIdSchema.make("closing-session");
      yield* grants.narrow(sessionId, alphaOnly);
      const sent = yield* Deferred.make<void>();
      const bridge = makeRpcSessionBridge({
        driver: {
          closeSession: () => options.closeSession,
          // Issue 88: a close success also releases the Session's Turn options in the Kernel.
          releaseSessionTurnOptions: () => Effect.void,
        } as unknown as Parameters<typeof makeRpcSessionBridge>[0]["driver"],
        interactions: {
          attach: () => Effect.succeed([]),
          detach: () => Effect.void,
        } as unknown as Parameters<typeof makeRpcSessionBridge>[0]["interactions"],
        transport: { send: () => options.send(sent) },
      });
      const fiber = yield* Effect.fork(
        bridge
          .handle({ _tag: "close", id: "close-1", sessionId })
          .pipe(Effect.provideService(SessionToolGrants, grants)),
      );
      if (options.interruptAtDelivery === true) {
        yield* Deferred.await(sent);
        yield* Fiber.interrupt(fiber);
      }
      const exit = yield* Fiber.await(fiber);
      return { exit, filters: yield* grants.filtersFor(sessionId) };
    }),
  );

test("a successful close releases the Session's filters even when its response fails", async () => {
  const result = await closeThroughBridge({
    closeSession: Effect.succeed({ drainedWithinGrace: true }),
    send: (sent) =>
      Deferred.succeed(sent, undefined).pipe(
        Effect.zipRight(
          Effect.fail(new HeadWriteError({ cause: undefined, message: "consumer closed" })),
        ),
      ),
  });

  expect(Exit.isFailure(result.exit)).toBe(true);
  expect(result.filters).toEqual([]);
});

test("a successful close releases the Session's filters even when its response is interrupted", async () => {
  const result = await closeThroughBridge({
    closeSession: Effect.succeed({ drainedWithinGrace: true }),
    interruptAtDelivery: true,
    send: (sent) => Deferred.succeed(sent, undefined).pipe(Effect.zipRight(Effect.never)),
  });

  expect(Exit.isInterrupted(result.exit)).toBe(true);
  expect(result.filters).toEqual([]);
});

test("a failed Driver close keeps the Session's filters", async () => {
  const result = await closeThroughBridge({
    closeSession: Effect.fail(new Error("close failed")),
    send: (sent) => Deferred.succeed(sent, undefined),
  });

  expect(Exit.isFailure(result.exit)).toBe(true);
  expect(result.filters).toEqual([alphaOnly]);
});
