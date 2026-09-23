/**
 * Owns JSONL to SQLite migration.
 * It exists so an existing `.popeye/sessions` directory can be moved to `journal.sqlite`
 * via an explicit command, not via auto-migration <!-- D-006 -->.
 *
 * What it owns: reading acknowledged JSONL lines and bulk-inserting them into `journal.sqlite`.
 * Why: `JournalJsonl` and `JournalSqlite` share the same `Journal` tag, but the durable
 * files are different. Migration is explicit so no directory is silently rewritten.
 * What it does not own: Journal semantics, fencing, or DDL - those live in `sqlite/ddl.ts` and `journal.ts`.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Schema } from "effect";

import { JournalError } from "./errors.js";
import { createLineCodec } from "./line-codec.js";
import { JournalLineSchema, SessionIdSchema } from "./shapes.js";
import { ensureSchema } from "./sqlite/ddl.js";

const JournalHeaderSchema = Schema.Struct({
  format: Schema.Literal("popeye_journal"),
  sessionId: SessionIdSchema,
  type: Schema.Literal("journal_header"),
  version: Schema.Literal(1),
});

const JournalFileLineSchema = Schema.Union(JournalHeaderSchema, JournalLineSchema);

const fileFailure = (file: string, operation: string, cause: unknown): JournalError =>
  new JournalError({
    cause,
    corruptionClass: "io_failure",
    file,
    message: `Could not ${operation} ${file}: ${String(cause)}`,
  });

export interface MigrateResult {
  readonly filesMigrated: number;
  readonly migratedSessions: ReadonlyArray<string>;
}

export const migrateJsonlToSqlite = (
  directory: string,
): Effect.Effect<MigrateResult, JournalError> =>
  Effect.gen(function* () {
    const file = join(directory, "journal.sqlite");
    const db = yield* Effect.try({
      catch: (cause) => fileFailure(file, "open database for migrate", cause),
      try: () => new DatabaseSync(file),
    });

    try {
      ensureSchema(db);
    } catch (cause) {
      db.close();
      return yield* Effect.fail(fileFailure(file, "ensure schema for migrate", cause));
    }

    const codec = yield* createLineCodec({
      currentVersion: 1,
      versions: [{ payloadSchema: JournalFileLineSchema, version: 1 }],
    }).pipe(Effect.mapError((cause) => fileFailure(file, "create codec for migrate", cause)));

    const names = yield* Effect.tryPromise({
      catch: (cause) => fileFailure(directory, "list directory for migrate", cause),
      try: () => readdir(directory),
    });

    const jsonlFiles = names.filter((n) => n.endsWith(".jsonl")).sort();
    const migrated: Array<string> = [];

    for (const name of jsonlFiles) {
      const sessionId = SessionIdSchema.make(basename(name, ".jsonl"));
      const fullPath = join(directory, name);
      const text = yield* Effect.tryPromise({
        catch: (cause) => fileFailure(fullPath, "read for migrate", cause),
        try: () => readFile(fullPath, "utf8"),
      });

      // Only acknowledged prefix; torn tail already handled by JSONL open, but for migrate we take trimmed file
      const lines = text.trimEnd() === "" ? [] : text.trimEnd().split("\n");
      if (lines.length === 0) continue;

      // Decode header - first line must be header, ignore its value but validate
      const headerLine = lines[0];
      if (headerLine === undefined) continue;
      yield* codec.decodeLine(headerLine, { file: fullPath, line: 1 }).pipe(
        Effect.mapError(
          (e) =>
            new JournalError({
              corruptionClass: e.corruptionClass,
              file: fullPath,
              message: e.message,
            }),
        ),
      );
      // Header is JournalHeader, not JournalLine - skip it, next lines are JournalLines
      const journalLines: Array<unknown> = [];
      for (let i = 1; i < lines.length; i++) {
        const raw = lines[i];
        if (raw === undefined || raw.trim() === "") continue;
        const decoded = yield* codec.decodeLine(raw, { file: fullPath, line: i + 1 }).pipe(
          Effect.mapError(
            (e) =>
              new JournalError({
                corruptionClass: e.corruptionClass,
                file: fullPath,
                message: e.message,
              }),
          ),
        );
        journalLines.push(decoded as unknown);
      }

      // Check if session already exists in sqlite
      const existing = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId) as
        | { id: string }
        | undefined;
      if (existing !== undefined) {
        // Already migrated - skip
        continue;
      }

      // Insert session row
      const createdAt = Date.now();
      yield* Effect.try({
        catch: (cause) => fileFailure(file, "migrate sessions", cause),
        try: () => {
          db.exec("BEGIN IMMEDIATE");
          try {
            db.prepare(
              "INSERT INTO sessions (id, fence, owner_id, created_at) VALUES (?, ?, ?, ?)",
            ).run(sessionId, 1, "migrate", createdAt);

            let globalSeq = 1;
            for (const line of journalLines) {
              const typed = line as {
                item: { id: string; kind: string; parentId?: string | null; payload: unknown };
                sessionId: string;
                type: string;
              };
              if (typed.type === "entry") {
                const entry = typed.item;
                db.prepare(
                  "INSERT INTO entries (session_id, entry_id, parent_id, kind, payload_json, global_seq) VALUES (?, ?, ?, ?, ?, ?)",
                ).run(
                  sessionId,
                  entry.id,
                  entry.parentId ?? null,
                  entry.kind,
                  JSON.stringify(entry.payload),
                  globalSeq++,
                );
              } else if (typed.type === "record") {
                const record = typed.item;
                db.prepare(
                  "INSERT INTO records (session_id, record_id, kind, payload_json, global_seq) VALUES (?, ?, ?, ?, ?)",
                ).run(
                  sessionId,
                  record.id,
                  record.kind,
                  JSON.stringify(record.payload),
                  globalSeq++,
                );
              }
            }
            db.exec("COMMIT");
          } catch (cause) {
            try {
              db.exec("ROLLBACK");
            } catch {
              // ignore
            }
            throw cause;
          }
        },
      });

      migrated.push(sessionId);
    }

    db.close();

    return { filesMigrated: jsonlFiles.length, migratedSessions: migrated };
  });
