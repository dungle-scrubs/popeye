import {
  createMemoryJournalBacking,
  EntryDraftSchema,
  EntryIdSchema,
  EntrySchema,
  Journal,
  JournalMemory,
  RecordIdSchema,
  RecordSchema,
} from "@peye/journal";
import { Effect } from "effect";
import { expect, test } from "vitest";
import {
  appendOperationStarted,
  appendToolStarted,
  OperationFinishedPayloadSchema,
  OperationIdSchema,
  OperationStartedPayloadSchema,
  ToolStartedPayloadSchema,
} from "./records.js";
import { applyRecoveryPlan, boundedRecoveryRecords, recoverSession } from "./recovery.js";

test("recovery returns an idle plan when the bounded slice has no open operation", async () => {
  const plan = await Effect.runPromise(recoverSession([], []));

  expect(plan).toEqual({
    actions: [],
    assistantEntry: undefined,
    finish: undefined,
    operationId: undefined,
    promptEntryId: undefined,
    safeReplay: [],
    toolResults: [],
  });
});

test("recovery synthesizes an interrupted result for an unresolved replay-never Tool call", async () => {
  const backing = createMemoryJournalBacking();
  const plan = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      const operationId = OperationIdSchema.make("operation-never");
      const prompt = yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({ kind: "message", payload: { content: "run", role: "user" } }),
      );
      yield* appendOperationStarted(
        journal,
        session.id,
        OperationStartedPayloadSchema.make({
          intent: "turn",
          operationId,
          promptEntryId: prompt.id,
          turnOrdinal: 1,
        }),
      );
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: {
            content: "",
            role: "assistant",
            stopReason: "toolCalls",
            toolCalls: [{ argumentsJson: "{}", id: "call-never", name: "write_file" }],
          },
        }),
      );
      yield* appendToolStarted(
        journal,
        session.id,
        ToolStartedPayloadSchema.make({
          operationId,
          replay: "never",
          toolCallId: "call-never",
          toolName: "write_file",
        }),
      );
      return yield* recoverSession(
        yield* journal.readRecords(session.id),
        yield* journal.readBranch(session.id),
      );
    }).pipe(Effect.provide(JournalMemory(backing))),
  );

  expect(plan).toMatchObject({
    actions: [
      {
        action: "synthesized_interrupted",
        replay: "never",
        toolCallId: "call-never",
        toolName: "write_file",
      },
    ],
    assistantEntry: { payload: { diagnostic: { detail: "interrupted by crash" } } },
    finish: { operationId: "operation-never", outcome: "error" },
    operationId: "operation-never",
    safeReplay: [],
    toolResults: [
      {
        kind: "message",
        payload: {
          content: "Tool execution interrupted by crash.",
          isError: true,
          role: "toolResult",
          toolCallId: "call-never",
        },
      },
    ],
  });
});

test("recovery returns an unresolved replay-safe Tool call for later driver execution", async () => {
  const backing = createMemoryJournalBacking();
  const plan = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      const operationId = OperationIdSchema.make("operation-safe");
      const prompt = yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({ kind: "message", payload: { content: "read", role: "user" } }),
      );
      yield* appendOperationStarted(
        journal,
        session.id,
        OperationStartedPayloadSchema.make({
          intent: "turn",
          operationId,
          promptEntryId: prompt.id,
          turnOrdinal: 1,
        }),
      );
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: {
            content: "",
            role: "assistant",
            stopReason: "toolCalls",
            toolCalls: [
              { argumentsJson: '{"path":"README.md"}', id: "call-safe", name: "read_file" },
            ],
          },
        }),
      );
      yield* appendToolStarted(
        journal,
        session.id,
        ToolStartedPayloadSchema.make({
          operationId,
          replay: "safe",
          toolCallId: "call-safe",
          toolName: "read_file",
        }),
      );
      return yield* recoverSession(
        yield* journal.readRecords(session.id),
        yield* journal.readBranch(session.id),
      );
    }).pipe(Effect.provide(JournalMemory(backing))),
  );

  expect(plan).toMatchObject({
    actions: [
      {
        action: "safe_replay",
        replay: "safe",
        toolCallId: "call-safe",
        toolName: "read_file",
      },
    ],
    finish: { operationId: "operation-safe", outcome: "error" },
    safeReplay: [
      {
        argumentsJson: '{"path":"README.md"}',
        name: "read_file",
        operationId: "operation-safe",
        toolCallId: "call-safe",
      },
    ],
    toolResults: [
      {
        kind: "message",
        payload: {
          content: "Tool execution interrupted by crash.",
          isError: true,
          role: "toolResult",
          toolCallId: "call-safe",
        },
      },
    ],
  });
});

