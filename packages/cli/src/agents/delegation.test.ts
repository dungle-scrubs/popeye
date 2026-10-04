/**
 * In-process coverage for the delegate Tool (RFC-04 §6, issue #56). Each test composes the
 * production wiring cli-entry uses: real Agent discovery over temporary directories,
 * `makeDelegation`, a CLI runtime whose first-party Plugins are a fixture Tool Plugin plus the
 * delegation Plugin, the generation Driver, and `withDelegation`. Scripted fake Providers answer
 * for the parent and every child, routed by the child's `Task: <task>` prompt (compaction
 * requests by their purpose), so every case is deterministic and offline.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMemoryJournalBacking,
  Journal,
  JournalMemory,
  type JournalService,
  JournalStore,
  type SessionId,
} from "@dungle-scrubs/popeye-journal";
import type {
  AssistantItem,
  ContextItem,
  ProviderStreamOptions,
} from "@dungle-scrubs/popeye-kernel";
import { defineToolContribution } from "@dungle-scrubs/popeye-plugins";
import { Deferred, Effect, Either, Fiber, Layer, Option, Schedule, Schema, Stream } from "effect";
import { afterEach, expect, test } from "vitest";

import {
  Driver,
  type DriverService,
  type DriverSnapshot,
  GenerationDriverDefault,
  Provider,
  type ProviderService,
  ToolRegistry,
  type TurnOptions,
} from "../compose.js";
import type { CliModelSource } from "../entry/config.js";
import type { FirstPartyPlugin } from "../features/first-party-suite.js";
import { type CliRuntime, makeCliRuntime } from "../plugins/runtime.js";
import { makeDelegation, withDelegation } from "./delegation.js";
import { discoverAgents } from "./loader.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const PARENT_PROMPT = "Parent prompt.";
const FIXTURE_TOOLS = ["alpha", "beta", "gamma"] as const;

const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const tempDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "popeye-delegation-"));
  temporaryDirectories.push(directory);
  return directory;
};

interface AgentFile {
  readonly body?: string;
  /** Extra frontmatter lines, each ending in a newline. */
  readonly frontmatter?: string;
  readonly name: string;
  readonly scope?: "project" | "user";
}

interface HarnessOptions {
  readonly agents: ReadonlyArray<AgentFile>;
  /** First-party Plugins composed beside the fixture Tools and the delegation Plugin. */
  readonly extraPlugins?: ReadonlyArray<FirstPartyPlugin>;
  readonly modelSource?: CliModelSource;
  readonly provider: ProviderService;
  /** A JSONL session directory; absent uses an in-memory Journal. */
  readonly sessionDir?: string;
  readonly thinkingLevel?: TurnOptions["thinkingLevel"];
  /** Wraps the Journal service the Driver uses (to hold a read at a chosen moment). */
  readonly wrapJournal?: (journal: JournalService) => JournalService;
}

interface Harness {
  readonly agentPaths: ReadonlyMap<string, string>;
  readonly driver: DriverService;
  readonly projectPath: string;
  readonly runtime: CliRuntime;
  /** The user-scope Agent directory; each delegate call discovers it again. */
  readonly userDir: string;
}

const fixtureToolsPlugin = {
  contributions: FIXTURE_TOOLS.map((name) =>
    defineToolContribution({
      description: `Run ${name}.`,
      execute: () => Effect.succeed({ content: `${name}-result` }),
      name,
      parameters: Schema.Struct({}),
    }),
  ),
  manifest: { capabilities: [], name: "delegation-fixture-tools", version: "1.0.0" },
};

