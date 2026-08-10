import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryJournalBacking,
  EntryDraftSchema,
  Journal,
  JournalJsonl,
  JournalMemory,
  RecordDraftSchema,
  SessionIdSchema,
} from "@peye/journal";
import { Effect, type Exit, Layer, Schema, Tracer } from "effect";
import { expect, test } from "vitest";

import { MailboxLive } from "./mailbox.js";
import { appendOperationStarted, appendToolStarted, OperationIdSchema } from "./records.js";
import type { RecoveryReport } from "./recovery.js";
import { Sessions, SessionsLive } from "./sessions.js";
import { defineTool, ToolRegistryLive } from "./tool.js";

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

test("create opens a journal-backed session at the root revision", async () => {
  const backing = createMemoryJournalBacking();
  const layer = SessionsLive().pipe(
    Layer.provide(ToolRegistryLive([])),
    Layer.provide(MailboxLive()),
    Layer.provide(JournalMemory(backing)),
  );

  const created = await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      return yield* sessions.create();
    }).pipe(Effect.provide(layer)),
  );

  expect(created).toMatchObject({ revision: 1 });
  expect(created.id).toEqual(expect.any(String));
  expect(created.leaf.id).toEqual(expect.any(String));
  expect(created.leaf.kind).toBe("session_root");
});

test("resume restores the journal leaf and count of durable lines", async () => {
  const backing = createMemoryJournalBacking();
  const makeLayer = () =>
    SessionsLive().pipe(
      Layer.provide(ToolRegistryLive([])),
      Layer.provide(MailboxLive()),
      Layer.provide(JournalMemory(backing)),
    );
  const created = await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      return yield* sessions.create();
    }).pipe(Effect.provide(makeLayer())),
  );

  const leaf = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const entry = yield* journal.appendEntry(
        created.id,
        EntryDraftSchema.make({ kind: "user_input", payload: { text: "hello" } }),
      );
      yield* journal.appendRecord(
        created.id,
        RecordDraftSchema.make({ kind: "command_started", payload: {} }),
      );
      return entry;
    }).pipe(Effect.provide(JournalMemory(backing))),
  );

  const resumed = await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      return yield* sessions.resume(created.id);
    }).pipe(Effect.provide(makeLayer())),
  );

  expect(resumed).toMatchObject({ id: created.id, leaf: { id: leaf.id }, revision: 3 });
});

test("list reports every journal-backed session with its revision", async () => {
  const backing = createMemoryJournalBacking();
  const layer = SessionsLive().pipe(
    Layer.provide(ToolRegistryLive([])),
    Layer.provide(MailboxLive()),
    Layer.provide(JournalMemory(backing)),
  );

  const listed = await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const first = yield* sessions.create();
      const second = yield* sessions.create();
      const listed = yield* sessions.list();
      return { first, listed, second };
    }).pipe(Effect.provide(layer)),
  );

  expect(listed.listed).toEqual([
    { id: listed.first.id, revision: 1 },
    { id: listed.second.id, revision: 1 },
  ]);
});

test("resume of a nonexistent session fails with the Journal's typed not-found failure", async () => {
  const backing = createMemoryJournalBacking();
  const layer = SessionsLive().pipe(
    Layer.provide(ToolRegistryLive([])),
    Layer.provide(MailboxLive()),
    Layer.provide(JournalMemory(backing)),
  );

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      return yield* Effect.flip(sessions.resume(SessionIdSchema.make("missing-session")));
    }).pipe(Effect.provide(layer)),
  );

  expect(error).toMatchObject({ _tag: "JournalNotFound", id: "missing-session", what: "session" });
});

test("JSONL lifecycle derives revision after appends and removes its temporary directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peye-kernel-m7-"));
  const makeLayer = () =>
    SessionsLive().pipe(
      Layer.provide(ToolRegistryLive([])),
      Layer.provide(MailboxLive()),
      Layer.provide(JournalJsonl(directory)),
    );

  try {
    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        return yield* sessions.create();
      }).pipe(Effect.provide(makeLayer())),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal;
        yield* journal.appendEntry(
          created.id,
          EntryDraftSchema.make({ kind: "user_input", payload: { text: "hello" } }),
        );
        yield* journal.appendRecord(
          created.id,
          RecordDraftSchema.make({ kind: "command_started", payload: {} }),
        );
      }).pipe(Effect.provide(JournalJsonl(directory))),
    );
    const resumed = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        return yield* sessions.resume(created.id);
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(resumed).toMatchObject({ id: created.id, revision: 3 });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("resume applies crash recovery through the mailbox and emits its structured report", async () => {
  const backing = createMemoryJournalBacking();
  const prepared = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      const operationId = OperationIdSchema.make("operation-resume");
      const prompt = yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({ kind: "message", payload: { content: "run", role: "user" } }),
      );
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
            toolCalls: [{ argumentsJson: "{}", id: "resume-call", name: "write_file" }],
          },
        }),
      );
      yield* appendToolStarted(journal, session.id, {
        operationId,
        replay: "never",
        toolCallId: "resume-call",
        toolName: "write_file",
      });
      return session;
    }).pipe(Effect.provide(JournalMemory(backing))),
  );
  const reports: Array<RecoveryReport> = [];
  const journalLayer = JournalMemory(backing);
  const mailboxLayer = MailboxLive().pipe(Layer.provide(journalLayer));
  const layer = SessionsLive({
    recoveryDiagnosticSink: (report) => Effect.sync(() => reports.push(report)),
  }).pipe(Layer.provide(Layer.mergeAll(journalLayer, mailboxLayer, ToolRegistryLive([]))));

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const resumed = yield* sessions.resume(prepared.id);
      return {
        branch: yield* journal.readBranch(prepared.id),
        records: yield* journal.readRecords(prepared.id),
        resumed,
      };
    }).pipe(Effect.provide(Layer.merge(journalLayer, layer))),
  );

  expect(result.resumed.recovery).toMatchObject({
    actions: [{ action: "synthesized_interrupted", toolCallId: "resume-call" }],
    entriesAppended: [expect.any(String), expect.any(String)],
    operationIdFound: "operation-resume",
    safeReplay: [],
  });
  expect(reports).toEqual([result.resumed.recovery]);
  expect(result.branch.at(-2)?.payload).toMatchObject({
    role: "toolResult",
    toolCallId: "resume-call",
  });
  expect(result.branch.at(-1)?.payload).toMatchObject({ role: "assistant", stopReason: "error" });
  expect(result.records.at(-1)).toMatchObject({
    kind: "operation_finished",
    payload: { operationId: "operation-resume", outcome: "error" },
  });
});