test("recovery rejects impossible operation Record sequences with the named corruption class", async () => {
  const started = (id: string, operationId: string) =>
    RecordSchema.make({
      id: RecordIdSchema.make(id),
      kind: "operation_started",
      payload: {
        intent: "turn",
        operationId,
        promptEntryId: "prompt-entry",
        turnOrdinal: 1,
      },
    });
  const scenarios = [
    [started("record-1", "operation-1"), started("record-2", "operation-2")],
    [
      RecordSchema.make({
        id: RecordIdSchema.make("record-3"),
        kind: "tool_started",
        payload: ToolStartedPayloadSchema.make({
          operationId: OperationIdSchema.make("operation-3"),
          replay: "never",
          toolCallId: "call-3",
          toolName: "write_file",
        }),
      }),
    ],
    [
      RecordSchema.make({
        id: RecordIdSchema.make("record-4"),
        kind: "operation_finished",
        payload: OperationFinishedPayloadSchema.make({
          operationId: OperationIdSchema.make("operation-4"),
          outcome: "done",
        }),
      }),
    ],
  ];

  for (const records of scenarios) {
    const error = await Effect.runPromise(Effect.flip(recoverSession(records, [])));
    expect(error).toMatchObject({
      _tag: "JournalError",
      corruptionClass: "invalid_record_sequence",
    });
  }
});

test("recovery validates kernel Record payload schemas when reading", async () => {
  const malformed = RecordSchema.make({
    id: RecordIdSchema.make("malformed-operation-start"),
    kind: "operation_started",
    payload: {
      intent: "turn",
      operationId: "operation-malformed",
      promptEntryId: "prompt-entry",
      turnOrdinal: 0,
    },
  });

  const error = await Effect.runPromise(Effect.flip(recoverSession([malformed], [])));

  expect(error).toMatchObject({
    _tag: "JournalError",
    corruptionClass: "schema_mismatch",
  });
});

test("recovery validates message Entry payload schemas when reading", async () => {
  const prompt = EntrySchema.make({
    id: EntryIdSchema.make("malformed-message-prompt"),
    kind: "message",
    parentId: null,
    payload: { content: 42, role: "user" },
  });
  const started = RecordSchema.make({
    id: RecordIdSchema.make("malformed-message-start"),
    kind: "operation_started",
    payload: {
      intent: "turn",
      operationId: "operation-malformed-message",
      promptEntryId: prompt.id,
      turnOrdinal: 1,
    },
  });

  const error = await Effect.runPromise(Effect.flip(recoverSession([started], [prompt])));

  expect(error).toMatchObject({
    _tag: "JournalError",
    corruptionClass: "schema_mismatch",
  });
});

