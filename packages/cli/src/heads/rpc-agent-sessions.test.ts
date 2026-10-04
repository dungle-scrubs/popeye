/**
 * Covers the rpc create agent field through the session bridge (RFC-04 §4,
 * issue #55): an Agent create resolves the definition per Session (persona,
 * model preference, Tool filter) before its response, a create without the
 * field is unchanged, failures create no Session, fork copies an Agent
 * Session's binding (installed before the copy, so a failed copy leaves a
 * restricted child), close drops it, resume with the field binds again before
 * recovery, and the rpc Head maps AgentSessionError onto the agent_error wire
 * code. These are manually assembled integrations
 * over makeCliRuntime and the real Driver; the production composition root is
 * covered by entry/rpc-agent.test.ts.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import {
  createMemoryJournalBacking,
  EntryDraftSchema,
  Journal,
  JournalError,
  JournalMemory,
  type SessionId,
  SessionIdSchema,
} from "@dungle-scrubs/popeye-journal";
import {
  appendOperationStarted,
  appendToolStarted,
  OperationIdSchema,
  type RecoveryReport,
} from "@dungle-scrubs/popeye-kernel";
import { defineToolContribution } from "@dungle-scrubs/popeye-plugins";
import { Data, Effect, Layer, Logger, Schema, Stream } from "effect";
import { expect, test } from "vitest";

import type { AgentDiscoveryResult } from "../agents/loader.js";
import { type AgentSessionResolver, makeAgentSessionResolver } from "../agents/session-agent.js";
import {
  Driver,
  GenerationDriverDefault,
  Provider,
  type ProviderService,
  ToolRegistry,
} from "../compose.js";
import { type CliRuntime, makeCliRuntime } from "../plugins/runtime.js";
import { composeToolGrantFilter, type ToolGrantFilter } from "../tools/grants.js";
import { SessionToolGrants } from "../tools/session-grants.js";
import type { HeadWriter } from "./head-wire.js";
import { PluginInteractionsRpcLive, RpcInteractionsLive, runRpcHead } from "./rpc.js";
import {
  type BridgeCommand,
  makeRpcSessionBridge,
  type RpcSessionBridge,
} from "./rpc-session-bridge.js";

const PERSONA = "Reviewer persona body.";

/** What the Provider saw for one prompt: the model preference, system items, and offered Tools. */
interface Offer {
  readonly model: string | undefined;
  readonly system: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<string>;
}

const recordingProvider = (): {
  readonly offers: Map<string, Offer>;
  readonly provider: ProviderService;
} => {
  const offers = new Map<string, Offer>();
  return {
    offers,
    provider: {
      streamAssistant: (context, options) => {
        const prompt = [...context].reverse().find((item) => item.role === "user")?.content ?? "";
        offers.set(prompt, {
          model: options.model,
          system: context.filter((item) => item.role === "system").map((item) => item.content),
          tools: (options.tools ?? []).map((tool) => tool.name).sort(),
        });
        return Stream.fromIterable([
          { _tag: "textDelta" as const, text: "ok" },
          { _tag: "done" as const, stopReason: "done" as const },
        ]);
      },
    },
  };
};

const discoveryWith = (
  entries: ReadonlyArray<{
    readonly model?: string;
    readonly name: string;
    readonly tools?: ReadonlyArray<string>;
  }>,
): AgentDiscoveryResult => ({
  agents: new Map(
    entries.map((entry) => [
      entry.name,
      {
        body: PERSONA,
        description: "test agent",
        filePath: `/agents/${entry.name}.md`,
        model: entry.model,
        name: entry.name,
        scope: "user" as const,
        tools: entry.tools,
      },
    ]),
  ),
  diagnostics: [],
});

const REVIEWER = discoveryWith([{ model: "agent-model", name: "reviewer", tools: ["alpha"] }]);

const agentFilter = (tools: ReadonlyArray<string>): ToolGrantFilter | undefined =>
  composeToolGrantFilter({
    access: undefined,
    agentTools: tools,
    excludeTools: [],
    isolation: undefined,
    tools: [],
  });

type SentFrame = Readonly<Record<string, unknown>> & {
  readonly id?: string;
  readonly result?: Readonly<Record<string, unknown>>;
};

interface Harness {
  readonly bridge: ReturnType<typeof makeRpcSessionBridge>;
  readonly driver: Driver["Type"];
  /** The Session's Tool grant filters read when its snapshot response was sent, by frame id. */
  readonly filtersAtResponse: Map<string, ReadonlyArray<ToolGrantFilter>>;
  readonly journal: Journal["Type"];
  readonly offers: Map<string, Offer>;
  /** Every recovery report the Driver's resume produced, oldest first. */
  readonly recoveryReports: Array<RecoveryReport>;
  /** Sends one frame through the bridge and returns its response frame. */
  readonly request: (command: BridgeCommand) => Effect.Effect<SentFrame | undefined, unknown>;
  readonly runtime: CliRuntime;
  readonly sent: Array<SentFrame>;
}

