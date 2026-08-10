/**
 * Owns the durable Entry and Record envelopes shared by every Journal adapter.
 * It exists so each adapter stores the same shapes while storage mechanics remain replaceable.
 */
import { Schema } from "effect";

export const EntryIdSchema = Schema.String;

export const EntrySchema = Schema.Struct({
  id: EntryIdSchema,
  kind: Schema.String,
  parentId: Schema.NullOr(EntryIdSchema),
  payload: Schema.Unknown,
});

export type Entry = Schema.Schema.Type<typeof EntrySchema>;

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
});

export type EntryDraft = Schema.Schema.Type<typeof EntryDraftSchema>;

export const RecordSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  payload: Schema.Unknown,
});

export type Record = Schema.Schema.Type<typeof RecordSchema>;

export const RecordDraftSchema = Schema.Struct({
  kind: Schema.String,
  payload: Schema.Unknown,
});

export type RecordDraft = Schema.Schema.Type<typeof RecordDraftSchema>;

export const LeafMovedRecordPayloadSchema = Schema.Struct({
  toEntryId: EntryIdSchema,
});

export const LeafMovedRecordSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("leaf_moved"),
  payload: LeafMovedRecordPayloadSchema,
});

export type LeafMovedRecord = Schema.Schema.Type<typeof LeafMovedRecordSchema>;

export interface JournalLine {
  readonly item: Entry | Record;
  readonly sessionId: string;
}
