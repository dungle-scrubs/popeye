import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EntryDraftSchema,
  Journal,
  JournalJsonl,
  type JournalService,
  type SessionId,
} from "@peye/journal";
import { Effect, Exit, Layer, Schema, Stream } from "effect";
import { expect, test } from "vitest";

import { MailboxLive } from "./mailbox.js";
import { ProgressHubLive } from "./progress.js";
import { type ContextItem, Provider, type ProviderService } from "./provider.js";
import { appendOperationStarted, appendToolStarted, OperationIdSchema } from "./records.js";
import type { RecoveryReport } from "./recovery.js";
import { Sessions, SessionsLive } from "./sessions.js";
import { defineTool, ToolRegistryLive } from "./tool.js";
import { Turns, TurnsLive } from "./turn.js";

const crash = new Error("Injected process crash.");

const faultInjectedJournal = (directory: string, failAfterJournalLines: number) => {
  let acknowledgedLines = 0;
  let killed = false;
  const base = JournalJsonl(directory, {
    io: {
      observe: (observation) =>
        Effect.sync(() => {
          if (observation.operation !== "ack") {
            return;
          }
          acknowledgedLines += 1;
          if (acknowledgedLines === failAfterJournalLines) {
            killed = true;
            throw crash;
          }
        }),
    },
  });
  const guard = <TValue, TError>(
    run: () => Effect.Effect<TValue, TError>,
  ): Effect.Effect<TValue, TError> => Effect.suspend(() => (killed ? Effect.die(crash) : run()));
  return Layer.effect(
    Journal,
    Effect.gen(function* () {
      const journal = yield* Journal;
      return {
        ...journal,
        appendCompaction: (sessionId, payload) =>
          guard(() => journal.appendCompaction(sessionId, payload)),
        appendEntry: (sessionId, entry) => guard(() => journal.appendEntry(sessionId, entry)),
        appendRecord: (sessionId, record) => guard(() => journal.appendRecord(sessionId, record)),
        moveLeaf: (sessionId, entryId) => guard(() => journal.moveLeaf(sessionId, entryId)),
      } satisfies JournalService;
    }),
  ).pipe(Layer.provide(base));
};

const providerLayer = (service: ProviderService): Layer.Layer<Provider> =>
  Layer.succeed(Provider, service);

const kernelLayer = <E>(
  journalLayer: Layer.Layer<Journal, E>,
  provider: ProviderService,
  recoveryDiagnosticSink: (report: RecoveryReport) => Effect.Effect<void> = () => Effect.void,
  toolLayer = ToolRegistryLive([]),
) => {
  const mailboxLayer = MailboxLive().pipe(Layer.provide(journalLayer));
  const dependencies = Layer.mergeAll(
    journalLayer,
    mailboxLayer,
    ProgressHubLive(),
    providerLayer(provider),
    toolLayer,
  );
  const sessionsLayer = SessionsLive({ recoveryDiagnosticSink }).pipe(
    Layer.provide(Layer.mergeAll(journalLayer, mailboxLayer, toolLayer)),
  );
  return Layer.mergeAll(dependencies, sessionsLayer, TurnsLive().pipe(Layer.provide(dependencies)));
};

const doneProvider: ProviderService = {
  streamAssistant: () =>
    Stream.fromIterable([
      { _tag: "textDelta", text: "not durable" },
      { _tag: "done", stopReason: "done" },
    ]),
};

