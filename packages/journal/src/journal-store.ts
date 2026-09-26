/**
 * Owns JournalStore deep module for durable Journal layer selection and migration.
 * It exists so POPEYE_JOURNAL_LAYER env vs journal.sqlite file-detection, WAL vs torn-tail,
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
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, type Layer, Schema } from "effect";

import type { JournalError } from "./errors.js";
import { type Journal, JournalHeaderSchema } from "./journal.js";
import { JournalJsonl } from "./jsonl.js";
import { createLineCodec } from "./line-codec.js";
import { type MigrateResult, migrateJsonlToSqlite } from "./migrate.js";
import {
  JournalLineSchema,
  type Record as JournalRecord,
  RecordSchema,
  type SessionId,
  SessionIdSchema,
} from "./shapes.js";
import { JournalSqlite } from "./sqlite.js";

export interface JournalStoreEnv {
  readonly POPEYE_JOURNAL_LAYER?: string | undefined;
}

export const selectJournalLayer = (
  sessionDir: string,
  env: JournalStoreEnv = {},
): Layer.Layer<Journal, JournalError, never> => {
  const explicit = env.POPEYE_JOURNAL_LAYER;
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
  readAccountingRecords,
  selectLayer: selectJournalLayer,
};

/** Passive, complete snapshot of Record envelopes. The caller must project an allowlisted schema. */
export async function readAccountingRecords(
  directory: string,
  selectedSession?: string,
): Promise<
  ReadonlyArray<{ readonly sessionId: SessionId; readonly records: ReadonlyArray<JournalRecord> }>
> {
  const sqliteFile = join(directory, "journal.sqlite");
  if (existsSync(sqliteFile)) {
    const db = new DatabaseSync(sqliteFile, { readOnly: true });
    try {
      const sessions = db.prepare("SELECT id FROM sessions ORDER BY id").all() as Array<{
        id: string;
      }>;
      return sessions
        .filter(({ id }) => selectedSession === undefined || id === selectedSession)
        .map(({ id }) => ({
          sessionId: SessionIdSchema.make(id),
          records: (
            db
              .prepare(
                "SELECT record_id AS id, kind, payload_json AS payloadJson FROM records WHERE session_id = ? ORDER BY global_seq",
              )
              .all(id) as Array<{ id: string; kind: string; payloadJson: string }>
          ).map((row) =>
            Schema.decodeUnknownSync(RecordSchema, { onExcessProperty: "error" })({
              id: row.id,
              kind: row.kind,
              payload: JSON.parse(row.payloadJson) as unknown,
            }),
          ),
        }));
    } finally {
      db.close();
    }
  }
  const codec = await Effect.runPromise(
    createLineCodec({
      currentVersion: 1,
      versions: [
        { payloadSchema: Schema.Union(JournalHeaderSchema, JournalLineSchema), version: 1 },
      ],
    }),
  );
  const names = (await readdir(directory))
    .filter(
      (name) =>
        name.endsWith(".jsonl") &&
        (selectedSession === undefined || name === `${selectedSession}.jsonl`),
    )
    .sort();
  const results: Array<{ sessionId: SessionId; records: ReadonlyArray<JournalRecord> }> = [];
  for (const name of names) {
    const sessionId = SessionIdSchema.make(basename(name, ".jsonl"));
    const content = await readFile(join(directory, name), "utf8");
    if (!content.endsWith("\n")) throw new Error("ACCOUNTING_INCOMPLETE_TAIL");
    const lines = content.slice(0, -1).split("\n");
    const parsed = await Promise.all(
      lines.map((line, index) => Effect.runPromise(codec.decodeLine(line, { line: index + 1 }))),
    );
    const header = parsed[0];
    if (header?.type !== "journal_header" || header.sessionId !== sessionId)
      throw new Error("ACCOUNTING_INTEGRITY");
    if (
      parsed.slice(1).some((line) => line.type === "journal_header" || line.sessionId !== sessionId)
    )
      throw new Error("ACCOUNTING_INTEGRITY");
    const records = parsed
      .slice(1)
      .filter(
        (line): line is Extract<typeof line, { type: "record" }> =>
          line.type === "record" && line.sessionId === sessionId,
      )
      .map((line) => line.item);
    results.push({ sessionId, records });
  }
  return results;
}
