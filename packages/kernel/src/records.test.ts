import {
  createMemoryJournalBacking,
  EntryDraftSchema,
  Journal,
  JournalMemory,
} from "@popeye/journal";
import { Effect } from "effect";
import { expect, test } from "vitest";

import {
  appendOperationFinished,
  appendOperationStarted,
  appendToolStarted,
  createOperationId,
  OperationFinishedPayloadSchema,
  OperationIdSchema,
  OperationStartedPayloadSchema,
  ToolStartedPayloadSchema,
} from "./records.js";

test("operation id randomness runs inside Effect", async () => {
  const operationIdEffect = createOperationId();

  expect(Effect.isEffect(operationIdEffect)).toBe(true);
  await expect(Effect.runPromise(operationIdEffect)).resolves.toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
});

test("operation-started writer persists its recovery identity through the Journal seam", async () => {
  const backing = createMemoryJournalBacking();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      const prompt = yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({ kind: "message", payload: { content: "hello", role: "user" } }),
      );
      const payload = OperationStartedPayloadSchema.make({
        intent: "turn",
        operationId: OperationIdSchema.make("operation-1"),
        promptEntryId: prompt.id,
        turnOrdinal: 1,
      });
      const appended = yield* appendOperationStarted(journal, session.id, payload);
      return { appended, records: yield* journal.readRecords(session.id) };
    }).pipe(Effect.provide(JournalMemory(backing))),
  );

  expect(result.appended).toMatchObject({
    kind: "operation_started",
    payload: {
      intent: "turn",
      operationId: "operation-1",
      promptEntryId: expect.any(String),
      turnOrdinal: 1,
    },
  });
  expect(result.records).toEqual([result.appended]);
});

test("tool-started and operation-finished writers persist replay and outcome", async () => {
  const backing = createMemoryJournalBacking();
  const records = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      const operationId = OperationIdSchema.make("operation-2");
      yield* appendToolStarted(
        journal,
        session.id,
        ToolStartedPayloadSchema.make({
          operationId,
          replay: "safe",
          toolCallId: "call-1",
          toolName: "read_file",
        }),
      );
      yield* appendOperationFinished(
        journal,
        session.id,
        OperationFinishedPayloadSchema.make({ operationId, outcome: "done" }),
      );
      return yield* journal.readRecords(session.id);
    }).pipe(Effect.provide(JournalMemory(backing))),
  );

  expect(records).toMatchObject([
    {
      kind: "tool_started",
      payload: {
        operationId: "operation-2",
        replay: "safe",
        toolCallId: "call-1",
        toolName: "read_file",
      },
    },
    { kind: "operation_finished", payload: { operationId: "operation-2", outcome: "done" } },
  ]);
});