/** A CLI runtime whose first-party Plugin contributes alpha and beta, a real Driver, and the bridge. */
const withAgentBridge = <A>(
  options: {
    readonly agents?: (runtime: CliRuntime) => AgentSessionResolver;
    readonly discovery?: AgentDiscoveryResult;
    readonly modelSource?: "agent" | "env" | "flag";
    /** Wraps the Driver the bridge calls; `bridge` returns the bridge under test. */
    readonly wrapDriver?: (
      driver: Driver["Type"],
      bridge: () => RpcSessionBridge,
    ) => Driver["Type"];
    /** Wraps the Journal the Driver writes, for fault injection. */
    readonly wrapJournal?: (journal: Journal["Type"]) => Journal["Type"];
  },
  body: (harness: Harness) => Effect.Effect<A, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "popeye-rpc-agent-sessions-"))),
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
                manifest: { capabilities: [], name: "agent-fixture-tools", version: "1.0.0" },
              },
            ],
            noProjectPlugins: true,
            pluginPaths: [],
            projectPath,
          });
          const { offers, provider } = recordingProvider();
          const generation = yield* runtime.currentGeneration;
          const recoveryReports: Array<RecoveryReport> = [];
          const memoryJournal = JournalMemory(createMemoryJournalBacking());
          const wrapJournal = options.wrapJournal;
          const journalLayer =
            wrapJournal === undefined
              ? memoryJournal
              : Layer.effect(Journal, Effect.map(Journal, wrapJournal)).pipe(
                  Layer.provide(memoryJournal),
                );
          const layer = Layer.mergeAll(
            GenerationDriverDefault(generation, {
              sessions: {
                recoveryDiagnosticSink: (report) => Effect.sync(() => recoveryReports.push(report)),
              },
            }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  journalLayer,
                  Layer.succeed(Provider, provider),
                  Layer.succeed(ToolRegistry, runtime.toolRegistry),
                ),
              ),
            ),
            journalLayer,
            Layer.succeed(SessionToolGrants, runtime.sessionToolGrants),
          );
          return yield* Effect.gen(function* () {
            const baseDriver = yield* Driver;
            const journal = yield* Journal;
            let bridgeUnderTest: RpcSessionBridge | undefined;
            const currentBridge = (): RpcSessionBridge => {
              if (bridgeUnderTest === undefined) {
                throw new Error("The bridge is not built yet.");
              }
              return bridgeUnderTest;
            };
            const driver = options.wrapDriver?.(baseDriver, currentBridge) ?? baseDriver;
            const sent: Array<SentFrame> = [];
            const filtersAtResponse = new Map<string, ReadonlyArray<ToolGrantFilter>>();
            const transport = {
              send: (payload: unknown) =>
                Effect.gen(function* () {
                  const frame = payload as SentFrame;
                  const sessionId = frame.result?.sessionId;
                  if (
                    frame.id !== undefined &&
                    frame.result?._tag === "snapshot" &&
                    typeof sessionId === "string"
                  ) {
                    filtersAtResponse.set(
                      frame.id,
                      yield* runtime.sessionToolGrants.filtersFor(sessionId as SessionId),
                    );
                  }
                  sent.push(frame);
                }),
            };
            const resolver =
              options.agents?.(runtime) ??
              makeAgentSessionResolver({
                discover: Effect.succeed(options.discovery ?? REVIEWER),
                grantedToolNames: runtime.toolRegistry
                  .view(SessionIdSchema.make("startup-toolcount"))
                  .pipe(Effect.map((view) => new Set(view.list().map((tool) => tool.name)))),
                modelSource: options.modelSource ?? "env",
                unresolvedModelMessage: () => undefined,
              });
            const bridge = makeRpcSessionBridge({
              agents: resolver,
              driver,
              interactions: {
                attach: () => Effect.succeed([]),
                detach: () => Effect.void,
              } as unknown as Parameters<typeof makeRpcSessionBridge>[0]["interactions"],
              transport,
            });
            bridgeUnderTest = bridge;
            const request: Harness["request"] = (command) =>
              bridge
                .handle(command)
                .pipe(
                  Effect.zipRight(Effect.sync(() => sent.find((frame) => frame.id === command.id))),
                );
            return yield* body({
              bridge,
              driver,
              filtersAtResponse,
              journal,
              offers,
              recoveryReports,
              request,
              runtime,
              sent,
            });
          }).pipe(Effect.provide(layer), Effect.ensuring(runtime.close));
        }),
      (projectPath) => Effect.promise(() => rm(projectPath, { force: true, recursive: true })),
    ),
  );

const createdSessionId = (frame: SentFrame | undefined): string => {
  const sessionId = frame?.result?.sessionId;
  if (typeof sessionId !== "string") {
    throw new Error(`Expected a snapshot response, received ${JSON.stringify(frame)}.`);
  }
  return sessionId;
};

const prompt = (harness: Harness, sessionId: string, content: string) =>
  harness.request({ _tag: "prompt", content, id: `prompt-${content}`, sessionId });

test("create with agent narrows the Session and binds persona and model before its response", async () => {
  const result = await withAgentBridge({}, (harness) =>
    Effect.gen(function* () {
      const response = yield* harness.request({ _tag: "create", agent: "reviewer", id: "c-agent" });
      const sessionId = createdSessionId(response);
      yield* prompt(harness, sessionId, "agent-prompt");
      return { response, sessionId };
    }).pipe(
      Effect.map((value) => ({
        ...value,
        filters: harness.filtersAtResponse.get("c-agent"),
        offer: harness.offers.get("agent-prompt"),
      })),
    ),
  );

  expect(result.response).toMatchObject({
    id: "c-agent",
    result: { _tag: "snapshot", attached: false, sessionId: result.sessionId },
  });
  expect(result.filters).toEqual([agentFilter(["alpha"])]);
  expect(result.offer).toEqual({
    model: "agent-model",
    system: expect.arrayContaining([PERSONA]),
    tools: ["alpha"],
  });
});

