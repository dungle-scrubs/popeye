/**
 * Owns journal corruption failures so callers can distinguish rejected durable content.
 * It exists because recovery must preserve the reason a journal cannot be used.
 */
import { Data } from "effect";

export type JournalCorruptionClass =
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
