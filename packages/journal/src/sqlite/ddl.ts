/**
 * Owns SQLite DDL for the journal layer.
 * It exists so the three canonical tables and WAL settings stay in one place.
 *
 * What it owns: table creation for `sessions`, `entries`, `records`, indices, and PRAGMAs.
 * Why: SQLite is one `journal.sqlite` per journal directory <!-- D-001 --> with fence + owner_id per session.
 * What it does not own: Journal logic, fencing guards, or line encoding - those live in `sqlite.ts`.
 */
import type { DatabaseSync } from "node:sqlite";

export const ensureSchema = (db: DatabaseSync): void => {
  // WAL + NORMAL matches the spike-verified durability without torn-tail truncation <!-- D-008 -->
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA foreign_keys=ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      fence INTEGER NOT NULL,
      owner_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  // Separate tables for entries and records. Global ordering is via global_seq,
  // which is monotonic across both tables per session so that load can merge
  // them into a single line order.
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      entry_id TEXT NOT NULL,
      parent_id TEXT,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      global_seq INTEGER NOT NULL,
      UNIQUE(session_id, entry_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      global_seq INTEGER NOT NULL,
      UNIQUE(session_id, record_id)
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_entries_session_seq ON entries(session_id, seq)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_entries_session_global ON entries(session_id, global_seq)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_records_session_seq ON records(session_id, seq)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_records_session_global ON records(session_id, global_seq)",
  );
};

export const checkSchema = (
  db: DatabaseSync,
): { readonly journalMode: string; readonly synchronous: number } => {
  const modeRow = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string } | undefined;
  const syncRow = db.prepare("PRAGMA synchronous").get() as { synchronous: number } | undefined;
  return {
    journalMode: modeRow?.journal_mode ?? "unknown",
    synchronous: syncRow?.synchronous ?? -1,
  };
};
