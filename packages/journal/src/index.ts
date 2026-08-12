/**
 * Owns entries, records, tree and fold inputs, JSONL and in-memory layers, and conformance.
 * It exists to keep journal schema versions and migrations behind one durable boundary.
 */
export const journalPackage = "@pop-eye/journal";

export {
  type ContextItem,
  type FoldAccounting,
  type FoldOptions,
  type FoldResult,
  foldContext,
} from "./context.js";
export {
  ContextBudgetExceeded,
  type JournalCorruptionClass,
  JournalDraftRejected,
  JournalError,
  type JournalFailure,
  JournalNotFound,
} from "./errors.js";
export { type CreatedSession, Journal, type JournalService } from "./journal.js";
export {
  JournalStore,
  type JournalStoreEnv,
  migrateDirectory,
  selectJournalLayer,
} from "./journal-store.js";
export {
  type JournalDiagnostic,
  JournalDiagnosticSchema,
  JournalJsonl,
  type JsonlIoEvent,
  type JsonlJournalIo,
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
export { type MigrateResult, migrateJsonlToSqlite } from "./migrate.js";
export {
  type CompactionEntry,
  CompactionEntrySchema,
  type CompactionPayload,
  CompactionPayloadSchema,
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
export {
  createSqliteJournalHarness,
  JournalSqlite,
  type SqliteJournalOptions,
} from "./sqlite.js";
