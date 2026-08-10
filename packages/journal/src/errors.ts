/**
 * Owns journal corruption failures so callers can distinguish rejected durable content.
 * It exists because recovery must preserve the reason a journal cannot be used.
 */
import { Data } from "effect";

import type { EntryId } from "./shapes.js";

/**
 * Owns journal-local context budget failures until the kernel maps them into its failure taxonomy.
 * It exists to keep the journal independent from the kernel while retaining budget diagnostics.
 */
export class ContextBudgetExceeded extends Data.TaggedError("ContextBudgetExceeded")<{
  readonly budget: number;
  readonly compactionApplied?: EntryId;
  readonly optionsDiagnostic: string;
  readonly required: number;
}> {}

export type JournalCorruptionClass =
  | "dangling_leaf_reference"
  | "invalid_compaction"
  | "invalid_record_sequence"
  | "io_failure"
  | "malformed_json"
  | "schema_mismatch"
  | "missing_migration"
  | "migration_failed"
  | "unsupported_version";

export class JournalError extends Data.TaggedError("JournalError")<{
  readonly cause?: unknown;
  readonly corruptionClass: JournalCorruptionClass;
  readonly file?: string;
  readonly message: string;
}> {}

export class JournalNotFound extends Data.TaggedError("JournalNotFound")<{
  readonly id: string;
  readonly what: "entry" | "session";
}> {}

export class JournalDraftRejected extends Data.TaggedError("JournalDraftRejected")<{
  readonly cause?: unknown;
  readonly kind: string;
  readonly message?: string;
  readonly reason: "invalid_payload" | "reserved_kind";
}> {}

export type JournalFailure = JournalDraftRejected | JournalError | JournalNotFound;