const writeAgents = (
  agents: ReadonlyArray<AgentFile>,
  userDir: string,
  projectPath: string,
): ReadonlyMap<string, string> => {
  const paths = new Map<string, string>();
  for (const agent of agents) {
    const dir = agent.scope === "project" ? join(projectPath, ".popeye", "agents") : userDir;
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${agent.name}.md`);
    writeFileSync(
      filePath,
      `---\nname: ${agent.name}\ndescription: ${agent.name} agent\n${agent.frontmatter ?? ""}---\n${agent.body ?? ""}\n`,
      "utf8",
    );
    paths.set(agent.name, filePath);
  }
  return paths;
};

/** The composition cli-entry builds when at least one Agent definition is discoverable. */
const withHarness = <A>(
  options: HarnessOptions,
  body: (harness: Harness) => Effect.Effect<A, unknown>,
): Promise<A> => {
  const root = tempDirectory();
  const userDir = join(root, "user-agents");
  const projectPath = join(root, "project");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(join(projectPath, "sub"), { recursive: true });
  const agentPaths = writeAgents(options.agents, userDir, projectPath);
  const discover = discoverAgents({ projectPath, userDir });
  return Effect.runPromise(
    Effect.gen(function* () {
      const startup = yield* discover;
      const delegation = yield* makeDelegation({
        discover,
        modelSource: options.modelSource ?? "env",
        projectPath,
        startupAgents: startup.agents,
        thinkingLevel: options.thinkingLevel,
      });
      const runtime = yield* makeCliRuntime({
        firstPartyPlugins: [fixtureToolsPlugin, ...(options.extraPlugins ?? []), delegation.plugin],
        noProjectPlugins: true,
        pluginPaths: [],
        projectPath,
      });
      return yield* Effect.gen(function* () {
        const generation = yield* runtime.currentGeneration;
        const baseJournal =
          options.sessionDir === undefined
            ? JournalMemory(createMemoryJournalBacking())
            : JournalStore.selectLayer(options.sessionDir, {});
        const wrapJournal = options.wrapJournal;
        const journal =
          wrapJournal === undefined
            ? baseJournal
            : Layer.effect(Journal, Effect.map(Journal, wrapJournal)).pipe(
                Layer.provide(baseJournal),
              );
        const driver = withDelegation(
          GenerationDriverDefault(generation).pipe(
            Layer.provide(
              Layer.mergeAll(
                journal,
                Layer.succeed(Provider, options.provider),
                Layer.succeed(ToolRegistry, runtime.toolRegistry),
              ),
            ),
          ),
          delegation,
          { sessionToolGrants: runtime.sessionToolGrants, toolRegistry: runtime.toolRegistry },
        );
        return yield* Effect.gen(function* () {
          const service = yield* Driver;
          return yield* body({ agentPaths, driver: service, projectPath, runtime, userDir });
        }).pipe(Effect.provide(driver));
      }).pipe(Effect.ensuring(runtime.close));
    }),
  );
};

// ---------------------------------------------------------------------------
// Scripted Providers
// ---------------------------------------------------------------------------

interface RecordedRequest {
  readonly context: ReadonlyArray<ContextItem>;
  /** `compaction` for every compaction request, whichever Session made it. */
  readonly kind: "child" | "compaction" | "parent";
  readonly model: string | undefined;
  /** The Session the request is accounted to (`accountingScope.sessionId`). */
  readonly sessionId: SessionId | undefined;
  readonly system: ReadonlyArray<string>;
  /** The child's task text after `Task: `; empty for the parent. */
  readonly task: string;
  readonly thinkingLevel: string | undefined;
  readonly toolDescriptions: ReadonlyMap<string, string>;
  readonly tools: ReadonlyArray<string>;
}

interface DelegateCall {
  readonly agent: string;
  readonly cwd?: string;
  readonly id: string;
  readonly task: string;
}

const lastUser = (context: ReadonlyArray<ContextItem>): string =>
  [...context].reverse().find((item) => item.role === "user")?.content ?? "";

const answer = (text: string): Stream.Stream<AssistantItem> =>
  Stream.make(
    { _tag: "textDelta" as const, text },
    { _tag: "done" as const, stopReason: "done" as const },
  );

const delegateCalls = (calls: ReadonlyArray<DelegateCall>): Stream.Stream<AssistantItem> =>
  Stream.fromIterable<AssistantItem>([
    ...calls.map(
      (call): AssistantItem => ({
        _tag: "toolCall",
        argumentsJson: JSON.stringify({
          agent: call.agent,
          task: call.task,
          ...(call.cwd === undefined ? {} : { cwd: call.cwd }),
        }),
        id: call.id,
        name: "delegate",
      }),
    ),
    { _tag: "done", stopReason: "toolCalls" },
  ]);

const toolCall = (name: string, id: string): Stream.Stream<AssistantItem> =>
  Stream.make(
    { _tag: "toolCall" as const, argumentsJson: "{}", id, name },
    { _tag: "done" as const, stopReason: "toolCalls" as const },
  );

/**
 * Routes requests: a compaction request is answered with a short summary; the parent issues
 * `parentCallsByPrompt[prompt]` (else `parentCalls`) on the first request of each Turn and
 * answers `parent done` once it has Tool results; each child is answered by
 * `child(task, context)`.
 */
const scriptedProvider = (script: {
  readonly child: (
    task: string,
    context: ReadonlyArray<ContextItem>,
  ) => Stream.Stream<AssistantItem, never>;
  readonly parentCalls: ReadonlyArray<DelegateCall>;
  readonly parentCallsByPrompt?: Readonly<Record<string, ReadonlyArray<DelegateCall>>>;
}): { readonly provider: ProviderService; readonly requests: Array<RecordedRequest> } => {
  const requests: Array<RecordedRequest> = [];
  const provider: ProviderService = {
    streamAssistant: (context, options: ProviderStreamOptions) => {
      const user = lastUser(context);
      const isCompaction = options.purpose === "compaction";
      const isChild = !isCompaction && user.startsWith("Task: ");
      const tools = options.tools ?? [];
      requests.push({
        context,
        kind: isCompaction ? "compaction" : isChild ? "child" : "parent",
        model: options.model,
        sessionId: options.accountingScope?.sessionId,
        system: context.filter((item) => item.role === "system").map((item) => item.content),
        task: isChild ? user.slice("Task: ".length) : "",
        thinkingLevel: options.thinkingLevel,
        toolDescriptions: new Map(tools.map((tool) => [tool.name, tool.description])),
        tools: tools.map((tool) => tool.name).sort(),
      });
      if (isCompaction) {
        return answer("summary");
      }
      if (isChild) {
        return script.child(user.slice("Task: ".length), context);
      }
      const calls = script.parentCallsByPrompt?.[user] ?? script.parentCalls;
      return context.at(-1)?.role === "toolResult" || calls.length === 0
        ? answer("parent done")
        : delegateCalls(calls);
    },
  };
  return { provider, requests };
};

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

interface MessagePayload {
  readonly content?: string;
  readonly diagnostic?: { readonly reason?: string };
  readonly isError?: boolean;
  readonly role?: string;
  readonly stopReason?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
}

const messages = (snapshot: DriverSnapshot): ReadonlyArray<MessagePayload> =>
  snapshot.entries
    .filter((entry) => entry.kind === "message")
    .map((entry) => entry.payload as MessagePayload);

const toolResult = (snapshot: DriverSnapshot, toolCallId: string): MessagePayload | undefined =>
  messages(snapshot).find(
    (payload) => payload.role === "toolResult" && payload.toolCallId === toolCallId,
  );

const otherSession = (
  driver: DriverService,
  parentId: SessionId,
): Effect.Effect<ReadonlyArray<SessionId>, unknown> =>
  driver
    .listSessions()
    .pipe(
      Effect.map((sessions) =>
        sessions.map((session) => session.id).filter((id) => id !== parentId),
      ),
    );

const filterNames = (
  runtime: CliRuntime,
  sessionId: SessionId,
): Effect.Effect<ReadonlyArray<string>> =>
  runtime.toolRegistry.view(sessionId).pipe(
    Effect.map((view) =>
      view
        .list()
        .map((tool) => tool.name)
        .sort(),
    ),
  );

/** A Session's message payloads as journaled, read from its JSONL file without the Driver. */
const durableMessages = (sessionDir: string, sessionId: SessionId): ReadonlyArray<MessagePayload> =>
  readFileSync(join(sessionDir, `${sessionId}.jsonl`), "utf8")
    .trimEnd()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          readonly payload?: {
            readonly item?: { readonly kind?: string; readonly payload?: MessagePayload };
            readonly type?: string;
          };
        },
    )
    .filter((line) => line.payload?.type === "entry" && line.payload.item?.kind === "message")
    .map((line) => line.payload?.item?.payload ?? {});

/** The failure tag of a Snapshot read: `MailboxSessionNotFound` once a Session is closed. */
const snapshotFailure = (
  driver: DriverService,
  sessionId: SessionId,
): Effect.Effect<string | undefined> =>
  Effect.either(driver.getSnapshot(sessionId)).pipe(
    Effect.map((result) =>
      Either.isLeft(result) ? (result.left as { readonly _tag?: string })._tag : undefined,
    ),
  );

// ---------------------------------------------------------------------------
// Acceptance criteria
// ---------------------------------------------------------------------------

test("a parent calling delegate receives the child Agent's final message as the Tool result", async () => {
  const { provider, requests } = scriptedProvider({
    child: () => answer("child final answer"),
    parentCalls: [{ agent: "helper", id: "call-1", task: "find the bug" }],
  });

  const result = await withHarness({ agents: [{ name: "helper" }], provider }, ({ driver }) =>
    Effect.gen(function* () {
      const parent = yield* driver.createSession();
      const turn = yield* driver.prompt(parent.id, PARENT_PROMPT);
      return { snapshot: yield* driver.getSnapshot(parent.id), turn };
    }),
  );

  expect(result.turn).toEqual({ stopReason: "done" });
  expect(toolResult(result.snapshot, "call-1")).toMatchObject({
    content: "child final answer",
    toolName: "delegate",
  });
  expect(toolResult(result.snapshot, "call-1")?.isError).not.toBe(true);
  const followUp = requests.filter((request) => request.kind === "parent").at(-1);
  expect(followUp?.context.at(-1)).toMatchObject({
    content: "child final answer",
    role: "toolResult",
    toolCallId: "call-1",
  });
}, 15_000);

test("the child Session lands in the parent's session directory and resumes in a later process", async () => {
  const sessionDir = tempDirectory();
  const { provider } = scriptedProvider({
    child: () => answer("child final answer"),
    parentCalls: [{ agent: "helper", id: "call-1", task: "find the bug" }],
  });

  const first = await withHarness(
    { agents: [{ name: "helper" }], provider, sessionDir },
    ({ driver }) =>
      Effect.gen(function* () {
        const parent = yield* driver.createSession();
        yield* driver.prompt(parent.id, PARENT_PROMPT);
        return { childIds: yield* otherSession(driver, parent.id), parentId: parent.id };
      }),
  );
  const files = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
  const childId = first.childIds[0];

  expect(first.childIds).toHaveLength(1);
  expect(files.sort()).toEqual([`${first.parentId}.jsonl`, `${childId}.jsonl`].sort());

  const later = await withHarness(
    {
      agents: [{ name: "helper" }],
      provider: scriptedProvider({ child: () => answer("unused"), parentCalls: [] }).provider,
      sessionDir,
    },
    ({ driver }) =>
      Effect.gen(function* () {
        if (childId === undefined) {
          return undefined;
        }
        yield* driver.resumeSession(childId);
        return messages(yield* driver.getSnapshot(childId));
      }),
  );

  expect(later).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ content: "Task: find the bug", role: "user" }),
      expect.objectContaining({
        content: "child final answer",
        role: "assistant",
        stopReason: "done",
      }),
    ]),
  );
}, 20_000);

test("the child's Tool view is its Agent's composed filter while the parent's view stays unchanged", async () => {
  const { provider, requests } = scriptedProvider({
    child: () => answer("narrow answer"),
    parentCalls: [{ agent: "narrow", id: "call-1", task: "narrow work" }],
  });

  const result = await withHarness(
    { agents: [{ frontmatter: "tools: alpha, beta\n", name: "narrow" }], provider },
    ({ driver, runtime }) =>
      Effect.gen(function* () {
        const parent = yield* driver.createSession();
        yield* driver.prompt(parent.id, PARENT_PROMPT);
        const [childId] = yield* otherSession(driver, parent.id);
        if (childId === undefined) {
          return undefined;
        }
        const childFiltersAfter = yield* runtime.sessionToolGrants.filtersFor(childId);
        const parentFiltersAfter = yield* runtime.sessionToolGrants.filtersFor(parent.id);
        // RFC-04 §7: a later same-process resume of the released child is not narrowed.
        yield* driver.resumeSession(childId);
        return {
          childFiltersAfter,
          parentFiltersAfter,
          resumedChildView: yield* filterNames(runtime, childId),
        };
      }),
  );

  const parentRequests = requests.filter((request) => request.kind === "parent");
  const childRequests = requests.filter((request) => request.kind === "child");
  expect(parentRequests).toHaveLength(2);
  for (const request of parentRequests) {
    expect(request.tools).toEqual(["alpha", "beta", "delegate", "gamma"]);
  }
  expect(childRequests.map((request) => request.tools)).toEqual([["alpha", "beta"]]);
  expect(result).toEqual({
    childFiltersAfter: [],
    parentFiltersAfter: [],
    resumedChildView: ["alpha", "beta", "delegate", "gamma"],
  });
}, 15_000);

test("a child is capped by its parent's Session filters: a Tool the parent lacks is never offered", async () => {
  const { provider, requests } = scriptedProvider({
    child: (task) => answer(`${task} answer`),
    parentCalls: [
      { agent: "wide", id: "call-wide", task: "wide work" },
      { agent: "open", id: "call-open", task: "open work" },
    ],
  });

  await withHarness(
    {
      agents: [{ frontmatter: "tools: alpha, beta\n", name: "wide" }, { name: "open" }],
      provider,
    },
    ({ driver, runtime }) =>
      Effect.gen(function* () {
        const parent = yield* driver.createSession();
        // An rpc Agent session (#55) or a delegated child carries its own Session filter.
        yield* runtime.sessionToolGrants.narrow(parent.id, {
          access: undefined,
          agentTools: ["alpha", "delegate"],
          excludeTools: [],
          tools: [],
        });
        yield* driver.prompt(parent.id, PARENT_PROMPT);
      }),
  );

  const childTools = new Map(
    requests
      .filter((request) => request.kind === "child")
      .map((request) => [request.task, request.tools]),
  );
  expect(requests.filter((request) => request.kind === "parent")[0]?.tools).toEqual([
    "alpha",
    "delegate",
  ]);
  expect(childTools.get("wide work")).toEqual(["alpha"]);
  expect(childTools.get("open work")).toEqual(["alpha", "delegate"]);
}, 15_000);

test("nested delegation carries the delegating child's filters onto the grandchild", async () => {
  const { provider, requests } = scriptedProvider({
    child: (task, context) => {
      if (task === "leaf work") {
        return answer("leaf answer");
      }
      return context.at(-1)?.role === "toolResult"
        ? answer("mid done")
        : delegateCalls([{ agent: "leaf", id: "call-leaf", task: "leaf work" }]);
    },
    parentCalls: [{ agent: "mid", id: "call-mid", task: "mid work" }],
  });

  const result = await withHarness(
    {
      agents: [{ frontmatter: "tools: alpha, delegate\n", name: "mid" }, { name: "leaf" }],
      provider,
    },
    ({ driver }) =>
      Effect.gen(function* () {
        const parent = yield* driver.createSession();
        yield* driver.prompt(parent.id, PARENT_PROMPT);
        return {
          sessions: (yield* driver.listSessions()).length,
          snapshot: yield* driver.getSnapshot(parent.id),
        };
      }),
  );

  const leafRequest = requests.find((request) => request.task === "leaf work");
  const midRequest = requests.find((request) => request.task === "mid work");
  expect(midRequest?.tools).toEqual(["alpha", "delegate"]);
  expect(leafRequest?.tools).toEqual(["alpha", "delegate"]);
  expect(toolResult(result.snapshot, "call-mid")?.content).toBe("mid done");
  expect(result.sessions).toBe(3);
}, 15_000);

test("the child runs with its Agent's persona, model preference, and the head's thinking level before its Task prompt", async () => {
  const { provider, requests } = scriptedProvider({
    child: () => answer("persona answer"),
    parentCalls: [{ agent: "persona", id: "call-1", task: "summarize the repo" }],
  });

  await withHarness(
    {
      agents: [
        { body: "You are the persona.", frontmatter: "model: agent-model\n", name: "persona" },
      ],
      provider,
      thinkingLevel: "low",
    },
    ({ driver }) =>
      Effect.gen(function* () {
        const parent = yield* driver.createSession();
        yield* driver.prompt(parent.id, PARENT_PROMPT);
      }),
  );

  const child = requests.find((request) => request.kind === "child");
  const parent = requests.find((request) => request.kind === "parent");
  expect(child?.system).toEqual(["You are the persona."]);
  expect(lastUser(child?.context ?? [])).toBe("Task: summarize the repo");
  expect(child?.model).toBe("agent-model");
  expect(child?.thinkingLevel).toBe("low");
  expect(parent?.system).toEqual([]);
  expect(parent?.model).toBeUndefined();
}, 15_000);

test("with --model the child keeps the process model over its Agent's model", async () => {
  const { provider, requests } = scriptedProvider({
    child: () => answer("persona answer"),
    parentCalls: [{ agent: "persona", id: "call-1", task: "summarize the repo" }],
  });

  await withHarness(
    {
      agents: [{ body: "Persona.", frontmatter: "model: agent-model\n", name: "persona" }],
      modelSource: "flag",
      provider,
    },
    ({ driver }) =>
      Effect.gen(function* () {
        const parent = yield* driver.createSession();
        yield* driver.prompt(parent.id, PARENT_PROMPT);
      }),
  );

  expect(requests.find((request) => request.kind === "child")?.model).toBeUndefined();
}, 15_000);

test("cwd resolves against the project directory into the child's system content; a missing directory fails without a child", async () => {
  const { provider, requests } = scriptedProvider({
    child: () => answer("cwd answer"),
    parentCalls: [
      { agent: "persona", cwd: "sub", id: "call-sub", task: "in sub" },
      { agent: "persona", cwd: "missing", id: "call-missing", task: "in missing" },
    ],
  });

  const result = await withHarness(
    { agents: [{ body: "You are the persona.", name: "persona" }], provider },
    ({ driver, projectPath }) =>
      Effect.gen(function* () {
        const parent = yield* driver.createSession();
        yield* driver.prompt(parent.id, PARENT_PROMPT);
        return {
          projectPath,
          sessions: (yield* driver.listSessions()).length,
          snapshot: yield* driver.getSnapshot(parent.id),
        };
      }),
  );

  const childRequests = requests.filter((request) => request.kind === "child");
  expect(childRequests.map((request) => request.task)).toEqual(["in sub"]);
  expect(childRequests[0]?.system).toEqual([
    `You are the persona.\n\nWorking directory: ${join(result.projectPath, "sub")}`,
  ]);
  expect(toolResult(result.snapshot, "call-missing")).toMatchObject({
    content: 'Working directory "missing" is not a directory.',
    isError: true,
  });
  expect(result.sessions).toBe(2);
}, 15_000);

test("an unknown agent name returns a failed result listing the available agents", async () => {
  const { provider, requests } = scriptedProvider({
    child: () => answer("unused"),
    parentCalls: [{ agent: "ghost", id: "call-1", task: "anything" }],
  });

  const result = await withHarness(
    { agents: [{ name: "helper" }, { name: "planner", scope: "project" }], provider },
    ({ driver }) =>
      Effect.gen(function* () {
        const parent = yield* driver.createSession();
        const turn = yield* driver.prompt(parent.id, PARENT_PROMPT);
        return {
          sessions: (yield* driver.listSessions()).length,
          snapshot: yield* driver.getSnapshot(parent.id),
          turn,
        };
      }),
  );

  expect(result.turn).toEqual({ stopReason: "done" });
  expect(toolResult(result.snapshot, "call-1")).toMatchObject({
    content: 'Unknown agent "ghost". Available agents: helper (user), planner (project).',
    isError: true,
  });
  expect(result.sessions).toBe(1);
  expect(requests.filter((request) => request.kind === "child")).toEqual([]);
}, 15_000);

test("an Agent whose every listed tool is outside the parent's grant fails closed without a child", async () => {
  const { provider } = scriptedProvider({
    child: () => answer("unused"),
    parentCalls: [{ agent: "locked", id: "call-1", task: "anything" }],
  });

  const result = await withHarness(
    { agents: [{ frontmatter: "tools: no-such-tool\n", name: "locked" }], provider },
    ({ agentPaths, driver }) =>
      Effect.gen(function* () {
        const parent = yield* driver.createSession();
        yield* driver.prompt(parent.id, PARENT_PROMPT);
        return {
          agentPath: agentPaths.get("locked"),
          sessions: (yield* driver.listSessions()).length,
          snapshot: yield* driver.getSnapshot(parent.id),
        };
      }),
  );

  expect(toolResult(result.snapshot, "call-1")).toMatchObject({
    content: `Agent locked (${result.agentPath}) lists only tools this session does not grant: no-such-tool. Delegation fails closed.`,
    isError: true,
  });
  expect(result.sessions).toBe(1);
}, 15_000);

test("the delegate Tool description lists the Agents discovered at startup", async () => {
  const { provider, requests } = scriptedProvider({
    child: () => answer("unused"),
    parentCalls: [],
  });

  await withHarness(
    { agents: [{ name: "helper" }, { name: "planner", scope: "project" }], provider },
    ({ driver }) =>
      Effect.gen(function* () {
        const parent = yield* driver.createSession();
        yield* driver.prompt(parent.id, PARENT_PROMPT);
      }),
  );

  const description = requests[0]?.toolDescriptions.get("delegate") ?? "";
  expect(description).toContain(
    "Available agents:\n- helper: helper agent\n- planner: planner agent",
  );
}, 15_000);

test("each call resolves its Agent definition fresh: body, model, and tools edited between calls reach the next child", async () => {
  const { provider, requests } = scriptedProvider({
    child: (task) => answer(`${task} answer`),
    parentCalls: [],
    parentCallsByPrompt: {
      "First prompt.": [{ agent: "helper", id: "call-first", task: "first" }],
      "Second prompt.": [{ agent: "helper", id: "call-second", task: "second" }],
    },
  });

  const result = await withHarness(
    {
      agents: [
        { body: "Old persona.", frontmatter: "model: old-model\ntools: alpha\n", name: "helper" },
      ],
      provider,
    },
    ({ agentPaths, driver }) =>
      Effect.gen(function* () {
        const parent = yield* driver.createSession();
        yield* driver.prompt(parent.id, "First prompt.");
        yield* Effect.sync(() =>
          writeFileSync(
            agentPaths.get("helper") ?? "",
            "---\nname: helper\ndescription: helper agent\nmodel: new-model\ntools: beta, gamma\n---\nNew persona.\n",
            "utf8",
          ),
        );
        yield* driver.prompt(parent.id, "Second prompt.");
        return yield* driver.getSnapshot(parent.id);
      }),
  );

  const first = requests.find((request) => request.task === "first");
  const second = requests.find((request) => request.task === "second");
  expect(first).toMatchObject({ model: "old-model", system: ["Old persona."], tools: ["alpha"] });
  expect(second).toMatchObject({
    model: "new-model",
    system: ["New persona."],
    tools: ["beta", "gamma"],
  });
  expect(toolResult(result, "call-second")?.content).toBe("second answer");
}, 15_000);

test("an Agent added after startup is delegable but not listed, and a removed Agent fails with the fresh listing", async () => {
  const { provider, requests } = scriptedProvider({
    child: (task) => answer(`${task} answer`),
    parentCalls: [
      { agent: "late", id: "call-late", task: "late work" },
      { agent: "helper", id: "call-removed", task: "removed work" },
    ],
  });

  const result = await withHarness(
    { agents: [{ name: "helper" }, { name: "planner", scope: "project" }], provider },
    ({ agentPaths, driver, projectPath, userDir }) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          writeAgents([{ name: "late" }], userDir, projectPath);
          rmSync(agentPaths.get("helper") ?? "", { force: true });
        });
        const parent = yield* driver.createSession();
        yield* driver.prompt(parent.id, PARENT_PROMPT);
        return yield* driver.getSnapshot(parent.id);
      }),
  );

  expect(toolResult(result, "call-late")).toMatchObject({ content: "late work answer" });
  expect(toolResult(result, "call-late")?.isError).not.toBe(true);
  expect(toolResult(result, "call-removed")).toMatchObject({
    content: 'Unknown agent "helper". Available agents: late (user), planner (project).',
    isError: true,
  });
  const description = requests[0]?.toolDescriptions.get("delegate") ?? "";
  expect(description).toContain("- helper: helper agent");
  expect(description).not.toContain("late");
  expect(requests.filter((request) => request.kind === "child").map((r) => r.task)).toEqual([
    "late work",
  ]);
}, 15_000);

test("interrupting the parent Turn mid-delegation aborts the child, keeps what it completed, and releases its filters", async () => {
  const sessionDir = tempDirectory();
  const childStreaming = Effect.runSync(Deferred.make<void>());
  const { provider } = scriptedProvider({
    child: () =>
      Stream.concat(
        Stream.make({ _tag: "textDelta" as const, text: "partial" }),
        Stream.unwrap(
          Deferred.succeed(childStreaming, undefined).pipe(
            Effect.as(Stream.never as Stream.Stream<AssistantItem>),
          ),
        ),
      ),
    parentCalls: [{ agent: "helper", id: "call-1", task: "slow work" }],
  });

  const result = await withHarness(
    { agents: [{ frontmatter: "tools: alpha\n", name: "helper" }], provider, sessionDir },
    ({ driver, runtime }) =>
      Effect.gen(function* () {
        const parent = yield* driver.createSession();
        const turn = yield* Effect.fork(driver.prompt(parent.id, PARENT_PROMPT));
        yield* Deferred.await(childStreaming).pipe(Effect.timeout("5 seconds"));
        const [childId] = yield* otherSession(driver, parent.id);
        if (childId === undefined) {
          return undefined;
        }
        const filtersWhileRunning = yield* runtime.sessionToolGrants.filtersFor(childId);
        const abort = yield* driver.abortTurn(parent.id);
        const parentTurn = yield* Fiber.join(turn);
        const filtersAfter = yield* runtime.sessionToolGrants.filtersFor(childId);
        // Before any resume: the child is closed, and its Journal holds what it completed.
        const childAfterClose = yield* snapshotFailure(driver, childId);
        const durable = durableMessages(sessionDir, childId);
        const parentSnapshot = yield* driver.getSnapshot(parent.id);
        yield* driver.resumeSession(childId);
        const resumed = messages(yield* driver.getSnapshot(childId));
        return {
          abort,
          childAfterClose,
          durable,
          filtersAfter,
          filtersWhileRunning,
          parentSnapshot,
          parentTurn,
          resumed,
        };
      }),
  );

  expect(result?.abort.aborted).toBe(true);
  expect(result?.parentTurn).toEqual({ stopReason: "aborted" });
  expect(result?.filtersWhileRunning).toHaveLength(1);
  expect(result?.filtersAfter).toEqual([]);
  expect(result?.childAfterClose).toBe("MailboxSessionNotFound");
  expect(
    result === undefined ? undefined : toolResult(result.parentSnapshot, "call-1"),
  ).toMatchObject({
    content: "Tool execution interrupted.",
    isError: true,
  });
  expect(result?.durable).toMatchObject([
    { content: "Task: slow work", role: "user" },
    { content: "partial", role: "assistant", stopReason: "aborted" },
  ]);
  expect(result?.resumed).toEqual(result?.durable);
}, 20_000);

test("interrupting the parent while the child Turn is still being admitted never starts the child's Provider request", async () => {
  const readEntered = Effect.runSync(Deferred.make<void>());
  const allowRead = Effect.runSync(Deferred.make<void>());
  let parentId: SessionId | undefined;
  let held = false;
  // Holds the first Branch read of the first Session other than the parent: the child's
  // prompt option resolution, inside its Turn's Mailbox command, before the Turn registers.
  const wrapJournal = (journal: JournalService): JournalService => ({
    ...journal,
    readBranch: (sessionId) =>
      parentId !== undefined && sessionId !== parentId && !held
        ? Effect.gen(function* () {
            held = true;
            yield* Deferred.succeed(readEntered, undefined);
            yield* Deferred.await(allowRead);
            return yield* journal.readBranch(sessionId);
          })
        : journal.readBranch(sessionId),
  });
  const { provider, requests } = scriptedProvider({
    child: () => answer("late child answer"),
    parentCalls: [{ agent: "helper", id: "call-1", task: "gated work" }],
  });

  const result = await withHarness(
    { agents: [{ frontmatter: "tools: alpha\n", name: "helper" }], provider, wrapJournal },
    ({ driver, runtime }) =>
      Effect.gen(function* () {
        const parent = yield* driver.createSession();
        parentId = parent.id;
        const turn = yield* Effect.fork(driver.prompt(parent.id, PARENT_PROMPT));
        yield* Deferred.await(readEntered).pipe(Effect.timeout("5 seconds"));
        const abort = yield* Effect.fork(driver.abortTurn(parent.id));
        // The delegate Tool's release is inside the child's close while admission is held.
        yield* Effect.sleep("200 millis");
        yield* Deferred.succeed(allowRead, undefined);
        const aborted = yield* Fiber.join(abort);
        const parentTurn = yield* Fiber.join(turn);
        const [childId] = yield* otherSession(driver, parent.id);
        if (childId === undefined) {
          return undefined;
        }
        const filtersAfter = yield* runtime.sessionToolGrants.filtersFor(childId);
        yield* driver.resumeSession(childId);
        return {
          aborted: aborted.aborted,
          childMessages: messages(yield* driver.getSnapshot(childId)),
          filtersAfter,
          parentSnapshot: yield* driver.getSnapshot(parent.id),
          parentTurn,
        };
      }).pipe(Effect.ensuring(Deferred.succeed(allowRead, undefined))),
  );

  expect(requests.filter((request) => request.kind === "child")).toEqual([]);
  expect(result?.aborted).toBe(true);
  expect(result?.parentTurn).toEqual({ stopReason: "aborted" });
  expect(result?.filtersAfter).toEqual([]);
  // The refused Turn journals nothing: no Task Entry, no assistant Entry.
  expect(result?.childMessages).toEqual([]);
  expect(
    result === undefined ? undefined : toolResult(result.parentSnapshot, "call-1"),
  ).toMatchObject({ content: "Tool execution interrupted.", isError: true });
}, 20_000);

test("a child that resists interruption past its abort grace is still closed and released within the close bound", async () => {
  const sessionDir = tempDirectory();
  const childStreaming = Effect.runSync(Deferred.make<void>());
  const resistEnded = Effect.runSync(Deferred.make<void>());
  const { provider } = scriptedProvider({
    child: () =>
      Stream.concat(
        Stream.make({ _tag: "textDelta" as const, text: "partial" }),
        Stream.fromEffect(
          Deferred.succeed(childStreaming, undefined).pipe(
            Effect.zipRight(Effect.sleep("8 seconds")),
            Effect.ensuring(Deferred.succeed(resistEnded, undefined)),
            Effect.uninterruptible,
            Effect.as({ _tag: "textDelta" as const, text: "late" }),
          ),
        ),
      ),
    parentCalls: [{ agent: "helper", id: "call-1", task: "resisting work" }],
  });

  const result = await withHarness(
    { agents: [{ frontmatter: "tools: alpha\n", name: "helper" }], provider, sessionDir },
    ({ driver, runtime }) =>
      Effect.gen(function* () {
        const parent = yield* driver.createSession();
        const turn = yield* Effect.fork(
          driver.prompt(parent.id, PARENT_PROMPT, { abortGraceMs: 200 }),
        );
        yield* Deferred.await(childStreaming).pipe(Effect.timeout("5 seconds"));
        const [childId] = yield* otherSession(driver, parent.id);
        if (childId === undefined) {
          return undefined;
        }
        const started = performance.now();
        yield* driver.abortTurn(parent.id);
        const parentTurn = yield* Fiber.join(turn);
        const parentSettledMillis = performance.now() - started;
        // Released and deactivated: the child's filters are gone and its Mailbox is closed.
        const released = yield* Effect.gen(function* () {
          const filters = yield* runtime.sessionToolGrants.filtersFor(childId);
          const failure = yield* snapshotFailure(driver, childId);
          return filters.length === 0 && failure === "MailboxSessionNotFound";
        }).pipe(
          Effect.flatMap((done) => (done ? Effect.void : Effect.fail("pending" as const))),
          Effect.retry(Schedule.spaced("50 millis")),
          Effect.timeoutOption("9 seconds"),
        );
        const releasedMillis = performance.now() - started;
        // The resisting fiber leaks until its uninterruptible step ends; wait it out.
        yield* Deferred.await(resistEnded).pipe(Effect.timeout("10 seconds"));
        yield* Effect.sleep("200 millis");
        return {
          durable: durableMessages(sessionDir, childId),
          parentSettledMillis,
          parentTurn,
          released: Option.isSome(released),
          releasedMillis,
        };
      }),
  );

  expect(result?.parentTurn).toEqual({ stopReason: "aborted" });
  expect(result?.parentSettledMillis).toBeLessThan(2_000);
  expect(result?.released).toBe(true);
  // The child's close is bounded by its abort grace and the 5 s close budget, not by the
  // 8 s the child resists.
  expect(result?.releasedMillis).toBeLessThan(7_000);
  expect(result?.durable[0]).toMatchObject({ content: "Task: resisting work", role: "user" });
  expect(result?.durable).toContainEqual(
    expect.objectContaining({ content: "partial", role: "assistant", stopReason: "aborted" }),
  );
}, 30_000);

test("two delegate calls in one Tool batch run concurrently", async () => {
  const oneStarted = Effect.runSync(Deferred.make<void>());
  const twoStarted = Effect.runSync(Deferred.make<void>());
  const { provider } = scriptedProvider({
    child: (task) => {
      const [mine, theirs] = task === "one" ? [oneStarted, twoStarted] : [twoStarted, oneStarted];
      // Each child answers only after the other child has started: sequential calls never finish.
      return Stream.unwrap(
        Deferred.succeed(mine, undefined).pipe(
          Effect.zipRight(Deferred.await(theirs)),
          Effect.as(answer(`${task} answer`)),
        ),
      );
    },
    parentCalls: [
      { agent: "helper", id: "call-one", task: "one" },
      { agent: "helper", id: "call-two", task: "two" },
    ],
  });

  const result = await withHarness({ agents: [{ name: "helper" }], provider }, ({ driver }) =>
    Effect.gen(function* () {
      const parent = yield* driver.createSession();
      const turn = yield* driver
        .prompt(parent.id, PARENT_PROMPT)
        .pipe(Effect.timeoutOption("5 seconds"));
      if (Option.isNone(turn)) {
        yield* driver.abortTurn(parent.id);
        return { overlapped: false as const };
      }
      return { overlapped: true as const, snapshot: yield* driver.getSnapshot(parent.id) };
    }),
  );

  expect(result.overlapped).toBe(true);
  if (result.overlapped) {
    expect(toolResult(result.snapshot, "call-one")?.content).toBe("one answer");
    expect(toolResult(result.snapshot, "call-two")?.content).toBe("two answer");
  }
}, 20_000);

test("delegate calls stay under the existing Tool batch bound", async () => {
  const events: Array<string> = [];
  const { provider } = scriptedProvider({
    child: (task) =>
      Stream.unwrap(
        Effect.sync(() => events.push(`start:${task}`)).pipe(
          Effect.zipRight(Effect.sleep("30 millis")),
          Effect.as(answer(`${task} answer`)),
        ),
      ).pipe(Stream.ensuring(Effect.sync(() => events.push(`end:${task}`)))),
    parentCalls: [
      { agent: "helper", id: "call-one", task: "one" },
      { agent: "helper", id: "call-two", task: "two" },
    ],
  });

  await withHarness({ agents: [{ name: "helper" }], provider }, ({ driver }) =>
    Effect.gen(function* () {
      const parent = yield* driver.createSession();
      yield* driver.prompt(parent.id, PARENT_PROMPT, { toolConcurrency: 1 });
    }),
  );

  expect(events).toEqual(["start:one", "end:one", "start:two", "end:two"]);
}, 15_000);

// ---------------------------------------------------------------------------
// Stress: no truncation in v1 (records the blast radius)
// ---------------------------------------------------------------------------

const HUGE_LENGTH = 2_000_000;

test("an extremely large child message reaches the parent whole when it fits the parent's context budget", async () => {
  const { provider, requests } = scriptedProvider({
    child: () => answer("x".repeat(HUGE_LENGTH)),
    parentCalls: [{ agent: "helper", id: "call-1", task: "huge" }],
  });

  const result = await withHarness({ agents: [{ name: "helper" }], provider }, ({ driver }) =>
    Effect.gen(function* () {
      const parent = yield* driver.createSession();
      const turn = yield* driver.prompt(parent.id, PARENT_PROMPT, { contextBudget: 10_000_000 });
      return { snapshot: yield* driver.getSnapshot(parent.id), turn };
    }),
  );

  const followUp = requests.filter((request) => request.kind === "parent").at(-1);
  expect(result.turn).toEqual({ stopReason: "done" });
  expect(toolResult(result.snapshot, "call-1")?.content).toHaveLength(HUGE_LENGTH);
  expect(followUp?.context.at(-1)?.content).toHaveLength(HUGE_LENGTH);
  expect(messages(result.snapshot).at(-1)).toMatchObject({
    content: "parent done",
    role: "assistant",
  });
}, 30_000);

test("with compaction disabled, an extremely large child message past the parent's context budget is journaled whole and settles the parent Turn with a budget error", async () => {
  const { provider } = scriptedProvider({
    child: () => answer("x".repeat(HUGE_LENGTH)),
    parentCalls: [{ agent: "helper", id: "call-1", task: "huge" }],
  });

  const result = await withHarness({ agents: [{ name: "helper" }], provider }, ({ driver }) =>
    Effect.gen(function* () {
      const parent = yield* driver.createSession();
      const turn = yield* driver.prompt(parent.id, PARENT_PROMPT, {
        compaction: { enabled: false },
      });
      return { snapshot: yield* driver.getSnapshot(parent.id), turn };
    }),
  );

  expect(result.turn).toEqual({ stopReason: "error" });
  expect(toolResult(result.snapshot, "call-1")?.content).toHaveLength(HUGE_LENGTH);
  expect(messages(result.snapshot).at(-1)).toMatchObject({
    diagnostic: { reason: "budget_exceeded" },
    role: "assistant",
    stopReason: "error",
  });
  expect(result.snapshot.phase).toBe("IDLE");
}, 30_000);

test("with default compaction, an extremely large child message past the parent's context budget is journaled whole and ends the parent Turn on the Provider round bound", async () => {
  const { provider, requests } = scriptedProvider({
    child: () => answer("x".repeat(HUGE_LENGTH)),
    parentCalls: [{ agent: "helper", id: "call-1", task: "huge" }],
  });

  const result = await withHarness({ agents: [{ name: "helper" }], provider }, ({ driver }) =>
    Effect.gen(function* () {
      const parent = yield* driver.createSession();
      const turn = yield* driver.prompt(parent.id, PARENT_PROMPT);
      return { parentId: parent.id, snapshot: yield* driver.getSnapshot(parent.id), turn };
    }),
  );

  expect(result.turn).toEqual({ stopReason: "error" });
  expect(toolResult(result.snapshot, "call-1")?.content).toHaveLength(HUGE_LENGTH);
  expect(messages(result.snapshot).at(-1)).toMatchObject({
    diagnostic: {
      detail: "Maximum provider round bound of 32 exceeded.",
      reason: "provider_error",
    },
    role: "assistant",
    stopReason: "error",
  });
  expect(result.snapshot.phase).toBe("IDLE");
  expect(
    requests.filter(
      (request) => request.kind === "compaction" && request.sessionId === result.parentId,
    ).length,
  ).toBeGreaterThan(0);
}, 60_000);

// ---------------------------------------------------------------------------
// Compaction requests keep the process Provider defaults (Decision 10 exception)
// ---------------------------------------------------------------------------

const BULKY_LENGTH = 60_000;

const bulkyToolPlugin: FirstPartyPlugin = {
  contributions: [
    defineToolContribution({
      description: "Return a bulky result.",
      execute: () => Effect.succeed({ content: "y".repeat(BULKY_LENGTH) }),
      name: "bulky",
      parameters: Schema.Struct({}),
    }),
  ],
  manifest: { capabilities: [], name: "delegation-fixture-bulky", version: "1.0.0" },
};

test("a child's compaction requests use the process Provider defaults, not its Agent's model or the head's effort", async () => {
  const { provider, requests } = scriptedProvider({
    child: (_task, context) =>
      context.at(-1)?.role === "toolResult"
        ? answer("after bulky")
        : toolCall("bulky", "call-bulky"),
    parentCalls: [{ agent: "persona", id: "call-1", task: "bulky work" }],
  });

  await withHarness(
    {
      agents: [
        { body: "Persona.", frontmatter: "model: agent-model\ntools: bulky\n", name: "persona" },
      ],
      extraPlugins: [bulkyToolPlugin],
      provider,
      thinkingLevel: "low",
    },
    ({ driver }) =>
      Effect.gen(function* () {
        const parent = yield* driver.createSession();
        yield* driver.prompt(parent.id, PARENT_PROMPT);
      }),
  );

  const childTurns = requests.filter((request) => request.kind === "child");
  const childId = childTurns[0]?.sessionId;
  const childCompactions = requests.filter(
    (request) => request.kind === "compaction" && request.sessionId === childId,
  );
  expect(childTurns.length).toBeGreaterThan(0);
  for (const request of childTurns) {
    expect(request).toMatchObject({ model: "agent-model", thinkingLevel: "low" });
  }
  expect(childCompactions.length).toBeGreaterThan(0);
  for (const request of childCompactions) {
    expect(request.model).toBeUndefined();
    expect(request.thinkingLevel).toBeUndefined();
  }
}, 30_000);

test("delegation offers delegate at depths 1 and 2 but removes it at depth 3", async () => {
  const { provider, requests } = scriptedProvider({
    parentCalls: [{ agent: "nested", id: "head-child", task: "1" }],
    child: (task, context) =>
      Number(task) < 3 && context.at(-1)?.role !== "toolResult"
        ? delegateCalls([{ agent: "nested", id: `child-${task}`, task: String(Number(task) + 1) }])
        : answer("done"),
  });
  await withHarness(
    { agents: [{ name: "nested", frontmatter: "tools: alpha, delegate\n" }], provider },
    ({ driver }) =>
      Effect.gen(function* () {
        const head = yield* driver.createSession();
        yield* driver.prompt(head.id, PARENT_PROMPT);
        expect(yield* driver.listSessions()).toHaveLength(4);
      }),
  );
  expect(requests.find((request) => request.task === "1")?.tools).toEqual(["alpha", "delegate"]);
  expect(requests.find((request) => request.task === "2")?.tools).toEqual(["alpha", "delegate"]);
  expect(requests.find((request) => request.task === "3")?.tools).toEqual(["alpha"]);
}, 15_000);

test("a direct delegate call at depth 3 fails without creating a child", async () => {
  let directCall: Effect.Effect<void, unknown> = Effect.void;
  let refusal: unknown;
  const { provider, requests } = scriptedProvider({
    parentCalls: [{ agent: "nested", id: "head-child", task: "1" }],
    child: (task, context) =>
      task === "blocked"
        ? answer("unexpected child")
        : task === "3"
          ? Stream.fromEffect(directCall.pipe(Effect.orDie)).pipe(
              Stream.flatMap(() => answer("done")),
            )
          : context.at(-1)?.role === "toolResult"
            ? answer("done")
            : delegateCalls([
                { agent: "nested", id: `child-${task}`, task: String(Number(task) + 1) },
              ]),
  });
  await withHarness(
    { agents: [{ name: "nested", frontmatter: "tools: alpha, delegate\n" }], provider },
    ({ driver, runtime }) =>
      Effect.gen(function* () {
        const tool = (yield* runtime.processToolView)
          .list()
          .find((tool) => tool.name === "delegate");
        expect(tool).toBeDefined();
        directCall = Effect.gen(function* () {
          const sessionId = requests.find((request) => request.task === "3")?.sessionId;
          if (tool === undefined || sessionId === undefined) return;
          const before = (yield* driver.listSessions()).length;
          refusal = yield* Effect.scoped(
            tool.execute({ agent: "nested", task: "blocked" } as never, {
              sessionId,
              getGoal: () => Effect.succeed(undefined),
              changeGoal: () => Effect.succeed(undefined),
            }),
          );
          expect((yield* driver.listSessions()).length).toBe(before);
        });
        const head = yield* driver.createSession();
        yield* driver.prompt(head.id, PARENT_PROMPT);
      }),
  );
  expect(refusal).toEqual({
    content: "delegate is not available at delegation depth 3: the limit is 3.",
    isError: true,
  });
}, 15_000);

test("release drops a child's delegation depth so a resumed depth-3 Session is a head", async () => {
  const { provider, requests } = scriptedProvider({
    parentCalls: [{ agent: "nested", id: "head-child", task: "1" }],
    child: (task, context) =>
      task === "leaf" || task === "3" || context.at(-1)?.role === "toolResult"
        ? answer("done")
        : delegateCalls([
            {
              agent: "nested",
              id: `child-${task}`,
              task: task === "resumed" ? "leaf" : String(Number(task) + 1),
            },
          ]),
  });
  await withHarness(
    { agents: [{ name: "nested", frontmatter: "tools: alpha, delegate\n" }], provider },
    ({ driver, runtime }) =>
      Effect.gen(function* () {
        const head = yield* driver.createSession();
        yield* driver.prompt(head.id, PARENT_PROMPT);
        const deepest = requests.find((request) => request.task === "3")?.sessionId;
        expect(deepest).toBeDefined();
        if (deepest === undefined) return;
        expect(yield* runtime.sessionToolGrants.filtersFor(deepest)).toEqual([]);
        yield* driver.resumeSession(deepest);
        yield* driver.prompt(deepest, "Task: resumed");
        expect(toolResult(yield* driver.getSnapshot(deepest), "child-resumed")).toMatchObject({
          content: "done",
        });
        expect(yield* driver.listSessions()).toHaveLength(5);
      }),
  );
  expect(requests.find((request) => request.task === "leaf")?.tools).toEqual(["alpha", "delegate"]);
}, 15_000);
