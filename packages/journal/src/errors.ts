/**
 * Owns journal corruption failures so callers can distinguish rejected durable content.
 * It exists because recovery must preserve the reason a journal cannot be used.
 */
import { Data } from "effect";

export type JournalCorruptionClass =
  | "malformed_json"
  | "missing_migration"
  | "schema_mismatch"
  | (string & {});

export class JournalError extends Data.TaggedError("JournalError")<{
  readonly corruptionClass: JournalCorruptionClass;
  readonly file?: string;
  readonly message: string;
}> {}