test("create without agent behaves exactly as today", async () => {
  const result = await withAgentBridge({}, (harness) =>
    Effect.gen(function* () {
      const response = yield* harness.request({ _tag: "create", id: "c-plain" });
      const sessionId = createdSessionId(response);
      yield* prompt(harness, sessionId, "plain-prompt");
      const snapshot = yield* harness.driver.getSnapshot(sessionId as SessionId);
      return { response, snapshot };
    }).pipe(
      Effect.map((value) => ({
        ...value,
        filters: harness.filtersAtResponse.get("c-plain"),
        offer: harness.offers.get("plain-prompt"),
      })),
    ),
  );

  expect(Object.keys(result.response?.result ?? {}).sort()).toEqual(
    ["_tag", "attached", "entries", "leafEntryId", "phase", "revision", "sessionId"].sort(),
  );
  expect(result.filters).toEqual([]);
  expect(result.offer?.model).toBeUndefined();
  expect(result.offer?.system).not.toContain(PERSONA);
  expect(result.offer?.tools).toEqual(["alpha", "beta"]);
  expect(result.snapshot.model).toBeUndefined();
});

test("an Agent Session and a plain Session in one process hold their own views concurrently", async () => {
  const offers = await withAgentBridge({}, (harness) =>
    Effect.gen(function* () {
      const [agentResponse, plainResponse] = yield* Effect.all(
        [
          harness.request({ _tag: "create", agent: "reviewer", id: "c-agent" }),
          harness.request({ _tag: "create", id: "c-plain" }),
        ],
        { concurrency: "unbounded" },
      );
      yield* Effect.all(
        [
          prompt(harness, createdSessionId(agentResponse), "agent-prompt"),
          prompt(harness, createdSessionId(plainResponse), "plain-prompt"),
        ],
        { concurrency: "unbounded" },
      );
      return harness.offers;
    }),
  );

  expect(offers.get("agent-prompt")).toMatchObject({ model: "agent-model", tools: ["alpha"] });
  expect(offers.get("agent-prompt")?.system).toContain(PERSONA);
  expect(offers.get("plain-prompt")).toMatchObject({ model: undefined, tools: ["alpha", "beta"] });
  expect(offers.get("plain-prompt")?.system).not.toContain(PERSONA);
});

test("an unknown agent fails the create and creates no Session", async () => {
  const result = await withAgentBridge({}, (harness) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        harness.bridge.handle({ _tag: "create", agent: "ghost", id: "c-ghost" }),
      );
      return { error, sessions: yield* harness.driver.listSessions(), sent: harness.sent };
    }),
  );

  expect(result.error).toMatchObject({
    _tag: "AgentSessionError",
    agent: "ghost",
    available: ["reviewer"],
    message: 'Unknown agent "ghost". Available agents: reviewer (user).',
    reason: "unknown_agent",
  });
  expect(result.sessions).toEqual([]);
  expect(result.sent).toEqual([]);
});

test("a tools list the process grants none of fails the create closed and creates no Session", async () => {
  const result = await withAgentBridge(
    { discovery: discoveryWith([{ name: "reviewer", tools: ["ghost-tool"] }]) },
    (harness) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          harness.bridge.handle({ _tag: "create", agent: "reviewer", id: "c-closed" }),
        );
        return { error, sessions: yield* harness.driver.listSessions() };
      }),
  );

  expect(result.error).toMatchObject({
    _tag: "AgentSessionError",
    message:
      "Agent reviewer (/agents/reviewer.md) lists only tools this session does not grant: ghost-tool. The Session fails closed.",
    reason: "agent_tools_unknown",
    ungrantedTools: ["ghost-tool"],
  });
  expect(result.sessions).toEqual([]);
});

test("a partly ungranted tools list creates the Session with the granted subset and logs a diagnostic", async () => {
  const warnings: Array<{ readonly annotations: Record<string, unknown>; readonly text: string }> =
    [];
  const logger = Logger.make(({ annotations, logLevel, message }) => {
    if (logLevel._tag === "Warning") {
      warnings.push({
        annotations: Object.fromEntries(annotations),
        text: Array.isArray(message) ? message.join(" ") : String(message),
      });
    }
  });
  const result = await withAgentBridge(
    { discovery: discoveryWith([{ name: "reviewer", tools: ["alpha", "ghost-tool"] }]) },
    (harness) =>
      Effect.gen(function* () {
        const response = yield* harness.request({
          _tag: "create",
          agent: "reviewer",
          id: "c-partial",
        });
        const sessionId = createdSessionId(response);
        yield* prompt(harness, sessionId, "partial-prompt");
        return { offer: harness.offers.get("partial-prompt"), sessionId };
      }).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger))),
  );

  expect(result.offer?.tools).toEqual(["alpha"]);
  expect(warnings).toEqual([
    {
      annotations: {
        agent: "reviewer",
        diagnostic: "agent_tools_ungranted",
        sessionId: result.sessionId,
      },
      text: "Agent reviewer (/agents/reviewer.md) names tools this session does not grant: ghost-tool. The session runs with the granted subset: alpha.",
    },
  ]);
});

