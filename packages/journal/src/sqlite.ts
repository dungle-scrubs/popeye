/**
 * Owns the SQLite Journal adapter as private seam of JournalStore (C4 architecture review).
 * It exists so a large durable journal can live in `journal.sqlite` per directory <!-- D-001 -->
 * behind the same `Journal` tag that memory and JSONL use.
 *
 * What it owns: `JournalPersistence` over `node:sqlite` <!-- D-008 -->, WAL durability
 * (`journal_mode=WAL`, `synchronous=NORMAL`, `PRAGMA wal_checkpoint(TRUNCATE)`), // M2 WAL policy
 * per-directory `journal.sqlite`, and translation between `JournalLine` and rows.
 * Why it exists: SQLite gives transactional appends and indexed reads without
 * JSONL's torn-tail truncation, and is the M1 step before fencing (M2) and
 * pagination (Phase 2). Private seam of JournalStore: selection via
 * JournalStore.selectLayer, not direct CLI import, keeps WAL and fencing diagnostics behind the store.
 * What it does not own: single-writer mailbox serialization (adapter-core),
 * compaction validation (journal.ts), or snapshot pagination (SessionStore).
 */

import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Layer } from "effect";

import {
  availableSession,
  createJournalAdapter,
  type JournalAdapterState,
  type JournalPersistence,
  rejectedSession,
} from "./adapter-core.js";
import { JournalError } from "./errors.js";
import { deriveSession, type ExportRead, Journal } from "./journal.js";
import type { Entry, JournalLine, Record as JournalRecord, SessionId } from "./shapes.js";
import {
  EntryIdSchema,
  EntrySchema,
  RecordIdSchema,
  RecordSchema,
  SessionIdSchema,
} from "./shapes.js";
import { checkSchema, ensureSchema } from "./sqlite/ddl.js";

const fileFailure = (file: string, operation: string, cause: unknown): JournalError =>
  new JournalError({
    cause,
    corruptionClass: "io_failure",
    file,
    message: `Could not ${operation} journal file ${file}: ${String(cause)}`,
  });

const fileEffect = <T>(
  file: string,
  operation: string,
  run: () => T,
): Effect.Effect<T, JournalError> =>
  Effect.try({
    catch: (cause) => {
      if (cause instanceof JournalError) {
        return cause;
      }
      return fileFailure(file, operation, cause);
    },
    try: run,
  });

export const JournalDiagnosticSchema = {
  // kept minimal for M1; full schema will be added with M2 fencing diagnostics
};

export interface SqliteJournalOptions {
  readonly diagnosticSink?: (diagnostic: unknown) => Effect.Effect<void>;
}

interface SqliteJournalBacking {
  readonly db: DatabaseSync;
  readonly diagnosticSink: (diagnostic: unknown) => Effect.Effect<void>;
  readonly directory: string;
  readonly fences: Map<SessionId, number>;
  readonly file: string;
  readonly ownerId: string;
}

const createOwnerId = (): string => randomBytes(8).toString("base64url");

const defaultDiagnosticSink = (diagnostic: unknown): Effect.Effect<void> =>
  Effect.logInfo(JSON.stringify(diagnostic));

const emitDiagnostic = (backing: SqliteJournalBacking, diagnostic: unknown): Effect.Effect<void> =>
  backing.diagnosticSink(diagnostic);

const openDirectories = new Set<string>();
const acquireBacking = (
  directory: string,
  options: SqliteJournalOptions,
): Effect.Effect<SqliteJournalBacking, JournalError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      catch: (cause) => fileFailure(directory, "create directory", cause),
      try: () => mkdir(directory, { recursive: true }),
    });

    const file = join(directory, "journal.sqlite");

    const db = yield* fileEffect(file, "open database", () => new DatabaseSync(file));
    try {
      ensureSchema(db);
    } catch (cause) {
      try {
        db.close();
      } catch {
        // ignore
      }
      return yield* Effect.fail(fileFailure(file, "ensure schema", cause));
    }

    const { journalMode, synchronous } = checkSchema(db);
    // Allow multiple in-process openers for fence takeover tests; track for diagnostics only
    openDirectories.add(file);

    const backing: SqliteJournalBacking = {
      db,
      diagnosticSink: options.diagnosticSink ?? defaultDiagnosticSink,
      directory,
      fences: new Map(),
      file,
      ownerId: createOwnerId(),
    };

    yield* emitDiagnostic(backing, {
      action: "opened",
      file,
      journalMode,
      synchronous,
    });

    return backing;
  });