test("resume returns a registered replay-safe Tool call for later driver execution", async () => {
  const backing = createMemoryJournalBacking();
  const prepared = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      const operationId = OperationIdSchema.make("operation-safe-resume");
      const prompt = yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({ kind: "message", payload: { content: "read", role: "user" } }),
      );
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
              { argumentsJson: '{"path":"README.md"}', id: "safe-resume-call", name: "read_file" },
            ],
          },
        }),
      );
      yield* appendToolStarted(journal, session.id, {
        operationId,
        replay: "safe",
        toolCallId: "safe-resume-call",
        toolName: "read_file",
      });
      return session;
    }).pipe(Effect.provide(JournalMemory(backing))),
  );
  const readFile = defineTool({
    description: "Reads a file.",
    execute: () => Effect.succeed({ content: "unused" }),
    name: "read_file",
    parameters: Schema.Struct({ path: Schema.String }),
    replay: "safe" as const,
  });
  const journalLayer = JournalMemory(backing);
  const mailboxLayer = MailboxLive().pipe(Layer.provide(journalLayer));
  const sessionsLayer = SessionsLive({ recoveryDiagnosticSink: () => Effect.void }).pipe(
    Layer.provide(Layer.mergeAll(journalLayer, mailboxLayer, ToolRegistryLive([readFile]))),
  );

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const resumed = yield* sessions.resume(prepared.id);
      const resumedAgain = yield* sessions.resume(prepared.id);
      return {
        branch: yield* journal.readBranch(prepared.id),
        records: yield* journal.readRecords(prepared.id),
        resumed,
        resumedAgain,
      };
    }).pipe(Effect.provide(Layer.merge(journalLayer, sessionsLayer))),
  );

  expect(result.resumed.recovery).toMatchObject({
    actions: [{ action: "safe_replay", toolCallId: "safe-resume-call" }],
    safeReplay: [
      {
        argumentsJson: '{"path":"README.md"}',
        name: "read_file",
        operationId: "operation-safe-resume",
        toolCallId: "safe-resume-call",
      },
    ],
  });
  expect(result.resumedAgain.recovery.safeReplay).toEqual(result.resumed.recovery.safeReplay);
  expect(result.records.some((record) => record.kind === "operation_finished")).toBe(false);
  expect(
    result.branch.some((entry) => {
      const payload = entry.payload as { readonly role?: unknown };
      return payload.role === "toolResult";
    }),
  ).toBe(false);
});

test("resume traces recovery with session, operation, action, append, and safe-replay annotations", async () => {
  const backing = createMemoryJournalBacking();
  const prepared = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      const operationId = OperationIdSchema.make("operation-observed");
      const prompt = yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({ kind: "message", payload: { content: "continue", role: "user" } }),
      );
      yield* appendOperationStarted(journal, session.id, {
        intent: "turn",
        operationId,
        promptEntryId: prompt.id,
        turnOrdinal: 1,
      });
      return session;
    }).pipe(Effect.provide(JournalMemory(backing))),
  );
  const spans: Array<CapturedSpan> = [];
  const journalLayer = JournalMemory(backing);
  const mailboxLayer = MailboxLive().pipe(Layer.provide(journalLayer));
  const sessionsLayer = SessionsLive({ recoveryDiagnosticSink: () => Effect.void }).pipe(
    Layer.provide(Layer.mergeAll(journalLayer, mailboxLayer, ToolRegistryLive([]))),
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      yield* sessions.resume(prepared.id);
    }).pipe(Effect.provide(Layer.merge(sessionsLayer, tracerLayer(spans)))),
  );

  const recoverySpan = spans.find(({ name }) => name === "kernel.recovery");
  expect(recoverySpan?.attributes).toEqual(
    new Map<string, unknown>([
      ["sessionId", prepared.id],
      ["actionCount", 0],
      ["entriesAppendedCount", 1],
      ["operationIdFound", "operation-observed"],
      ["safeReplayCount", 0],
    ]),
  );
  expect(recoverySpan?.exit?._tag).toBe("Success");
});