test("rpc fork of an Agent Session copies its filters, persona, and model; a plain fork copies nothing", async () => {
  const result = await withAgentBridge({}, (harness) =>
    Effect.gen(function* () {
      const agentId = createdSessionId(
        yield* harness.request({ _tag: "create", agent: "reviewer", id: "c-agent" }),
      );
      const plainId = createdSessionId(yield* harness.request({ _tag: "create", id: "c-plain" }));
      yield* prompt(harness, agentId, "agent-before-fork");
      yield* prompt(harness, plainId, "plain-before-fork");
      const agentLeaf = (yield* harness.driver.getSnapshot(agentId as SessionId)).leaf.id;
      const plainLeaf = (yield* harness.driver.getSnapshot(plainId as SessionId)).leaf.id;
      const agentChild = createdSessionId(
        yield* harness.request({
          _tag: "fork",
          fromEntryId: agentLeaf,
          id: "f-agent",
          sessionId: agentId,
        }),
      );
      const plainChild = createdSessionId(
        yield* harness.request({
          _tag: "fork",
          fromEntryId: plainLeaf,
          id: "f-plain",
          sessionId: plainId,
        }),
      );
      yield* prompt(harness, agentChild, "agent-child-prompt");
      yield* prompt(harness, plainChild, "plain-child-prompt");
      return {
        agentChildFilters: harness.filtersAtResponse.get("f-agent"),
        agentOffer: harness.offers.get("agent-child-prompt"),
        plainChildFilters: harness.filtersAtResponse.get("f-plain"),
        plainOffer: harness.offers.get("plain-child-prompt"),
      };
    }),
  );

  expect(result.agentChildFilters).toEqual([agentFilter(["alpha"])]);
  expect(result.agentOffer).toMatchObject({ model: "agent-model", tools: ["alpha"] });
  expect(result.agentOffer?.system).toContain(PERSONA);
  expect(result.plainChildFilters).toEqual([]);
  expect(result.plainOffer).toMatchObject({ model: undefined, tools: ["alpha", "beta"] });
  expect(result.plainOffer?.system).not.toContain(PERSONA);
});

test("a fork of an Agent Session whose copy fails leaves a child that keeps the Agent binding", async () => {
  const fault = { failAppendsExceptFor: undefined as string | undefined };
  const result = await withAgentBridge(
    {
      wrapJournal: (journal) => ({
        ...journal,
        appendEntry: (sessionId, draft) =>
          fault.failAppendsExceptFor !== undefined && sessionId !== fault.failAppendsExceptFor
            ? Effect.fail(
                new JournalError({
                  corruptionClass: "io_failure",
                  message: "Injected child-copy persistence failure.",
                }),
              )
            : journal.appendEntry(sessionId, draft),
      }),
    },
    (harness) =>
      Effect.gen(function* () {
        const agentId = createdSessionId(
          yield* harness.request({ _tag: "create", agent: "reviewer", id: "c-agent" }),
        );
        yield* prompt(harness, agentId, "agent-before-fork");
        const leaf = (yield* harness.driver.getSnapshot(agentId as SessionId)).leaf.id;
        fault.failAppendsExceptFor = agentId;
        const failure = yield* Effect.flip(
          harness.bridge.handle({
            _tag: "fork",
            fromEntryId: leaf,
            id: "f-agent",
            sessionId: agentId,
          }),
        );
        fault.failAppendsExceptFor = undefined;
        const leftover = (yield* harness.driver.listSessions()).filter(
          (session) => session.id !== agentId,
        );
        const childId = leftover[0]?.id;
        if (childId === undefined) {
          return { childFilters: undefined, failure, leftover, offer: undefined };
        }
        const childFilters = yield* harness.runtime.sessionToolGrants.filtersFor(childId);
        yield* prompt(harness, childId, "leftover-child-prompt");
        return {
          childFilters,
          failure,
          leftover,
          offer: harness.offers.get("leftover-child-prompt"),
        };
      }),
  );

  expect(result.failure).toMatchObject({ _tag: "JournalError", corruptionClass: "io_failure" });
  expect(result.leftover).toHaveLength(1);
  expect(result.childFilters).toEqual([agentFilter(["alpha"])]);
  expect(result.offer).toMatchObject({ model: "agent-model", tools: ["alpha"] });
  expect(result.offer?.system).toContain(PERSONA);
});

test("rpc close drops the persona and model with the filters, so a same-process resume is plain", async () => {
  const result = await withAgentBridge({}, (harness) =>
    Effect.gen(function* () {
      const sessionId = createdSessionId(
        yield* harness.request({ _tag: "create", agent: "reviewer", id: "c-agent" }),
      );
      yield* prompt(harness, sessionId, "before-close");
      const closed = yield* harness.request({ _tag: "close", id: "close-agent", sessionId });
      yield* harness.request({ _tag: "resume", id: "resume-agent", sessionId });
      yield* prompt(harness, sessionId, "after-resume");
      return {
        after: harness.offers.get("after-resume"),
        before: harness.offers.get("before-close"),
        closed,
        filters: yield* harness.runtime.sessionToolGrants.filtersFor(sessionId as SessionId),
      };
    }),
  );

  expect(result.closed).toMatchObject({ result: { _tag: "closed", cause: "clean" } });
  expect(result.before).toMatchObject({ model: "agent-model", tools: ["alpha"] });
  expect(result.filters).toEqual([]);
  expect(result.after).toMatchObject({ model: undefined, tools: ["alpha", "beta"] });
  expect(result.after?.system).not.toContain(PERSONA);
});