test("recovery degrades an off-branch prompt and rejects a missing assistant Tool call", async () => {
  const started = RecordSchema.make({
    id: RecordIdSchema.make("relationship-start"),
    kind: "operation_started",
    payload: {
      intent: "turn",
      operationId: "operation-relationship",
      promptEntryId: "relationship-prompt",
      turnOrdinal: 1,
    },
  });
  const toolStarted = RecordSchema.make({
    id: RecordIdSchema.make("relationship-tool"),
    kind: "tool_started",
    payload: {
      operationId: "operation-relationship",
      replay: "never",
      toolCallId: "relationship-call",
      toolName: "write_file",
    },
  });
  const prompt = EntrySchema.make({
    id: EntryIdSchema.make("relationship-prompt"),
    kind: "message",
    parentId: null,
    payload: { content: "write", role: "user" },
  });

  const offBranch = await Effect.runPromise(recoverSession([started, toolStarted], []));
  expect(offBranch).toMatchObject({
    actions: [
      {
        action: "unrecoverable-on-this-branch",
        operationId: "operation-relationship",
        promptEntryId: "relationship-prompt",
      },
    ],
    assistantEntry: undefined,
    finish: { operationId: "operation-relationship", outcome: "error" },
    toolResults: [],
  });

  const error = await Effect.runPromise(
    Effect.flip(recoverSession([started, toolStarted], [prompt])),
  );
  expect(error).toMatchObject({
    _tag: "JournalError",
    corruptionClass: "invalid_record_sequence",
  });
});

test("recovery application is idempotent when the same plan is applied twice", async () => {
  const backing = createMemoryJournalBacking();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      const operationId = OperationIdSchema.make("operation-idempotent");
      const prompt = yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({ kind: "message", payload: { content: "run", role: "user" } }),
      );
      yield* appendOperationStarted(
        journal,
        session.id,
        OperationStartedPayloadSchema.make({
          intent: "turn",
          operationId,
          promptEntryId: prompt.id,
          turnOrdinal: 1,
        }),
      );
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: {
            content: "",
            role: "assistant",
            stopReason: "toolCalls",
            toolCalls: [{ argumentsJson: "{}", id: "call-idempotent", name: "write_file" }],
          },
        }),
      );
      yield* appendToolStarted(
        journal,
        session.id,
        ToolStartedPayloadSchema.make({
          operationId,
          replay: "never",
          toolCallId: "call-idempotent",
          toolName: "write_file",
        }),
      );
      const plan = yield* recoverSession(
        yield* journal.readRecords(session.id),
        yield* journal.readBranch(session.id),
      );
      const first = yield* applyRecoveryPlan(journal, session.id, plan);
      const second = yield* applyRecoveryPlan(journal, session.id, plan);
      return {
        branch: yield* journal.readBranch(session.id),
        first,
        records: yield* journal.readRecords(session.id),
        second,
      };
    }).pipe(Effect.provide(JournalMemory(backing))),
  );

  const toolResults = result.branch.filter((entry) => {
    const payload = entry.payload as { readonly role?: unknown };
    return payload.role === "toolResult";
  });
  const recoveredAssistants = result.branch.filter((entry) => {
    const payload = entry.payload as {
      readonly diagnostic?: { readonly detail?: unknown; readonly reason?: unknown };
      readonly role?: unknown;
    };
    return (
      payload.role === "assistant" &&
      payload.diagnostic?.detail === "interrupted by crash" &&
      payload.diagnostic.reason === "turn_failure"
    );
  });
  const finished = result.records.filter((record) => {
    const payload = record.payload as { readonly operationId?: unknown };
    return record.kind === "operation_finished" && payload.operationId === "operation-idempotent";
  });

  expect(toolResults).toHaveLength(1);
  expect(recoveredAssistants).toHaveLength(1);
  expect(finished).toHaveLength(1);
  expect(result.first.entriesAppended).toHaveLength(2);
  expect(result.second.entriesAppended).toEqual([]);
});