test("JSONL kill after operation_started reopens to an interrupted assistant and finished Record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peye-kernel-m11-operation-started-"));
  let sessionId: SessionId | undefined;
  try {
    const crashed = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const turns = yield* Turns;
        const session = yield* sessions.create();
        sessionId = session.id;
        return yield* turns.runTurn(session.id, "crash after start");
      }).pipe(Effect.provide(kernelLayer(faultInjectedJournal(directory, 3), doneProvider))),
    );
    expect(Exit.isFailure(crashed)).toBe(true);
    expect(sessionId).toBeDefined();

    const reports: Array<RecoveryReport> = [];
    const journalLayer = JournalJsonl(directory);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal;
        const sessions = yield* Sessions;
        const resumed = yield* sessions.resume(sessionId as SessionId);
        return {
          branch: yield* journal.readBranch(sessionId as SessionId),
          records: yield* journal.readRecords(sessionId as SessionId),
          resumed,
        };
      }).pipe(
        Effect.provide(
          Layer.merge(
            journalLayer,
            kernelLayer(journalLayer, doneProvider, (report) =>
              Effect.sync(() => reports.push(report)),
            ),
          ),
        ),
      ),
    );

    expect(result.branch.at(-1)?.payload).toMatchObject({
      diagnostic: { detail: "interrupted by crash" },
      role: "assistant",
      stopReason: "error",
    });
    expect(result.records.map((record) => record.kind)).toEqual([
      "operation_started",
      "operation_finished",
    ]);
    expect(result.resumed.recovery).toEqual(reports[0]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("JSONL kill after the user Entry closes the orphaned trailing prompt on resume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peye-kernel-m11-orphaned-prompt-"));
  let sessionId: SessionId | undefined;
  try {
    const crashed = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const turns = yield* Turns;
        const session = yield* sessions.create();
        sessionId = session.id;
        return yield* turns.runTurn(session.id, "crash before operation start");
      }).pipe(Effect.provide(kernelLayer(faultInjectedJournal(directory, 2), doneProvider))),
    );
    expect(Exit.isFailure(crashed)).toBe(true);

    const journalLayer = JournalJsonl(directory);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal;
        const sessions = yield* Sessions;
        const resumed = yield* sessions.resume(sessionId as SessionId);
        return {
          branch: yield* journal.readBranch(sessionId as SessionId),
          records: yield* journal.readRecords(sessionId as SessionId),
          resumed,
        };
      }).pipe(Effect.provide(Layer.merge(journalLayer, kernelLayer(journalLayer, doneProvider)))),
    );

    expect(result.resumed.recovery).toMatchObject({
      actions: [{ action: "orphaned_prompt_closed", promptEntryId: expect.any(String) }],
      entriesAppended: [expect.any(String)],
      operationIdFound: undefined,
    });
    expect(result.branch.slice(-2).map((entry) => entry.payload)).toMatchObject([
      { content: "crash before operation start", role: "user" },
      {
        diagnostic: { detail: "interrupted by crash", reason: "turn_failure" },
        role: "assistant",
        stopReason: "error",
      },
    ]);
    expect(result.records).toEqual([]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("JSONL kill after the assistant Tool-call Entry synthesizes its missing Tool result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peye-kernel-m11-assistant-entry-"));
  let sessionId: SessionId | undefined;
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: () => {
      requests += 1;
      return requests === 1
        ? Stream.fromIterable([
            { _tag: "toolCall", argumentsJson: "{}", id: "not-started-call", name: "read_file" },
            { _tag: "done", stopReason: "toolCalls" },
          ])
        : Stream.fromIterable([{ _tag: "done", stopReason: "done" }]);
    },
  };
  const readFile = defineTool({
    description: "Would read a file.",
    execute: () => Effect.succeed({ content: "not reached" }),
    name: "read_file",
    parameters: Schema.Struct({}),
  });
  try {
    const crashed = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const turns = yield* Turns;
        const session = yield* sessions.create();
        sessionId = session.id;
        return yield* turns.runTurn(session.id, "crash after assistant entry");
      }).pipe(
        Effect.provide(
          kernelLayer(
            faultInjectedJournal(directory, 4),
            provider,
            () => Effect.void,
            ToolRegistryLive([readFile]),
          ),
        ),
      ),
    );
    expect(Exit.isFailure(crashed)).toBe(true);

    const journalLayer = JournalJsonl(directory);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal;
        const sessions = yield* Sessions;
        const resumed = yield* sessions.resume(sessionId as SessionId);
        return {
          branch: yield* journal.readBranch(sessionId as SessionId),
          records: yield* journal.readRecords(sessionId as SessionId),
          resumed,
        };
      }).pipe(Effect.provide(Layer.merge(journalLayer, kernelLayer(journalLayer, doneProvider)))),
    );

    expect(result.records.map((record) => record.kind)).toEqual([
      "operation_started",
      "operation_finished",
    ]);
    expect(result.resumed.recovery.actions).toMatchObject([
      {
        action: "synthesized_interrupted",
        replay: "never",
        toolCallId: "not-started-call",
        toolName: "read_file",
      },
    ]);
    expect(result.branch.at(-3)?.payload).toMatchObject({
      role: "assistant",
      stopReason: "toolCalls",
    });
    expect(result.branch.at(-2)?.payload).toMatchObject({
      isError: true,
      role: "toolResult",
      toolCallId: "not-started-call",
    });
    expect(result.branch.at(-1)?.payload).toMatchObject({
      diagnostic: { detail: "interrupted by crash" },
      role: "assistant",
      stopReason: "error",
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("JSONL kill after tool_started recovers according to never and safe replay policies", async () => {
  for (const replay of ["never", "safe"] as const) {
    const directory = await mkdtemp(join(tmpdir(), `peye-kernel-m11-tool-started-${replay}-`));
    let sessionId: SessionId | undefined;
    let requests = 0;
    const provider: ProviderService = {
      streamAssistant: () => {
        requests += 1;
        return requests === 1
          ? Stream.fromIterable([
              {
                _tag: "toolCall",
                argumentsJson: '{"path":"README.md"}',
                id: `${replay}-call`,
                name: "read_file",
              },
              { _tag: "done", stopReason: "toolCalls" },
            ])
          : Stream.fromIterable([{ _tag: "done", stopReason: "done" }]);
      },
    };
    const readFile = defineTool({
      description: "Would read a file.",
      execute: () => Effect.succeed({ content: "not reached" }),
      name: "read_file",
      parameters: Schema.Struct({ path: Schema.String }),
      replay,
    });
    try {
      const crashed = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const turns = yield* Turns;
          const session = yield* sessions.create();
          sessionId = session.id;
          return yield* turns.runTurn(session.id, `crash after ${replay} start`);
        }).pipe(
          Effect.provide(
            kernelLayer(
              faultInjectedJournal(directory, 5),
              provider,
              () => Effect.void,
              ToolRegistryLive([readFile]),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(crashed)).toBe(true);

      const journalLayer = JournalJsonl(directory);
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const sessions = yield* Sessions;
          const resumed = yield* sessions.resume(sessionId as SessionId);
          return { branch: yield* journal.readBranch(sessionId as SessionId), resumed };
        }).pipe(
          Effect.provide(
            Layer.merge(
              journalLayer,
              kernelLayer(
                journalLayer,
                doneProvider,
                () => Effect.void,
                ToolRegistryLive([readFile]),
              ),
            ),
          ),
        ),
      );

      expect(result.resumed.recovery.actions).toMatchObject([
        {
          action: replay === "never" ? "synthesized_interrupted" : "safe_replay",
          replay,
          toolCallId: `${replay}-call`,
        },
      ]);
      expect(result.resumed.recovery.safeReplay).toHaveLength(replay === "safe" ? 1 : 0);
      expect(
        result.branch.filter((entry) => {
          const payload = entry.payload as { readonly role?: unknown };
          return payload.role === "toolResult";
        }),
      ).toHaveLength(1);
      expect(result.branch.at(-1)?.payload).toMatchObject({
        role: "assistant",
        stopReason: "error",
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
});

test("safe-replay recovery closes before another crashed Turn and leaves no dangling Context call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peye-kernel-m11-safe-replay-twice-"));
  let sessionId: SessionId | undefined;
  const readFile = defineTool({
    description: "Would read a file.",
    execute: () => Effect.succeed({ content: "not reached" }),
    name: "read_file",
    parameters: Schema.Struct({}),
    replay: "safe" as const,
  });
  const toolLayer = ToolRegistryLive([readFile]);
  const crashingProvider = (toolCallId: string): ProviderService => ({
    streamAssistant: () =>
      Stream.fromIterable([
        { _tag: "toolCall", argumentsJson: "{}", id: toolCallId, name: "read_file" },
        { _tag: "done", stopReason: "toolCalls" },
      ]),
  });
  try {
    const firstCrash = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const turns = yield* Turns;
        const session = yield* sessions.create();
        sessionId = session.id;
        return yield* turns.runTurn(session.id, "first crash");
      }).pipe(
        Effect.provide(
          kernelLayer(
            faultInjectedJournal(directory, 5),
            crashingProvider("first-safe-call"),
            () => Effect.void,
            toolLayer,
          ),
        ),
      ),
    );
    expect(Exit.isFailure(firstCrash)).toBe(true);

    const firstJournalLayer = JournalJsonl(directory);
    const firstResume = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        return yield* sessions.resume(sessionId as SessionId);
      }).pipe(
        Effect.provide(kernelLayer(firstJournalLayer, doneProvider, () => Effect.void, toolLayer)),
      ),
    );
    expect(firstResume.recovery).toMatchObject({
      actions: [{ action: "safe_replay", toolCallId: "first-safe-call" }],
      safeReplay: [{ toolCallId: "first-safe-call" }],
    });

    const secondCrash = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const turns = yield* Turns;
        yield* sessions.resume(sessionId as SessionId);
        return yield* turns.runTurn(sessionId as SessionId, "second crash");
      }).pipe(
        Effect.provide(
          kernelLayer(
            faultInjectedJournal(directory, 4),
            crashingProvider("second-safe-call"),
            () => Effect.void,
            toolLayer,
          ),
        ),
      ),
    );
    expect(Exit.isFailure(secondCrash)).toBe(true);

    const contexts: Array<ReadonlyArray<ContextItem>> = [];
    const contextProvider: ProviderService = {
      streamAssistant: (context) => {
        contexts.push(context);
        return Stream.fromIterable([{ _tag: "done", stopReason: "done" }]);
      },
    };
    const finalJournalLayer = JournalJsonl(directory);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal;
        const sessions = yield* Sessions;
        const turns = yield* Turns;
        const resumed = yield* sessions.resume(sessionId as SessionId);
        yield* turns.runTurn(sessionId as SessionId, "after both crashes");
        return {
          records: yield* journal.readRecords(sessionId as SessionId),
          resumed,
        };
      }).pipe(
        Effect.provide(
          kernelLayer(finalJournalLayer, contextProvider, () => Effect.void, toolLayer),
        ),
      ),
    );

    expect(result.resumed.recovery.safeReplay).toEqual([
      expect.objectContaining({ toolCallId: "second-safe-call" }),
    ]);
    expect(result.records.map((record) => record.kind)).toEqual([
      "operation_started",
      "tool_started",
      "operation_finished",
      "operation_started",
      "tool_started",
      "operation_finished",
      "operation_started",
      "operation_finished",
    ]);
    const recoveredContext = contexts[0] ?? [];
    const called = recoveredContext.flatMap((item) =>
      item.role === "assistant" && "toolCalls" in item ? item.toolCalls.map((call) => call.id) : [],
    );
    const answered = new Set(
      recoveredContext.flatMap((item) =>
        item.role === "toolResult" && "toolCallId" in item ? [item.toolCallId] : [],
      ),
    );
    expect(called).toEqual(["first-safe-call", "second-safe-call"]);
    expect(called.every((toolCallId) => answered.has(toolCallId))).toBe(true);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("JSONL kills after partial and complete Tool results recover without duplicate results", async () => {
  for (const scenario of [
    { failAfter: 7, label: "partial", synthesized: 1 },
    { failAfter: 8, label: "complete", synthesized: 0 },
  ] as const) {
    const directory = await mkdtemp(join(tmpdir(), `peye-kernel-m11-results-${scenario.label}-`));
    let sessionId: SessionId | undefined;
    let requests = 0;
    const provider: ProviderService = {
      streamAssistant: () => {
        requests += 1;
        return requests === 1
          ? Stream.fromIterable([
              { _tag: "toolCall", argumentsJson: "{}", id: "first-call", name: "first_tool" },
              {
                _tag: "toolCall",
                argumentsJson: "{}",
                id: "second-call",
                name: "second_tool",
              },
              { _tag: "done", stopReason: "toolCalls" },
            ])
          : Stream.fromIterable([{ _tag: "done", stopReason: "done" }]);
      },
    };
    const first = defineTool({
      description: "First Tool.",
      execute: () => Effect.succeed({ content: "first result" }),
      name: "first_tool",
      parameters: Schema.Struct({}),
    });
    const second = defineTool({
      description: "Second Tool.",
      execute: () => Effect.succeed({ content: "second result" }),
      name: "second_tool",
      parameters: Schema.Struct({}),
    });
    const toolLayer = ToolRegistryLive([first, second]);
    try {
      const crashed = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const turns = yield* Turns;
          const session = yield* sessions.create();
          sessionId = session.id;
          return yield* turns.runTurn(session.id, `crash after ${scenario.label} results`);
        }).pipe(
          Effect.provide(
            kernelLayer(
              faultInjectedJournal(directory, scenario.failAfter),
              provider,
              () => Effect.void,
              toolLayer,
            ),
          ),
        ),
      );
      expect(Exit.isFailure(crashed)).toBe(true);

      const journalLayer = JournalJsonl(directory);
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const sessions = yield* Sessions;
          const resumed = yield* sessions.resume(sessionId as SessionId);
          return { branch: yield* journal.readBranch(sessionId as SessionId), resumed };
        }).pipe(
          Effect.provide(
            Layer.merge(
              journalLayer,
              kernelLayer(journalLayer, doneProvider, () => Effect.void, toolLayer),
            ),
          ),
        ),
      );

      const toolResults = result.branch.filter((entry) => {
        const payload = entry.payload as { readonly role?: unknown };
        return payload.role === "toolResult";
      });
      expect(toolResults).toHaveLength(2);
      expect(new Set(toolResults.map((entry) => JSON.stringify(entry.payload))).size).toBe(2);
      expect(
        result.resumed.recovery.actions.filter(
          (action) => action.action === "synthesized_interrupted",
        ),
      ).toHaveLength(scenario.synthesized);
      expect(result.resumed.recovery.actions).toHaveLength(2);
      expect(result.resumed.recovery.entriesAppended).toHaveLength(scenario.synthesized + 1);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
});

