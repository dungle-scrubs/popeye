/**
 * Owns the Journal interface and its tree rules independently from durable adapters.
 * It exists so callers and conformance checks use one seam for every Journal implementation.
 * Every Journal serializes writers per session while operations for separate sessions stay concurrent.
 */
import { Context, Effect, Schema } from "effect";

import { JournalError, type JournalFailure } from "./errors.js";
import {
  type CompactionEntry,
  CompactionEntrySchema,
  type CompactionPayload,
  CompactionPayloadSchema,
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
  readonly appendCompaction: (
    sessionId: SessionId,
    payload: CompactionPayload,
  ) => Effect.Effect<Entry, JournalFailure>;
  readonly appendEntry: (
    sessionId: SessionId,
    entry: EntryDraft,
  ) => Effect.Effect<Entry, JournalFailure>;
  readonly appendRecord: (
    sessionId: SessionId,
    record: RecordDraft,
  ) => Effect.Effect<Record, JournalFailure>;
  readonly createSession: () => Effect.Effect<CreatedSession, JournalFailure>;
  /** Returns every acknowledged durable line for a session, including its root entry. */
  readonly countDurableLines: (sessionId: SessionId) => Effect.Effect<number, JournalFailure>;
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

export class Journal extends Context.Tag("@popeye/journal/Journal")<Journal, JournalService>() {}

export const isEntry = (line: JournalLine): line is EntryLine => line.type === "entry";

const strict: { readonly onExcessProperty: "error" } = { onExcessProperty: "error" };
const decodeLeafMovedPayload = Schema.decodeUnknown(LeafMovedRecordPayloadSchema, strict);
const decodeSessionRoot = Schema.decodeUnknown(SessionRootEntrySchema, strict);
const decodeCompactionEntry = (input: unknown): Effect.Effect<CompactionEntry, unknown> =>
  Schema.decodeUnknown(CompactionEntrySchema, strict)(input);
const decodeCompactionPayload = Schema.decodeUnknown(CompactionPayloadSchema, strict);

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

export const branchToLeaf = (session: DerivedSession): ReadonlyArray<Entry> => {
  const branch: Array<Entry> = [];
  let entry: Entry | undefined = session.leaf;
  while (entry !== undefined) {
    branch.push(entry);
    entry = entry.parentId === null ? undefined : session.entries.get(entry.parentId);
  }
  return branch.reverse();
};

/**
 * Describes the first broken compaction coverage rule for a current branch.
 * The caller maps this detail to a draft rejection while replay maps it to corruption.
 */
export const compactionValidationIssue = (
  session: DerivedSession,
  payload: CompactionPayload,
): string | undefined => {
  const branch = branchToLeaf(session);
  const rootId = session.rootEntry.id;
  if (branch.length === 1) {
    return `Compaction cannot summarize root ${rootId}: a root-only session has nothing to summarize.`;
  }

  const indexById = new Map(branch.map((entry, index) => [entry.id, index]));
  const firstIndex = indexById.get(payload.firstSummarizedId);
  if (firstIndex === undefined) {
    return `Compaction firstSummarizedId ${payload.firstSummarizedId} is not on the current branch.`;
  }
  const lastIndex = indexById.get(payload.lastSummarizedId);
  if (lastIndex === undefined) {
    return `Compaction lastSummarizedId ${payload.lastSummarizedId} is not on the current branch.`;
  }
  if (payload.firstSummarizedId === rootId) {
    return `Compaction span may not include root ${rootId}: firstSummarizedId names the root.`;
  }
  if (payload.lastSummarizedId === rootId) {
    return `Compaction span may not include root ${rootId}: lastSummarizedId names the root.`;
  }
  if (firstIndex > lastIndex) {
    return `Compaction span is reversed: firstSummarizedId ${payload.firstSummarizedId} follows lastSummarizedId ${payload.lastSummarizedId}.`;
  }

  const newestPriorCompactionIndex = branch.findLastIndex((entry) => entry.kind === "compaction");
  const expectedFirst = branch[newestPriorCompactionIndex < 0 ? 1 : newestPriorCompactionIndex + 1];
  if (expectedFirst === undefined) {
    const priorCompaction = branch[newestPriorCompactionIndex];
    return `Compaction cannot summarize after prior compaction ${priorCompaction?.id ?? rootId}: there is no unsummarized entry.`;
  }
  if (payload.firstSummarizedId !== expectedFirst.id) {
    return `Compaction firstSummarizedId ${payload.firstSummarizedId} must be the oldest unsummarized entry ${expectedFirst.id}.`;
  }

  const leafId = session.leaf.id;
  if (payload.lastSummarizedId !== leafId) {
    return `Compaction lastSummarizedId ${payload.lastSummarizedId} must be the current leaf ${leafId}.`;
  }

  const retainedTailIds = new Set<EntryId>();
  let previousRetainedIndex = -1;
  let previousRetainedId: EntryId | undefined;
  for (const retainedTailId of payload.retainedTailIds) {
    if (retainedTailIds.has(retainedTailId)) {
      return `Compaction retainedTailIds contains duplicate entry ${retainedTailId}.`;
    }
    retainedTailIds.add(retainedTailId);
    if (retainedTailId === rootId) {
      return `Compaction span may not include root ${rootId}: retainedTailIds names the root.`;
    }
    const retainedIndex = indexById.get(retainedTailId);
    if (retainedIndex === undefined) {
      return `Compaction retainedTailIds entry ${retainedTailId} is not on the current branch.`;
    }
    if (retainedIndex < firstIndex || retainedIndex > lastIndex) {
      return `Compaction retainedTailIds entry ${retainedTailId} must lie within span ${payload.firstSummarizedId} through ${payload.lastSummarizedId}.`;
    }
    if (retainedIndex <= previousRetainedIndex) {
      return `Compaction retainedTailIds entry ${retainedTailId} must be branch-ascending after ${previousRetainedId ?? retainedTailId}.`;
    }
    previousRetainedIndex = retainedIndex;
    previousRetainedId = retainedTailId;
  }

  if (payload.summary.trim().length === 0) {
    return `Compaction summary for span ending at ${payload.lastSummarizedId} must be non-empty.`;
  }

  return undefined;
};

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
        const compaction =
          line.item.kind === "compaction"
            ? yield* decodeCompactionEntry(line.item).pipe(Effect.mapError(schemaMismatch))
            : undefined;
        const entry = compaction ?? line.item;
        if (entry.kind === "session_root") {
          return yield* Effect.fail(
            new JournalError({
              corruptionClass: "invalid_record_sequence",
              message: "A session may contain only one session_root entry.",
            }),
          );
        }
        if (entries.has(entry.id) || entry.parentId !== leaf.id) {
          return yield* Effect.fail(
            new JournalError({
              corruptionClass: "invalid_record_sequence",
              message: "An entry must have a new id and parent the current leaf.",
            }),
          );
        }
        if (compaction !== undefined) {
          const payload = yield* decodeCompactionPayload(compaction.payload).pipe(
            Effect.mapError(schemaMismatch),
          );
          const issue = compactionValidationIssue({ entries, leaf, records, rootEntry }, payload);
          if (issue !== undefined) {
            return yield* Effect.fail(
              new JournalError({ corruptionClass: "invalid_compaction", message: issue }),
            );
          }
        }
        entries.set(entry.id, entry);
        leaf = entry;
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