test("recovery parses only Records strictly after the last finished operation", async () => {
  const record = (id: string, kind: string, payload: unknown) =>
    RecordSchema.make({ id: RecordIdSchema.make(id), kind, payload });
  const boundaryOperationId = OperationIdSchema.make("operation-boundary");
  const openOperationId = OperationIdSchema.make("operation-after-boundary");
  const records = [
    record(
      "old-orphan",
      "tool_started",
      ToolStartedPayloadSchema.make({
        operationId: OperationIdSchema.make("old-corrupt-operation"),
        replay: "never",
        toolCallId: "old-call",
        toolName: "old_tool",
      }),
    ),
    record("boundary-start", "operation_started", {
      intent: "turn",
      operationId: boundaryOperationId,
      promptEntryId: "boundary-prompt",
      turnOrdinal: 1,
    }),
    record(
      "boundary-finish",
      "operation_finished",
      OperationFinishedPayloadSchema.make({ operationId: boundaryOperationId, outcome: "done" }),
    ),
    record("open-start", "operation_started", {
      intent: "turn",
      operationId: openOperationId,
      promptEntryId: "open-prompt",
      turnOrdinal: 2,
    }),
  ];

  const bounded = boundedRecoveryRecords(records);
  const plan = await Effect.runPromise(
    recoverSession(bounded, [
      EntrySchema.make({
        id: EntryIdSchema.make("open-prompt"),
        kind: "message",
        parentId: null,
        payload: { content: "open", role: "user" },
      }),
    ]),
  );

  expect(bounded.map((item) => item.id)).toEqual(["open-start"]);
  expect(plan.operationId).toBe("operation-after-boundary");
});

test("recovery closes an open operation after its prompt moves off the current Branch", async () => {
  const backing = createMemoryJournalBacking();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      const prompt = yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: { content: "first branch", role: "user" },
        }),
      );
      const operationId = OperationIdSchema.make("operation-off-branch");
      yield* appendOperationStarted(journal, session.id, {
        intent: "turn",
        operationId,
        promptEntryId: prompt.id,
        turnOrdinal: 1,
      });
      yield* journal.moveLeaf(session.id, session.rootEntry.id);
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: { content: "second branch", role: "user" },
        }),
      );
      const branchBefore = yield* journal.readBranch(session.id);
      const plan = yield* recoverSession(
        boundedRecoveryRecords(yield* journal.readRecords(session.id)),
        branchBefore,
      );
      const report = yield* applyRecoveryPlan(journal, session.id, plan);
      return {
        branchAfter: yield* journal.readBranch(session.id),
        branchBefore,
        records: yield* journal.readRecords(session.id),
        report,
      };
    }).pipe(Effect.provide(JournalMemory(backing))),
  );

  expect(result.report).toMatchObject({
    actions: [
      {
        action: "unrecoverable-on-this-branch",
        operationId: "operation-off-branch",
      },
    ],
    entriesAppended: [],
    operationIdFound: "operation-off-branch",
  });
  expect(result.branchAfter).toEqual(result.branchBefore);
  expect(result.records.at(-1)).toMatchObject({
    kind: "operation_finished",
    payload: { operationId: "operation-off-branch", outcome: "error" },
  });
});

test("recovery synthesizes a safe Tool result when that Tool is absent from the registry", async () => {
  const backing = createMemoryJournalBacking();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      const operationId = OperationIdSchema.make("operation-safe-missing");
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
            toolCalls: [{ argumentsJson: "{}", id: "missing-safe-call", name: "read_file" }],
          },
        }),
      );
      yield* appendToolStarted(journal, session.id, {
        operationId,
        replay: "safe",
        toolCallId: "missing-safe-call",
        toolName: "read_file",
      });
      const plan = yield* recoverSession(
        yield* journal.readRecords(session.id),
        yield* journal.readBranch(session.id),
      );
      const report = yield* applyRecoveryPlan(journal, session.id, plan, {
        availableToolNames: new Set(),
      });
      return { branch: yield* journal.readBranch(session.id), report };
    }).pipe(Effect.provide(JournalMemory(backing))),
  );

  expect(result.report).toMatchObject({
    actions: [{ action: "synthesized_missing_tool", toolCallId: "missing-safe-call" }],
    safeReplay: [],
  });
  expect(result.branch.at(-2)?.payload).toMatchObject({
    content: "Tool execution interrupted by crash.",
    isError: true,
    role: "toolResult",
    toolCallId: "missing-safe-call",
  });
});

