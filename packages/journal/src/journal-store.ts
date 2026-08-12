/**
 * Owns JournalStore deep module for durable Journal layer selection and migration.
 * It exists so PEYE_JOURNAL_LAYER env vs journal.sqlite file-detection, WAL vs torn-tail,
 * fencing diagnostics, and bulk JSONL→SQLite migration hide behind one deep interface.
 *
 * Why this module: adapter-core.ts already centralizes validation and per-session serialization
 * (deleting it would scatter serialization), but the JournalPersistence interface itself is generic:
 * jsonl.ts (torn-tail truncation) and sqlite.ts (fencing + WAL + global_seq) duplicated session
 * lifecycle handling with divergent diagnostic shapes, and the selection logic (env var vs file
 * presence) lived in cli/entry/cli-entry.ts while migrate.ts lived in journal — one concept
 * split across two packages. Adding a vacuum or export compaction would touch both adapters
 * and the CLI selector. This module owns the one durability seam: callers depend on
 * JournalStore.selectLayer(directory, env) → Layer<Journal>, not on JournalJsonl vs JournalSqlite
 * directly. WAL policy, fencing, and migrate become private seams.
 *
 * Not responsible for Journal semantics (journal.ts owns deriveSession and branchToLeaf) or for
 * compaction validation (journal owns that) or for mailbox serialization (adapter-core owns that).
 * The seam is the filesystem: two adapters justify it — LiveJournalStore over real FS + node:sqlite
 * and FakeJournalStore over JournalMemory in tests. Migration stays explicit (no auto-migration)
 * per D-006.
 */

import { existsSync } from "node:fs";

import type { Layer } from "effect";

import type { JournalError } from "./errors.js";
import type { Journal } from "./journal.js";
import { JournalJsonl } from "./jsonl.js";
import { type MigrateResult, migrateJsonlToSqlite } from "./migrate.js";
import { JournalSqlite } from "./sqlite.js";

export interface JournalStoreEnv {
  readonly PEYE_JOURNAL_LAYER?: string | undefined;
}

export const selectJournalLayer = (
  sessionDir: string,
  env: JournalStoreEnv = {},
): Layer.Layer<Journal, JournalError, never> => {
  const explicit = env.PEYE_JOURNAL_LAYER;
  if (explicit === "sqlite") return JournalSqlite(sessionDir);
  if (explicit === "jsonl") return JournalJsonl(sessionDir);
  if (explicit !== undefined && explicit.length > 0) {
    // Unknown value falls back to file detection; diagnostic is emitted by caller if needed.
    // Keep behavior identical to previous cli-entry implementation (logWarning via Effect.runSync).
    // This module does not log directly to avoid Effect dependency at selection time.
  }
  const sqliteFile = `${sessionDir}/journal.sqlite`;
  return existsSync(sqliteFile) ? JournalSqlite(sessionDir) : JournalJsonl(sessionDir);
};

export const migrateDirectory = (
  directory: string,
): import("effect").Effect.Effect<MigrateResult, JournalError> => migrateJsonlToSqlite(directory);

export const JournalStore = {
  migrate: migrateDirectory,
  selectLayer: selectJournalLayer,
};