const releaseBacking = (backing: SqliteJournalBacking): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    openDirectories.delete(backing.file);
    yield* Effect.try({
      catch: () => undefined as never,
      try: () => backing.db.close(),
    }).pipe(Effect.ignore);
  });

const nextGlobalSeq = (backing: SqliteJournalBacking, sessionId: SessionId): number => {
  const row = backing.db
    .prepare(
      `
      SELECT COALESCE(MAX(global_seq), 0) as maxSeq FROM (
        SELECT global_seq FROM entries WHERE session_id = ?
        UNION ALL
        SELECT global_seq FROM records WHERE session_id = ?
      )
    `,
    )
    .get(sessionId, sessionId) as { maxSeq: number } | undefined;
  return (row?.maxSeq ?? 0) + 1;
};

const readOrderedLines = (
  backing: SqliteJournalBacking,
  sessionId: SessionId,
): Effect.Effect<ReadonlyArray<JournalLine>, JournalError> =>
  fileEffect(backing.file, "load session", () => {
    const entryRows = backing.db
      .prepare(
        "SELECT entry_id as id, parent_id as parentId, kind, payload_json as payloadJson, global_seq as globalSeq FROM entries WHERE session_id = ? ORDER BY global_seq ASC",
      )
      .all(sessionId) as Array<{
      globalSeq: number;
      id: string;
      kind: string;
      parentId: string | null;
      payloadJson: string;
    }>;

    const recordRows = backing.db
      .prepare(
        "SELECT record_id as id, kind, payload_json as payloadJson, global_seq as globalSeq FROM records WHERE session_id = ? ORDER BY global_seq ASC",
      )
      .all(sessionId) as Array<{
      globalSeq: number;
      id: string;
      kind: string;
      payloadJson: string;
    }>;

    // Merge by global_seq
    const merged: Array<{ globalSeq: number; line: JournalLine }> = [];
    for (const row of entryRows) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payloadJson) as unknown;
      } catch (cause) {
        throw new JournalError({
          cause,
          corruptionClass: "malformed_json",
          file: backing.file,
          message: `Malformed JSON for entry ${row.id} in session ${sessionId}: ${String(cause)}`,
        });
      }
      const entry: Entry = EntrySchema.make({
        id: EntryIdSchema.make(row.id),
        kind: row.kind,
        parentId: row.parentId === null ? null : EntryIdSchema.make(row.parentId),
        payload,
      });
      merged.push({
        globalSeq: row.globalSeq,
        line: { item: entry, sessionId, type: "entry" } as JournalLine,
      });
    }
    for (const row of recordRows) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payloadJson) as unknown;
      } catch (cause) {
        throw new JournalError({
          cause,
          corruptionClass: "malformed_json",
          file: backing.file,
          message: `Malformed JSON for record ${row.id} in session ${sessionId}: ${String(cause)}`,
        });
      }
      const record: JournalRecord = RecordSchema.make({
        id: RecordIdSchema.make(row.id),
        kind: row.kind,
        payload,
      });
      merged.push({
        globalSeq: row.globalSeq,
        line: { item: record, sessionId, type: "record" } as JournalLine,
      });
    }
    merged.sort((a, b) => a.globalSeq - b.globalSeq);
    return merged.map((m) => m.line);
  });