test("recovery reports resolved calls and synthesizes only missing results after a partial batch", async () => {
  const backing = createMemoryJournalBacking();
  const plan = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      const operationId = OperationIdSchema.make("operation-partial-results");
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
            toolCalls: [
              { argumentsJson: "{}", id: "completed-call", name: "first_tool" },
              { argumentsJson: "{}", id: "missing-call", name: "second_tool" },
            ],
          },
        }),
      );
      yield* appendToolStarted(journal, session.id, {
        operationId,
        replay: "never",
        toolCallId: "completed-call",
        toolName: "first_tool",
      });
      yield* appendToolStarted(journal, session.id, {
        operationId,
        replay: "never",
        toolCallId: "missing-call",
        toolName: "second_tool",
      });
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: {
            content: "completed",
            isError: false,
            role: "toolResult",
            toolCallId: "completed-call",
            toolName: "first_tool",
          },
        }),
      );
      return yield* recoverSession(
        yield* journal.readRecords(session.id),
        yield* journal.readBranch(session.id),
      );
    }).pipe(Effect.provide(JournalMemory(backing))),
  );

  expect(plan.actions).toMatchObject([
    {
      action: "already_resolved",
      replay: "never",
      toolCallId: "completed-call",
      toolName: "first_tool",
    },
    {
      action: "synthesized_interrupted",
      replay: "never",
      toolCallId: "missing-call",
      toolName: "second_tool",
    },
  ]);
  expect(plan.toolResults).toHaveLength(1);
  expect(plan.toolResults[0]?.payload).toMatchObject({ toolCallId: "missing-call" });
});

test("tool-result idempotency is scoped by operationId when Tool call ids repeat", async () => {
  const backing = createMemoryJournalBacking();
  const plan = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: {
            content: "old result",
            isError: false,
            role: "toolResult",
            toolCallId: "reused-call",
            toolName: "historical_tool",
          },
        }),
      );
      const prompt = yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({ kind: "message", payload: { content: "again", role: "user" } }),
      );
      const operationId = OperationIdSchema.make("operation-with-reused-call");
      yield* appendOperationStarted(journal, session.id, {
        intent: "turn",
        operationId,
        promptEntryId: prompt.id,
        turnOrdinal: 2,
      });
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: {
            content: "",
            role: "assistant",
            stopReason: "toolCalls",
            toolCalls: [{ argumentsJson: "{}", id: "reused-call", name: "write_file" }],
          },
        }),
      );
      yield* appendToolStarted(journal, session.id, {
        operationId,
        replay: "never",
        toolCallId: "reused-call",
        toolName: "write_file",
      });
      return yield* recoverSession(
        yield* journal.readRecords(session.id),
        yield* journal.readBranch(session.id),
      );
    }).pipe(Effect.provide(JournalMemory(backing))),
  );

  expect(plan.actions).toMatchObject([
    { action: "synthesized_interrupted", toolCallId: "reused-call" },
  ]);
  expect(plan.toolResults).toHaveLength(1);
});

test("recovery closes an open operation that crashed while streaming", async () => {
  const backing = createMemoryJournalBacking();
  const plan = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      const prompt = yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({ kind: "message", payload: { content: "hello", role: "user" } }),
      );
      yield* appendOperationStarted(
        journal,
        session.id,
        OperationStartedPayloadSchema.make({
          intent: "turn",
          operationId: OperationIdSchema.make("operation-streaming"),
          promptEntryId: prompt.id,
          turnOrdinal: 1,
        }),
      );
      return yield* recoverSession(
        yield* journal.readRecords(session.id),
        yield* journal.readBranch(session.id),
      );
    }).pipe(Effect.provide(JournalMemory(backing))),
  );

  expect(plan).toMatchObject({
    actions: [],
    assistantEntry: {
      kind: "message",
      payload: {
        content: "Turn interrupted by crash.",
        diagnostic: { detail: "interrupted by crash", reason: "turn_failure" },
        role: "assistant",
        stopReason: "error",
      },
    },
    finish: { operationId: "operation-streaming", outcome: "error" },
    operationId: "operation-streaming",
    safeReplay: [],
    toolResults: [],
  });
});