test("resume with agent after close carries the Agent's Tools, persona, and model again", async () => {
  const result = await withAgentBridge({}, (harness) =>
    Effect.gen(function* () {
      const sessionId = createdSessionId(
        yield* harness.request({ _tag: "create", agent: "reviewer", id: "c-agent" }),
      );
      yield* prompt(harness, sessionId, "before-close");
      yield* harness.request({ _tag: "close", id: "close-agent", sessionId });
      const resumed = yield* harness.request({
        _tag: "resume",
        agent: "reviewer",
        id: "r-agent",
        sessionId,
      });
      yield* prompt(harness, sessionId, "after-agent-resume");
      return {
        filters: harness.filtersAtResponse.get("r-agent"),
        offer: harness.offers.get("after-agent-resume"),
        resumed,
        sessionId,
      };
    }),
  );

  expect(result.resumed).toMatchObject({
    id: "r-agent",
    result: { _tag: "snapshot", attached: false, sessionId: result.sessionId },
  });
  expect(result.filters).toEqual([agentFilter(["alpha"])]);
  expect(result.offer).toMatchObject({ model: "agent-model", tools: ["alpha"] });
  expect(result.offer?.system).toContain(PERSONA);
});

test("resume with an unknown agent fails with the --agent message and leaves the Session unresumed", async () => {
  const result = await withAgentBridge({}, (harness) =>
    Effect.gen(function* () {
      const sessionId = createdSessionId(
        yield* harness.request({ _tag: "create", agent: "reviewer", id: "c-agent" }),
      );
      yield* harness.request({ _tag: "close", id: "close-agent", sessionId });
      const error = yield* Effect.either(
        harness.bridge.handle({ _tag: "resume", agent: "ghost", id: "r-ghost", sessionId }),
      );
      const promptFailure = yield* Effect.either(
        harness.bridge.handle({ _tag: "prompt", content: "x", id: "p-after", sessionId }),
      );
      return {
        error,
        filters: yield* harness.runtime.sessionToolGrants.filtersFor(sessionId as SessionId),
        promptFailure,
        resumeResponse: harness.sent.find((frame) => frame.id === "r-ghost"),
      };
    }),
  );

  expect(result.error).toMatchObject({
    _tag: "Left",
    left: {
      _tag: "AgentSessionError",
      agent: "ghost",
      available: ["reviewer"],
      message: 'Unknown agent "ghost". Available agents: reviewer (user).',
      reason: "unknown_agent",
    },
  });
  expect(result.resumeResponse).toBeUndefined();
  expect(result.filters).toEqual([]);
  expect(result.promptFailure).toMatchObject({
    _tag: "Left",
    left: { _tag: "MailboxSessionNotFound" },
  });
});

test("resume with agent binds before recovery, so recovery classifies against the Agent's Tools", async () => {
  const result = await withAgentBridge({}, (harness) =>
    Effect.gen(function* () {
      // Two stored Sessions, each interrupted inside a replay-safe beta call (beta is outside
      // the reviewer's tools list, which names only alpha).
      const interrupted = (label: string) =>
        Effect.gen(function* () {
          const session = yield* harness.journal.createSession();
          const operationId = OperationIdSchema.make(`operation-${label}`);
          const userPrompt = yield* harness.journal.appendEntry(
            session.id,
            EntryDraftSchema.make({ kind: "message", payload: { content: label, role: "user" } }),
          );
          yield* appendOperationStarted(harness.journal, session.id, {
            intent: "turn",
            operationId,
            promptEntryId: userPrompt.id,
            turnOrdinal: 1,
          });
          yield* harness.journal.appendEntry(
            session.id,
            EntryDraftSchema.make({
              kind: "message",
              payload: {
                content: "",
                role: "assistant",
                stopReason: "toolCalls",
                toolCalls: [{ argumentsJson: "{}", id: `call-${label}`, name: "beta" }],
              },
            }),
          );
          yield* appendToolStarted(harness.journal, session.id, {
            operationId,
            replay: "safe",
            toolCallId: `call-${label}`,
            toolName: "beta",
          });
          return session.id;
        });
      const agentStored = yield* interrupted("agent");
      const plainStored = yield* interrupted("plain");
      yield* harness.request({
        _tag: "resume",
        agent: "reviewer",
        id: "r-agent",
        sessionId: agentStored,
      });
      yield* harness.request({ _tag: "resume", id: "r-plain", sessionId: plainStored });
      return harness.recoveryReports;
    }),
  );

  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({
    actions: [{ action: "synthesized_missing_tool", replay: "safe", toolName: "beta" }],
    safeReplay: [],
  });
  expect(result[1]).toMatchObject({
    actions: [{ action: "safe_replay", replay: "safe", toolName: "beta" }],
    safeReplay: [{ name: "beta" }],
  });
});