const sqlitePersistence = (backing: SqliteJournalBacking): JournalPersistence => ({
  initializeSession: (sessionId, rootEntry) =>
    Effect.gen(function* () {
      const globalSeq = 1;
      yield* fileEffect(backing.file, "initialize session", () => {
        backing.db.exec("BEGIN IMMEDIATE");
        try {
          // Insert session row if not exists
          const existing = backing.db
            .prepare("SELECT id, fence, owner_id FROM sessions WHERE id = ?")
            .get(sessionId) as { id: string; fence: number; owner_id: string } | undefined;
          if (existing === undefined) {
            backing.db
              .prepare("INSERT INTO sessions (id, fence, owner_id, created_at) VALUES (?, ?, ?, ?)")
              .run(sessionId, 1, backing.ownerId, Date.now());
            backing.fences.set(sessionId, 1);
          } else {
            // Session already exists - verify fence ownership before proceeding
            if (
              existing.owner_id !== backing.ownerId ||
              existing.fence !== backing.fences.get(sessionId)
            ) {
              throw new JournalError({
                corruptionClass: "io_failure",
                file: backing.file,
                message: `Fence mismatch for session ${sessionId}: expected fence ${backing.fences.get(sessionId)} owner ${backing.ownerId}, found fence ${existing.fence} owner ${existing.owner_id}`,
              });
            }
          }
          backing.db
            .prepare(
              "INSERT INTO entries (session_id, entry_id, parent_id, kind, payload_json, global_seq) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(
              sessionId,
              rootEntry.id,
              rootEntry.parentId,
              rootEntry.kind,
              JSON.stringify(rootEntry.payload),
              globalSeq,
            );
          backing.db.exec("COMMIT");
        } catch (cause) {
          try {
            backing.db.exec("ROLLBACK");
          } catch {
            // ignore
          }
          throw cause;
        }
      });
    }),

  loadSession: (sessionId) =>
    Effect.gen(function* () {
      const lines = yield* readOrderedLines(backing, sessionId);

      if (lines.length === 0) {
        return yield* Effect.fail(
          new JournalError({
            corruptionClass: "invalid_record_sequence",
            file: backing.file,
            message: `Session ${sessionId} has no root entry.`,
          }),
        );
      }

      const derived = yield* deriveSession(lines).pipe(
        Effect.mapError(
          (error) =>
            new JournalError({
              cause: error.cause,
              corruptionClass: error.corruptionClass,
              file: backing.file,
              message: error.message,
            }),
        ),
      );

      if (derived === undefined) {
        return yield* Effect.fail(
          new JournalError({
            corruptionClass: "invalid_record_sequence",
            file: backing.file,
            message: `Session ${sessionId} has no root entry.`,
          }),
        );
      }

      return derived;
    }),

  readExport: (sessionId) =>
    Effect.gen(function* () {
      const lines = yield* readOrderedLines(backing, sessionId);
      if (lines.length === 0) {
        return yield* Effect.fail(
          new JournalError({
            corruptionClass: "invalid_record_sequence",
            file: backing.file,
            message: `Session ${sessionId} has no root entry.`,
          }),
        );
      }
      const sizeBytes = yield* fileEffect(backing.file, "stat", () => statSync(backing.file).size);
      const exportRead: ExportRead = {
        header: {
          format: "popeye_journal",
          sessionId,
          type: "journal_header",
          version: 1,
        },
        // SQLite appends transactionally: no torn tail is possible.
        incompleteTail: false,
        lines,
        sizeBytes,
      };
      return exportRead;
    }),

  persistLine: (sessionId, line) =>
    Effect.gen(function* () {
      yield* fileEffect(backing.file, "persist line", () => {
        backing.db.exec("BEGIN IMMEDIATE");
        try {
          // Fence guard - stale writer fails typed
          const fenceRow = backing.db
            .prepare("SELECT fence, owner_id FROM sessions WHERE id = ?")
            .get(sessionId) as { fence: number; owner_id: string } | undefined;
          if (fenceRow === undefined) {
            throw new JournalError({
              corruptionClass: "invalid_record_sequence",
              file: backing.file,
              message: `Session ${sessionId} not found for persist`,
            });
          }
          const expectedFence = backing.fences.get(sessionId);
          if (
            expectedFence === undefined ||
            fenceRow.fence !== expectedFence ||
            fenceRow.owner_id !== backing.ownerId
          ) {
            throw new JournalError({
              corruptionClass: "io_failure",
              file: backing.file,
              message: `Fence mismatch for session ${sessionId}: expected fence ${expectedFence} owner ${backing.ownerId}, found fence ${fenceRow.fence} owner ${fenceRow.owner_id}`,
            });
          }

          const globalSeq = nextGlobalSeq(backing, sessionId);
          if (line.type === "entry") {
            const entry = line.item as Entry;
            backing.db
              .prepare(
                "INSERT INTO entries (session_id, entry_id, parent_id, kind, payload_json, global_seq) VALUES (?, ?, ?, ?, ?, ?)",
              )
              .run(
                sessionId,
                entry.id,
                entry.parentId,
                entry.kind,
                JSON.stringify(entry.payload),
                globalSeq,
              );
          } else {
            const record = line.item as JournalRecord;
            backing.db
              .prepare(
                "INSERT INTO records (session_id, record_id, kind, payload_json, global_seq) VALUES (?, ?, ?, ?, ?)",
              )
              .run(sessionId, record.id, record.kind, JSON.stringify(record.payload), globalSeq);
          }
          backing.db.exec("COMMIT");
        } catch (cause) {
          try {
            backing.db.exec("ROLLBACK");
          } catch {
            // ignore
          }
          throw cause;
        }
      });
    }),
});

