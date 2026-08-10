/**
 * Owns entries, records, tree and fold inputs, JSONL and in-memory layers, and conformance.
 * It exists to keep journal schema versions and migrations behind one durable boundary.
 */
export const journalPackage = "@peye/journal";

export { type JournalCorruptionClass, JournalError, JournalNotFound } from "./errors.js";
export { type CreatedSession, Journal, type JournalService } from "./journal.js";
export {
  createLineCodec,
  type LineCodec,
  type LineCodecConfig,
  type LineVersion,
} from "./line-codec.js";
export { createJournalMemoryStore, JournalMemory, type JournalMemoryStore } from "./memory.js";
export {
  type Entry,
  type EntryDraft,
  EntryDraftSchema,
  EntryIdSchema,
  EntrySchema,
  type JournalLine,
  type LeafMovedRecord,
  LeafMovedRecordPayloadSchema,
  LeafMovedRecordSchema,
  type Record,
  type RecordDraft,
  RecordDraftSchema,
  RecordSchema,
  type SessionRootEntry,
  SessionRootEntrySchema,
} from "./shapes.js";