test("resume with agent of a Session that already holds a binding fails and keeps that binding", async () => {
  const result = await withAgentBridge(
    {
      discovery: discoveryWith([
        { model: "agent-model", name: "reviewer", tools: ["alpha"] },
        { model: "other-model", name: "other", tools: ["beta"] },
      ]),
    },
    (harness) =>
      Effect.gen(function* () {
        const sessionId = createdSessionId(
          yield* harness.request({ _tag: "create", agent: "reviewer", id: "c-agent" }),
        );
        const error = yield* Effect.either(
          harness.bridge.handle({ _tag: "resume", agent: "other", id: "r-other", sessionId }),
        );
        yield* prompt(harness, sessionId, "after-refused-resume");
        return {
          error,
          filters: yield* harness.runtime.sessionToolGrants.filtersFor(sessionId as SessionId),
          offer: harness.offers.get("after-refused-resume"),
          resumeResponse: harness.sent.find((frame) => frame.id === "r-other"),
          sessionId,
        };
      }),
  );

  expect(result.error).toMatchObject({
    _tag: "Left",
    left: {
      _tag: "AgentSessionError",
      agent: "other",
      message: `Session ${result.sessionId} already holds an Agent binding in this process: close it, then resume it with agent "other".`,
      reason: "agent_session_bound",
    },
  });
  expect(result.resumeResponse).toBeUndefined();
  expect(result.filters).toEqual([agentFilter(["alpha"])]);
  expect(result.offer).toMatchObject({ model: "agent-model", tools: ["alpha"] });
});

test("resume with agent of a Session the Journal does not hold fails as today and binds nothing", async () => {
  const result = await withAgentBridge({}, (harness) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        harness.bridge.handle({
          _tag: "resume",
          agent: "reviewer",
          id: "r-missing",
          sessionId: "missing-session",
        }),
      );
      return {
        error,
        filters: yield* harness.runtime.sessionToolGrants.filtersFor(
          "missing-session" as SessionId,
        ),
      };
    }),
  );

  expect(result.error).toMatchObject({
    _tag: "JournalNotFound",
    id: "missing-session",
    what: "session",
  });
  expect(result.filters).toEqual([]);
});

test("resume with agent whose recovery fails keeps the binding on the activated Session", async () => {
  const fault = { failRecordsFor: undefined as string | undefined };
  const result = await withAgentBridge(
    {
      wrapJournal: (journal) => ({
        ...journal,
        readRecords: (sessionId) =>
          sessionId === fault.failRecordsFor
            ? Effect.fail(
                new JournalError({
                  corruptionClass: "io_failure",
                  message: "Injected recovery read failure.",
                }),
              )
            : journal.readRecords(sessionId),
      }),
    },
    (harness) =>
      Effect.gen(function* () {
        const stored = (yield* harness.journal.createSession()).id;
        fault.failRecordsFor = stored;
        const error = yield* Effect.either(
          harness.bridge.handle({
            _tag: "resume",
            agent: "reviewer",
            id: "r-agent",
            sessionId: stored,
          }),
        );
        fault.failRecordsFor = undefined;
        // The failed recovery left the mailbox active, so the Session accepts a prompt; it must
        // run with the Agent binding, never with the process view.
        yield* prompt(harness, stored, "after-failed-recovery");
        return {
          error,
          filters: yield* harness.runtime.sessionToolGrants.filtersFor(stored),
          offer: harness.offers.get("after-failed-recovery"),
          resumeResponse: harness.sent.find((frame) => frame.id === "r-agent"),
        };
      }),
  );

  expect(result.error).toMatchObject({
    _tag: "Left",
    left: { _tag: "JournalError", corruptionClass: "io_failure" },
  });
  expect(result.resumeResponse).toBeUndefined();
  expect(result.filters).toEqual([agentFilter(["alpha"])]);
  expect(result.offer).toMatchObject({ model: "agent-model", tools: ["alpha"] });
  expect(result.offer?.system).toContain(PERSONA);
});

test("a close that releases the binding while an Agent resume runs leaves the Session closed", async () => {
  const race = { closeDuringResume: false };
  const result = await withAgentBridge(
    {
      wrapDriver: (driver, bridge) => ({
        ...driver,
        resumeSession: (sessionId) =>
          race.closeDuringResume
            ? Effect.sync(() => {
                race.closeDuringResume = false;
              }).pipe(
                // A close control frame for the same Session lands after the bind and before
                // the Driver activates the Session.
                Effect.zipRight(
                  Effect.orDie(bridge().handle({ _tag: "close", id: "race-close", sessionId })),
                ),
                Effect.zipRight(driver.resumeSession(sessionId)),
              )
            : driver.resumeSession(sessionId),
      }),
    },
    (harness) =>
      Effect.gen(function* () {
        const sessionId = createdSessionId(
          yield* harness.request({ _tag: "create", agent: "reviewer", id: "c-agent" }),
        );
        yield* harness.request({ _tag: "close", id: "close-agent", sessionId });
        race.closeDuringResume = true;
        const error = yield* Effect.either(
          harness.bridge.handle({ _tag: "resume", agent: "reviewer", id: "r-race", sessionId }),
        );
        const promptFailure = yield* Effect.either(
          harness.bridge.handle({ _tag: "prompt", content: "x", id: "p-race", sessionId }),
        );
        return {
          error,
          filters: yield* harness.runtime.sessionToolGrants.filtersFor(sessionId as SessionId),
          promptFailure,
          resumeResponse: harness.sent.find((frame) => frame.id === "r-race"),
          sessionId,
        };
      }),
  );

  expect(result.error).toMatchObject({
    _tag: "Left",
    left: {
      _tag: "AgentSessionError",
      agent: "reviewer",
      message: `Session ${result.sessionId} was closed while it resumed as agent "reviewer": it is closed again and holds no binding.`,
      reason: "agent_binding_lost",
    },
  });
  expect(result.resumeResponse).toBeUndefined();
  expect(result.filters).toEqual([]);
  expect(result.promptFailure).toMatchObject({
    _tag: "Left",
    left: { _tag: "MailboxSessionNotFound" },
  });
});