test("recovery dedupes by operationId and toolCallId after a kill during application", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peye-kernel-m11-application-kill-"));
  let sessionId: SessionId | undefined;
  let promptId: string | undefined;
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal;
        const session = yield* journal.createSession();
        sessionId = session.id;
        yield* journal.appendEntry(
          session.id,
          EntryDraftSchema.make({
            kind: "message",
            payload: {
              content: "historical result",
              isError: false,
              role: "toolResult",
              toolCallId: "reused-call",
            },
          }),
        );
        const prompt = yield* journal.appendEntry(
          session.id,
          EntryDraftSchema.make({
            kind: "message",
            payload: { content: "recover both", role: "user" },
          }),
        );
        promptId = prompt.id;
        const operationId = OperationIdSchema.make("operation-application-kill");
        yield* appendOperationStarted(journal, session.id, {
          intent: "turn",
          operationId,
          promptEntryId: prompt.id,
          turnOrdinal: 1,
        });
        yield* journal.appendEntry(
          session.id,
          EntryDraftSchema.make({
            kind: "message",
            payload: {
              content: "",
              role: "assistant",
              stopReason: "toolCalls",
              toolCalls: [
                { argumentsJson: "{}", id: "reused-call", name: "first_tool" },
                { argumentsJson: "{}", id: "second-call", name: "second_tool" },
              ],
            },
          }),
        );
        yield* appendToolStarted(journal, session.id, {
          operationId,
          replay: "never",
          toolCallId: "reused-call",
          toolName: "first_tool",
        });
        yield* appendToolStarted(journal, session.id, {
          operationId,
          replay: "never",
          toolCallId: "second-call",
          toolName: "second_tool",
        });
      }).pipe(Effect.provide(JournalJsonl(directory))),
    );

    const killedApplication = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        return yield* sessions.resume(sessionId as SessionId);
      }).pipe(
        Effect.provide(
          kernelLayer(faultInjectedJournal(directory, 1), doneProvider, () => Effect.void),
        ),
      ),
    );
    expect(Exit.isFailure(killedApplication)).toBe(true);

    const journalLayer = JournalJsonl(directory);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal;
        const sessions = yield* Sessions;
        const resumed = yield* sessions.resume(sessionId as SessionId);
        return { branch: yield* journal.readBranch(sessionId as SessionId), resumed };
      }).pipe(Effect.provide(Layer.merge(journalLayer, kernelLayer(journalLayer, doneProvider)))),
    );

    const promptIndex = result.branch.findIndex((entry) => entry.id === promptId);
    const recoveredToolCallIds = result.branch.slice(promptIndex).flatMap((entry) => {
      if (typeof entry.payload !== "object" || entry.payload === null) {
        return [];
      }
      const payload = entry.payload as { readonly role?: unknown; readonly toolCallId?: unknown };
      return payload.role === "toolResult" && typeof payload.toolCallId === "string"
        ? [payload.toolCallId]
        : [];
    });
    expect(recoveredToolCallIds).toEqual(["reused-call", "second-call"]);
    expect(result.resumed.recovery.actions).toMatchObject([
      { action: "already_resolved", toolCallId: "reused-call" },
      { action: "synthesized_interrupted", toolCallId: "second-call" },
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
