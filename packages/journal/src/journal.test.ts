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
