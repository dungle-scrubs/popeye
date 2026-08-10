/**
 * Owns entries, records, tree and fold inputs, JSONL and in-memory layers, and conformance.
 * It exists to keep journal schema versions and migrations behind one durable boundary.
 */
export const journalPackage = "@peye/journal";

export {
  type JournalCorruptionClass,
  JournalDraftRejected,
  JournalError,
  type JournalFailure,
  JournalNotFound,
} from "./errors.js";
export { type CreatedSession, Journal, type JournalService } from "./journal.js";
export {
  createJsonlJournalHarness,
  type JournalDiagnostic,
  JournalDiagnosticSchema,
  JournalJsonl,
  type JsonlJournalOptions,
} from "./jsonl.js";
export {
  createLineCodec,
  type LineCodec,
  type LineCodecConfig,
  type LineVersion,
} from "./line-codec.js";
export {
  createMemoryJournalBacking,
  JournalMemory,
  type MemoryJournalBacking,
} from "./memory.js";
export {
  type Entry,
  type EntryDraft,
  EntryDraftSchema,
  type EntryId,
  EntryIdSchema,
  type EntryLine,
  EntryLineSchema,
  EntrySchema,
  type JournalLine,
  JournalLineSchema,
  LeafMovedRecordPayloadSchema,
  type Record,
  type RecordDraft,
  RecordDraftSchema,
  type RecordId,
  RecordIdSchema,
  type RecordLine,
  RecordLineSchema,
  RecordSchema,
  type SessionId,
  SessionIdSchema,
  type SessionRootEntry,
  SessionRootEntrySchema,
} from "./shapes.js";
