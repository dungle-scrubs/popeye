/**
 * Owns the Journal interface and its tree rules independently from durable adapters.
 * It exists so callers and conformance checks use one seam for every Journal implementation.
 * Every Journal serializes writers per session while operations for separate sessions stay concurrent.
 */
import { Context, Effect, Schema } from "effect";

import { JournalError, type JournalFailure } from "./errors.js";
import {
  type Entry,
  type EntryDraft,
  type EntryId,
  type EntryLine,
  type JournalLine,
  LeafMovedRecordPayloadSchema,
  type Record,
  type RecordDraft,
  type SessionId,
  type SessionRootEntry,
  SessionRootEntrySchema,
} from "./shapes.js";

export interface CreatedSession {
  readonly id: SessionId;
  readonly rootEntry: SessionRootEntry;
}

export interface JournalService {
  readonly appendEntry: (
    sessionId: SessionId,
    entry: EntryDraft,
  ) => Effect.Effect<Entry, JournalFailure>;
  readonly appendRecord: (
    sessionId: SessionId,
    record: RecordDraft,
  ) => Effect.Effect<Record, JournalFailure>;
  readonly createSession: () => Effect.Effect<CreatedSession, JournalFailure>;
  readonly getLeaf: (sessionId: SessionId) => Effect.Effect<Entry, JournalFailure>;
  readonly listSessions: () => Effect.Effect<ReadonlyArray<CreatedSession>>;
  readonly moveLeaf: (
    sessionId: SessionId,
    toEntryId: EntryId,
  ) => Effect.Effect<Record, JournalFailure>;
  readonly readBranch: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Entry>, JournalFailure>;
  readonly readRecords: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Record>, JournalFailure>;
}

export class Journal extends Context.Tag("@peye/journal/Journal")<Journal, JournalService>() {}

export const isEntry = (line: JournalLine): line is EntryLine => line.type === "entry";

export const entriesFor = (lines: ReadonlyArray<JournalLine>): ReadonlyArray<Entry> =>
  lines.flatMap((line) => (isEntry(line) ? [line.item] : []));

export const recordsFor = (lines: ReadonlyArray<JournalLine>): ReadonlyArray<Record> =>
  lines.flatMap((line) => (isEntry(line) ? [] : [line.item]));

const strict: { readonly onExcessProperty: "error" } = { onExcessProperty: "error" };
const decodeLeafMovedPayload = Schema.decodeUnknown(LeafMovedRecordPayloadSchema, strict);
const decodeSessionRoot = Schema.decodeUnknown(SessionRootEntrySchema, strict);

const schemaMismatch = (cause: unknown): JournalError =>
  new JournalError({
    cause,
    corruptionClass: "schema_mismatch",
    message: `Journal line does not match its schema: ${String(cause)}`,
  });

export interface DerivedSession {
  readonly entries: ReadonlyMap<EntryId, Entry>;
  readonly leaf: Entry;
  readonly records: ReadonlyArray<Record>;
  readonly rootEntry: SessionRootEntry;
}

export const deriveSession = (
  lines: ReadonlyArray<JournalLine>,
): Effect.Effect<DerivedSession | undefined, JournalError> =>
  Effect.gen(function* () {
    if (lines.length === 0) {
      return undefined;
    }

    const rootLine = lines[0];
    if (rootLine === undefined || !isEntry(rootLine) || rootLine.item.kind !== "session_root") {
      return yield* Effect.fail(
        new JournalError({
          corruptionClass: "invalid_record_sequence",
          message: "A session must begin with its session_root entry.",
        }),
      );
    }

    const rootEntry = yield* decodeSessionRoot(rootLine.item).pipe(Effect.mapError(schemaMismatch));
    const entries = new Map<EntryId, Entry>([[rootEntry.id, rootEntry]]);
    const records: Array<Record> = [];
    let leaf: Entry = rootEntry;

    for (const line of lines.slice(1)) {
      if (isEntry(line)) {
        if (line.item.kind === "session_root") {
          return yield* Effect.fail(
            new JournalError({
              corruptionClass: "invalid_record_sequence",
              message: "A session may contain only one session_root entry.",
            }),
          );
        }
        if (entries.has(line.item.id) || line.item.parentId !== leaf.id) {
          return yield* Effect.fail(
            new JournalError({
              corruptionClass: "invalid_record_sequence",
              message: "An entry must have a new id and parent the current leaf.",
            }),
          );
        }
        entries.set(line.item.id, line.item);
        leaf = line.item;
        continue;
      }

      records.push(line.item);
      if (line.item.kind === "leaf_moved") {
        const payload = yield* decodeLeafMovedPayload(line.item.payload).pipe(
          Effect.mapError(schemaMismatch),
        );
        const target = entries.get(payload.toEntryId);

        if (target === undefined) {
          return yield* Effect.fail(
            new JournalError({
              corruptionClass: "dangling_leaf_reference",
              message: `leaf_moved references missing entry ${payload.toEntryId}.`,
            }),
          );
        }

        leaf = target;
      }
    }

    return { entries, leaf, records, rootEntry };
  });

export const leafFor = (
  lines: ReadonlyArray<JournalLine>,
): Effect.Effect<Entry | undefined, JournalError> =>
  deriveSession(lines).pipe(Effect.map((session) => session?.leaf));

export const branchFor = (
  lines: ReadonlyArray<JournalLine>,
): Effect.Effect<ReadonlyArray<Entry>, JournalError> =>
  deriveSession(lines).pipe(
    Effect.map((session) => {
      if (session === undefined) {
        return [];
      }

      const branch: Array<Entry> = [];
      let entry: Entry | undefined = session.leaf;

      while (entry !== undefined) {
        branch.push(entry);
        entry = entry.parentId === null ? undefined : session.entries.get(entry.parentId);
      }

      return branch.reverse();
    }),
  );
