/**
 * Owns the durable Entry and Record envelopes shared by every Journal adapter.
 * It exists so each adapter stores the same shapes while storage mechanics remain replaceable.
 */
import { Schema } from "effect";

export const SessionIdSchema = Schema.String.pipe(Schema.brand("SessionId"));

export type SessionId = Schema.Schema.Type<typeof SessionIdSchema>;

export const EntryIdSchema = Schema.String.pipe(Schema.brand("EntryId"));

export type EntryId = Schema.Schema.Type<typeof EntryIdSchema>;

export const CompactionPayloadSchema = Schema.Struct({
  firstSummarizedId: EntryIdSchema,
  lastSummarizedId: EntryIdSchema,
  retainedTailIds: Schema.Array(EntryIdSchema),
  summary: Schema.String,
});

export type CompactionPayload = Schema.Schema.Type<typeof CompactionPayloadSchema>;

export const RecordIdSchema = Schema.String.pipe(Schema.brand("RecordId"));

export type RecordId = Schema.Schema.Type<typeof RecordIdSchema>;

export const EntrySchema = Schema.Struct({
  id: EntryIdSchema,
  kind: Schema.String,
  parentId: Schema.NullOr(EntryIdSchema),
  payload: Schema.Unknown,
});

export type Entry = Schema.Schema.Type<typeof EntrySchema>;

export const CompactionEntrySchema = Schema.Struct({
  id: EntryIdSchema,
  kind: Schema.Literal("compaction"),
  parentId: EntryIdSchema,
  payload: CompactionPayloadSchema,
});

export type CompactionEntry = Schema.Schema.Type<typeof CompactionEntrySchema>;

export const SessionRootEntrySchema = Schema.Struct({
  id: EntryIdSchema,
  kind: Schema.Literal("session_root"),
  parentId: Schema.Literal(null),
  payload: Schema.Struct({}),
});

export type SessionRootEntry = Schema.Schema.Type<typeof SessionRootEntrySchema>;

export const EntryDraftSchema = Schema.Struct({
  kind: Schema.String,
  payload: Schema.Unknown,
}).pipe(Schema.brand("EntryDraft"));

export type EntryDraft = Schema.Schema.Type<typeof EntryDraftSchema>;

export const RecordSchema = Schema.Struct({
  id: RecordIdSchema,
  kind: Schema.String,
  payload: Schema.Unknown,
});

export type Record = Schema.Schema.Type<typeof RecordSchema>;

export const RecordDraftSchema = Schema.Struct({
  kind: Schema.String,
  payload: Schema.Unknown,
}).pipe(Schema.brand("RecordDraft"));

export type RecordDraft = Schema.Schema.Type<typeof RecordDraftSchema>;

export const LeafMovedRecordPayloadSchema = Schema.Struct({
  toEntryId: EntryIdSchema,
});

export const EntryLineSchema = Schema.Struct({
  item: EntrySchema,
  sessionId: SessionIdSchema,
  type: Schema.Literal("entry"),
});

export type EntryLine = Schema.Schema.Type<typeof EntryLineSchema>;

export const RecordLineSchema = Schema.Struct({
  item: RecordSchema,
  sessionId: SessionIdSchema,
  type: Schema.Literal("record"),
});

export type RecordLine = Schema.Schema.Type<typeof RecordLineSchema>;

export const JournalLineSchema = Schema.Union(EntryLineSchema, RecordLineSchema);

export type JournalLine = Schema.Schema.Type<typeof JournalLineSchema>;