const openJournalState = (
  backing: SqliteJournalBacking,
): Effect.Effect<JournalAdapterState, JournalError> =>
  Effect.gen(function* () {
    const sessionRows = yield* fileEffect(
      backing.file,
      "list sessions",
      () =>
        backing.db.prepare("SELECT id, fence FROM sessions").all() as Array<{
          id: string;
          fence: number;
        }>,
    );

    // Acquire fence for each existing session - bump fence and claim ownership
    for (const row of sessionRows) {
      yield* fileEffect(backing.file, "acquire fence", () => {
        backing.db
          .prepare("UPDATE sessions SET fence = fence + 1, owner_id = ? WHERE id = ?")
          .run(backing.ownerId, row.id);
        const updated = backing.db.prepare("SELECT fence FROM sessions WHERE id = ?").get(row.id) as
          | { fence: number }
          | undefined;
        if (updated !== undefined) {
          backing.fences.set(SessionIdSchema.make(row.id), updated.fence);
        }
      });
      yield* emitDiagnostic(backing, {
        action: "fence_acquired",
        file: backing.file,
        sessionId: row.id,
        fence: backing.fences.get(SessionIdSchema.make(row.id)),
        ownerId: backing.ownerId,
      });
    }

    const sessions = new Map<
      SessionId,
      ReturnType<typeof availableSession> | ReturnType<typeof rejectedSession>
    >();
    for (const { id } of sessionRows) {
      const sessionId = SessionIdSchema.make(id);
      const result = yield* sqlitePersistence(backing).loadSession(sessionId).pipe(Effect.either);
      if (result._tag === "Right") {
        sessions.set(sessionId, availableSession(result.right));
      } else {
        const error = result.left as JournalError;
        yield* emitDiagnostic(backing, {
          action: "rejected",
          corruptionClass: error.corruptionClass,
          file: backing.file,
          message: error.message,
        });
        sessions.set(sessionId, rejectedSession(error));
      }
    }

    return { sessions } as JournalAdapterState;
  });

export const JournalSqlite = (
  directory: string,
  options: SqliteJournalOptions = {},
): Layer.Layer<Journal, JournalError> =>
  Layer.scoped(
    Journal,
    Effect.gen(function* () {
      const backing = yield* Effect.acquireRelease(acquireBacking(directory, options), (acquired) =>
        releaseBacking(acquired),
      );
      const state = yield* openJournalState(backing);
      return yield* createJournalAdapter(state, sqlitePersistence(backing));
    }),
  );

// Test harness mirrors Jsonl/Memory harness shape
export const createSqliteJournalHarness = (directory: string) => ({
  layer: JournalSqlite(directory),
  reopen: () => JournalSqlite(directory),
  snapshotLines: (): Effect.Effect<ReadonlyArray<unknown>, JournalError> =>
    Effect.try({
      catch: (cause) => fileFailure(join(directory, "journal.sqlite"), "snapshot", cause),
      try: () => {
        const db = new DatabaseSync(join(directory, "journal.sqlite"));
        try {
          const entryRows = db
            .prepare(
              "SELECT session_id as sessionId, entry_id as id, parent_id as parentId, kind, payload_json as payloadJson FROM entries ORDER BY global_seq ASC",
            )
            .all() as Array<{ sessionId: string; id: string; payloadJson: string }>;
          const recordRows = db
            .prepare(
              "SELECT session_id as sessionId, record_id as id, kind, payload_json as payloadJson FROM records ORDER BY global_seq ASC",
            )
            .all() as Array<{ sessionId: string; id: string; payloadJson: string }>;
          // Merge not needed for snapshot, just return raw
          return [...entryRows, ...recordRows] as unknown as ReadonlyArray<unknown>;
        } finally {
          db.close();
        }
      },
    }),
});

// Contract harness for conformance suite
export const createSqliteJournalContractHarness = (directory: string) =>
  createSqliteJournalHarness(directory);