test("set-model after an Agent create wins over the Agent model and keeps the persona", async () => {
  const offer = await withAgentBridge({}, (harness) =>
    Effect.gen(function* () {
      const sessionId = createdSessionId(
        yield* harness.request({ _tag: "create", agent: "reviewer", id: "c-agent" }),
      );
      yield* harness.request({ _tag: "set-model", id: "m-1", model: "client-model", sessionId });
      yield* prompt(harness, sessionId, "after-set-model");
      return harness.offers.get("after-set-model");
    }),
  );

  expect(offer).toMatchObject({ model: "client-model", tools: ["alpha"] });
  expect(offer?.system).toContain(PERSONA);
});

test("--model on the process keeps an Agent Session on the process model", async () => {
  const offer = await withAgentBridge({ modelSource: "flag" }, (harness) =>
    Effect.gen(function* () {
      const sessionId = createdSessionId(
        yield* harness.request({ _tag: "create", agent: "reviewer", id: "c-agent" }),
      );
      yield* prompt(harness, sessionId, "flag-model-prompt");
      return harness.offers.get("flag-model-prompt");
    }),
  );

  expect(offer).toMatchObject({ model: undefined, tools: ["alpha"] });
  expect(offer?.system).toContain(PERSONA);
});

/** A Driver stub that counts the Session-starting calls a failed Agent frame must never make. */
const countingDriver = () => {
  const calls = { createSession: 0, resumeSession: 0 };
  const driver = {
    createSession: () =>
      Effect.sync(() => {
        calls.createSession += 1;
        return { id: "never" };
      }),
    getSnapshot: () => Effect.dieMessage("No Session may start: getSnapshot must not run."),
    resumeSession: () =>
      Effect.sync(() => {
        calls.resumeSession += 1;
        return { id: "never" };
      }),
  } as unknown as Parameters<typeof makeRpcSessionBridge>[0]["driver"];
  return { calls, driver };
};

test.each([
  ["create", { _tag: "create", agent: "reviewer", id: "c-agent" }],
  ["resume", { _tag: "resume", agent: "reviewer", id: "r-agent", sessionId: "stored-session" }],
] as const)(
  "an agent field on a bridge without a resolver fails the %s with agents_unavailable",
  async (command, frame) => {
    const { calls, driver } = countingDriver();
    const sent: Array<unknown> = [];
    const bridge = makeRpcSessionBridge({
      driver,
      interactions: {} as unknown as Parameters<typeof makeRpcSessionBridge>[0]["interactions"],
      transport: { send: (payload) => Effect.sync(() => void sent.push(payload)) },
    });
    const error = await Effect.runPromise(Effect.flip(bridge.handle(frame)));

    expect(calls).toEqual({ createSession: 0, resumeSession: 0 });
    expect(sent).toEqual([]);
    expect(error).toEqual(
      expect.objectContaining({
        _tag: "AgentSessionError",
        agent: "reviewer",
        message: `Agent "reviewer" cannot be resolved: this rpc host resolves no Agent definitions. The ${command} fails closed.`,
        reason: "agents_unavailable",
      }),
    );
  },
);

test.each([
  ["create", { _tag: "create", agent: "reviewer", id: "c-agent" }],
  ["resume", { _tag: "resume", agent: "reviewer", id: "r-agent", sessionId: "stored-session" }],
] as const)(
  "a tools list on a bridge without a SessionToolGrants store fails the %s with agents_unavailable",
  async (command, frame) => {
    const { calls, driver } = countingDriver();
    const sent: Array<unknown> = [];
    const bridge = makeRpcSessionBridge({
      agents: makeAgentSessionResolver({
        discover: Effect.succeed(REVIEWER),
        grantedToolNames: Effect.succeed(new Set(["alpha", "beta"]) as ReadonlySet<string>),
        modelSource: "env",
        unresolvedModelMessage: () => undefined,
      }),
      driver,
      interactions: {} as unknown as Parameters<typeof makeRpcSessionBridge>[0]["interactions"],
      transport: { send: (payload) => Effect.sync(() => void sent.push(payload)) },
    });
    // No SessionToolGrants in context: the resolver succeeds with a restrictive plan.
    const error = await Effect.runPromise(Effect.flip(bridge.handle(frame)));

    expect(calls).toEqual({ createSession: 0, resumeSession: 0 });
    expect(sent).toEqual([]);
    expect(error).toEqual(
      expect.objectContaining({
        _tag: "AgentSessionError",
        agent: "reviewer",
        message: `Agent reviewer (/agents/reviewer.md) lists tools, but this rpc host keeps no per-Session Tool grants. The ${command} fails closed.`,
        reason: "agents_unavailable",
      }),
    );
  },
);

test("the rpc Head writes an unknown agent as an agent_error wire response", async () => {
  const chunks: Array<string> = [];
  const writer: HeadWriter = { write: (text) => Effect.sync(() => void chunks.push(text)) };
  const exitCode = await withAgentBridge({}, (harness) =>
    Effect.gen(function* () {
      const agents = makeAgentSessionResolver({
        discover: Effect.succeed(REVIEWER),
        grantedToolNames: Effect.succeed(new Set(["alpha", "beta"]) as ReadonlySet<string>),
        modelSource: "env",
        unresolvedModelMessage: () => undefined,
      });
      return yield* runRpcHead({
        agents,
        input: Readable.from(
          `${JSON.stringify({ _tag: "create", agent: "ghost", id: "c-ghost" })}\n`,
        ),
        writer,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RpcInteractionsLive,
            PluginInteractionsRpcLive.pipe(Layer.provide(RpcInteractionsLive)),
            Layer.succeed(Driver, harness.driver),
          ),
        ),
      );
    }),
  );
  const lines = chunks
    .join("")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  expect(exitCode).toBe(0);
  expect(lines).toEqual([
    {
      error: {
        code: "agent_error",
        details: {
          agent: "ghost",
          available: ["reviewer"],
          reason: "unknown_agent",
          tag: "AgentSessionError",
        },
        message: 'Unknown agent "ghost". Available agents: reviewer (user).',
      },
      id: "c-ghost",
    },
  ]);
});

