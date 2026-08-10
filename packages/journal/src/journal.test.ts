import { Effect } from "effect";
import { expect, test } from "vitest";

import { leafFor } from "./journal.js";
import {
  EntryIdSchema,
  EntryLineSchema,
  EntrySchema,
  RecordIdSchema,
  RecordLineSchema,
  RecordSchema,
  SessionIdSchema,
} from "./shapes.js";

const sessionId = SessionIdSchema.make("session");
const rootEntry = EntrySchema.make({
  id: EntryIdSchema.make("root"),
  kind: "session_root",
  parentId: null,
  payload: {},
});

const rootLine = EntryLineSchema.make({ item: rootEntry, sessionId, type: "entry" });

test("leafFor rejects a malformed leaf_moved payload as corruption", async () => {
  const malformedRecord = RecordSchema.make({
    id: RecordIdSchema.make("record"),
    kind: "leaf_moved",
    payload: {},
  });
  const error = await Effect.runPromise(
    Effect.flip(
      leafFor([
        rootLine,
        RecordLineSchema.make({ item: malformedRecord, sessionId, type: "record" }),
      ]),
    ),
  );

  expect(error).toMatchObject({ _tag: "JournalError", corruptionClass: "schema_mismatch" });
});

test("leafFor rejects a dangling leaf_moved target as corruption", async () => {
  const danglingRecord = RecordSchema.make({
    id: RecordIdSchema.make("record"),
    kind: "leaf_moved",
    payload: { toEntryId: EntryIdSchema.make("missing") },
  });
  const error = await Effect.runPromise(
    Effect.flip(
      leafFor([
        rootLine,
        RecordLineSchema.make({ item: danglingRecord, sessionId, type: "record" }),
      ]),
    ),
  );

  expect(error).toMatchObject({
    _tag: "JournalError",
    corruptionClass: "dangling_leaf_reference",
  });
});

test("leafFor rejects a compaction entry with a malformed strict payload", async () => {
  const malformedCompaction = EntrySchema.make({
    id: EntryIdSchema.make("compaction"),
    kind: "compaction",
    parentId: rootEntry.id,
    payload: { summary: "Missing summarized ids and retained tail." },
  });
  const error = await Effect.runPromise(
    Effect.flip(
      leafFor([
        rootLine,
        EntryLineSchema.make({ item: malformedCompaction, sessionId, type: "entry" }),
      ]),
    ),
  );

  expect(error).toMatchObject({ _tag: "JournalError", corruptionClass: "schema_mismatch" });
});

test("leafFor rejects a compaction with dangling or reversed coverage as corruption", async () => {
  const first = EntrySchema.make({
    id: EntryIdSchema.make("first"),
    kind: "user_input",
    parentId: rootEntry.id,
    payload: {},
  });
  const second = EntrySchema.make({
    id: EntryIdSchema.make("second"),
    kind: "assistant_output",
    parentId: first.id,
    payload: {},
  });
  const dangling = EntrySchema.make({
    id: EntryIdSchema.make("dangling"),
    kind: "compaction",
    parentId: second.id,
    payload: {
      firstSummarizedId: EntryIdSchema.make("missing"),
      lastSummarizedId: second.id,
      retainedTailIds: [],
      summary: "Summary.",
    },
  });
  const reversed = EntrySchema.make({
    id: EntryIdSchema.make("reversed"),
    kind: "compaction",
    parentId: second.id,
    payload: {
      firstSummarizedId: second.id,
      lastSummarizedId: first.id,
      retainedTailIds: [],
      summary: "Summary.",
    },
  });
  const danglingError = await Effect.runPromise(
    Effect.flip(
      leafFor([
        rootLine,
        EntryLineSchema.make({ item: first, sessionId, type: "entry" }),
        EntryLineSchema.make({ item: second, sessionId, type: "entry" }),
        EntryLineSchema.make({ item: dangling, sessionId, type: "entry" }),
      ]),
    ),
  );
  const reversedError = await Effect.runPromise(
    Effect.flip(
      leafFor([
        rootLine,
        EntryLineSchema.make({ item: first, sessionId, type: "entry" }),
        EntryLineSchema.make({ item: second, sessionId, type: "entry" }),
        EntryLineSchema.make({ item: reversed, sessionId, type: "entry" }),
      ]),
    ),
  );

  expect(danglingError).toMatchObject({
    _tag: "JournalError",
    corruptionClass: "invalid_compaction",
    message: expect.stringContaining("missing"),
  });
  expect(reversedError).toMatchObject({
    _tag: "JournalError",
    corruptionClass: "invalid_compaction",
    message: expect.stringContaining("second"),
  });
});