test("an unresolvable Agent model returns agent_error and creates no Session", async () => {
  const chunks: Array<string> = [];
  const result = await withAgentBridge({}, (harness) =>
    Effect.gen(function* () {
      const agents = makeAgentSessionResolver({
        discover: Effect.succeed(REVIEWER),
        grantedToolNames: Effect.succeed(new Set(["alpha", "beta"]) as ReadonlySet<string>),
        modelSource: "env",
        unresolvedModelMessage: (modelId) => `Unknown pi-ai model groq/${modelId}.`,
      });
      const exitCode = yield* runRpcHead({
        agents,
        input: Readable.from(
          `${JSON.stringify({ _tag: "create", agent: "reviewer", id: "c-bad-model" })}\n`,
        ),
        writer: { write: (text) => Effect.sync(() => void chunks.push(text)) },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RpcInteractionsLive,
            PluginInteractionsRpcLive.pipe(Layer.provide(RpcInteractionsLive)),
            Layer.succeed(Driver, harness.driver),
            Layer.succeed(SessionToolGrants, harness.runtime.sessionToolGrants),
          ),
        ),
      );
      return { exitCode, sessions: yield* harness.driver.listSessions() };
    }),
  );
  expect(result).toEqual({ exitCode: 0, sessions: [] });
  expect(JSON.parse(chunks.join("").trim())).toEqual({
    id: "c-bad-model",
    error: {
      code: "agent_error",
      details: { agent: "reviewer", reason: "agent_model_unresolvable", tag: "AgentSessionError" },
      message:
        "Agent reviewer (/agents/reviewer.md): Unknown pi-ai model groq/agent-model. The Session fails closed.",
    },
  });
});

test("a failed close after a lost Agent resume binding keeps the active Session bound", async () => {
  const race = { resume: false, failClose: false };
  const result = await withAgentBridge(
    {
      wrapDriver: (driver, bridge) => ({
        ...driver,
        closeSession: (sessionId) =>
          race.failClose
            ? Effect.fail(
                new JournalError({
                  corruptionClass: "io_failure",
                  message: "injected close failure",
                }),
              )
            : driver.closeSession(sessionId),
        resumeSession: (sessionId) =>
          !race.resume
            ? driver.resumeSession(sessionId)
            : Effect.gen(function* () {
                race.resume = false;
                yield* bridge()
                  .handle({ _tag: "close", id: "race-close", sessionId })
                  .pipe(Effect.orDie);
                race.failClose = true;
                return yield* driver.resumeSession(sessionId);
              }),
      }),
    },
    (harness) =>
      Effect.gen(function* () {
        const sessionId = createdSessionId(
          yield* harness.request({ _tag: "create", agent: "reviewer", id: "c-agent" }),
        );
        yield* harness.request({ _tag: "close", id: "close-agent", sessionId });
        race.resume = true;
        const error = yield* Effect.either(
          harness.bridge.handle({ _tag: "resume", agent: "reviewer", id: "r-race", sessionId }),
        );
        yield* prompt(harness, sessionId, "after-failed-close");
        return {
          error,
          sessionId,
          filters: yield* harness.runtime.sessionToolGrants.filtersFor(sessionId as SessionId),
          offer: harness.offers.get("after-failed-close"),
        };
      }),
  );
  expect(result.filters).toEqual([agentFilter(["alpha"])]);
  expect(result.error).toMatchObject({
    _tag: "Left",
    left: {
      _tag: "AgentSessionError",
      reason: "agent_binding_lost",
      message: `Session ${result.sessionId} was closed while it resumed as agent "reviewer", and closing it again failed: it stays active with the Agent binding.`,
    },
  });
  expect(result.offer).toMatchObject({ model: "agent-model", tools: ["alpha"] });
  expect(result.offer?.system).toContain(PERSONA);
});

test("a tagged JournalNotFound from another package copy releases the resume binding", async () => {
  class ForeignJournalNotFound extends Data.TaggedError("JournalNotFound")<{
    readonly id: string;
    readonly what: "entry" | "session";
  }> {}
  const sessionId = "missing-cross-copy";
  const result = await withAgentBridge(
    {
      wrapDriver: (driver) => ({
        ...driver,
        resumeSession: () =>
          Effect.fail(new ForeignJournalNotFound({ what: "session", id: sessionId })),
      }),
    },
    (harness) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          harness.bridge.handle({ _tag: "resume", agent: "reviewer", sessionId }),
        );
        return {
          error,
          filters: yield* harness.runtime.sessionToolGrants.filtersFor(sessionId as SessionId),
        };
      }),
  );
  expect(result.error).toMatchObject({ _tag: "JournalNotFound", what: "session", id: sessionId });
  expect(result.filters).toEqual([]);
});
