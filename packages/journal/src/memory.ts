/**
 * Owns a reusable in-memory Journal adapter for fast behavior checks and local composition.
 * It exists to prove Journal rules from append-only content without file mechanics.
 */
import { randomBytes } from "node:crypto";
import { Effect, Layer, Ref, Schema, TSemaphore } from "effect";

import {
  JournalDraftRejected,
  JournalError,
  type JournalFailure,
  JournalNotFound,
} from "./errors.js";
import { type CreatedSession, type DerivedSession, deriveSession, Journal } from "./journal.js";
import {
  type Entry,
  type EntryDraft,
  EntryDraftSchema,
  type EntryId,
  EntryIdSchema,
  type JournalLine,
  JournalLineSchema,
  type Record,
  type RecordDraft,
  RecordDraftSchema,
  type RecordId,
  RecordIdSchema,
  type SessionId,
  SessionIdSchema,
  type SessionRootEntry,
} from "./shapes.js";

const memoryJournalBacking = Symbol("MemoryJournalBacking");

export interface MemoryJournalBacking {
  readonly [memoryJournalBacking]: Ref.Ref<ReadonlyArray<JournalLine>>;
}

interface SessionState extends DerivedSession {
  readonly semaphore: TSemaphore.TSemaphore;
}

interface MemoryJournalState {
  readonly sessions: ReadonlyMap<SessionId, SessionState>;
}

const strict: { readonly onExcessProperty: "error" } = { onExcessProperty: "error" };
const decodeEntryDraft = Schema.decodeUnknown(EntryDraftSchema, strict);
const decodeRecordDraft = Schema.decodeUnknown(RecordDraftSchema, strict);
const decodeJournalLine = Schema.decodeUnknown(JournalLineSchema, strict);

const createId = (): string => randomBytes(12).toString("base64url");

const createEntryId = (): EntryId => EntryIdSchema.make(createId());

const createRecordId = (): RecordId => RecordIdSchema.make(createId());

const createSessionId = (): SessionId => SessionIdSchema.make(createId());

const missingSession = (sessionId: SessionId): JournalNotFound =>
  new JournalNotFound({ id: sessionId, what: "session" });

const rejectedDraft = (kind: string, cause: unknown): JournalDraftRejected =>
  new JournalDraftRejected({ cause, kind, reason: "invalid_payload" });

const sessionLinesFor = (
  lines: ReadonlyArray<JournalLine>,
  sessionId: SessionId,
): ReadonlyArray<JournalLine> => lines.filter((line) => line.sessionId === sessionId);

const sessionState = (session: DerivedSession): SessionState => ({
  ...session,
  semaphore: TSemaphore.unsafeMake(1),
});

const deriveState = (
  lines: ReadonlyArray<JournalLine>,
): Effect.Effect<MemoryJournalState, JournalError> =>
  Effect.gen(function* () {
    const sessionIds = new Set(lines.map((line) => line.sessionId));
    const sessions = new Map<SessionId, SessionState>();

    for (const sessionId of sessionIds) {
      const session = yield* deriveSession(sessionLinesFor(lines, sessionId));

      if (session !== undefined) {
        sessions.set(sessionId, sessionState(session));
      }
    }

    return { sessions };
  });

const updateSession = (
  stateRef: Ref.Ref<MemoryJournalState>,
  sessionId: SessionId,
  update: (session: SessionState) => SessionState,
): Effect.Effect<void> =>
  Ref.update(stateRef, (state) => {
    const previous = state.sessions.get(sessionId);

    if (previous === undefined) {
      return state;
    }

    const sessions = new Map(state.sessions);
    sessions.set(sessionId, update(previous));
    return { sessions };
  });

const appendLine = (
  backing: MemoryJournalBacking,
  line: JournalLine,
): Effect.Effect<void, JournalError> =>
  Effect.gen(function* () {
    const validated = yield* decodeJournalLine(line).pipe(
      Effect.mapError(
        (cause) =>
          new JournalError({
            cause,
            corruptionClass: "schema_mismatch",
            message: `Journal line does not match its schema: ${String(cause)}`,
          }),
      ),
    );
    yield* Ref.update(backing[memoryJournalBacking], (lines) => [...lines, validated]);
  });

const withSession = <TOutput>(
  stateRef: Ref.Ref<MemoryJournalState>,
  sessionId: SessionId,
  operation: (session: SessionState) => Effect.Effect<TOutput, JournalFailure>,
): Effect.Effect<TOutput, JournalFailure> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    const session = state.sessions.get(sessionId);

    if (session === undefined) {
      return yield* Effect.fail(missingSession(sessionId));
    }

    return yield* operation(session).pipe(TSemaphore.withPermit(session.semaphore));
  });

const createJournalMemory = (
  backing: MemoryJournalBacking,
  stateRef: Ref.Ref<MemoryJournalState>,
) => ({
  appendEntry: (sessionId: SessionId, input: EntryDraft) =>
    withSession(stateRef, sessionId, (session) =>
      Effect.gen(function* () {
        // Append inputs reject unknown fields so a newer writer cannot silently lose durable data.
        const entry = yield* decodeEntryDraft(input).pipe(
          Effect.mapError((cause) => rejectedDraft(input.kind, cause)),
        );

        if (entry.kind === "session_root") {
          return yield* Effect.fail(
            new JournalDraftRejected({ kind: entry.kind, reason: "reserved_kind" }),
          );
        }

        const appended: Entry = {
          id: createEntryId(),
          kind: entry.kind,
          parentId: session.leaf.id,
          payload: entry.payload,
        };
        yield* appendLine(backing, { item: appended, sessionId, type: "entry" });
        yield* updateSession(stateRef, sessionId, (current) => ({
          ...current,
          entries: new Map([...current.entries, [appended.id, appended]]),
          leaf: appended,
        }));
        return appended;
      }),
    ),
  appendRecord: (sessionId: SessionId, input: RecordDraft) =>
    withSession(stateRef, sessionId, (_session) =>
      Effect.gen(function* () {
        // Append inputs reject unknown fields so a newer writer cannot silently lose durable data.
        const record = yield* decodeRecordDraft(input).pipe(
          Effect.mapError((cause) => rejectedDraft(input.kind, cause)),
        );

        if (record.kind === "leaf_moved") {
          return yield* Effect.fail(
            new JournalDraftRejected({ kind: record.kind, reason: "reserved_kind" }),
          );
        }

        const appended: Record = {
          id: createRecordId(),
          kind: record.kind,
          payload: record.payload,
        };
        yield* appendLine(backing, { item: appended, sessionId, type: "record" });
        yield* updateSession(stateRef, sessionId, (current) => ({
          ...current,
          records: [...current.records, appended],
        }));
        return appended;
      }),
    ),
  createSession: () =>
    Effect.gen(function* () {
      const id = createSessionId();
      const rootEntry: SessionRootEntry = {
        id: createEntryId(),
        kind: "session_root",
        parentId: null,
        payload: {},
      };
      const created: CreatedSession = { id, rootEntry };
      const initial: SessionState = {
        entries: new Map([[rootEntry.id, rootEntry]]),
        leaf: rootEntry,
        records: [],
        rootEntry,
        semaphore: TSemaphore.unsafeMake(1),
      };

      yield* appendLine(backing, { item: rootEntry, sessionId: id, type: "entry" });
      yield* Ref.update(stateRef, (state) => ({
        sessions: new Map([...state.sessions, [id, initial]]),
      }));
      return created;
    }),
  getLeaf: (sessionId: SessionId) =>
    withSession(stateRef, sessionId, (session) => Effect.succeed(session.leaf)),
  listSessions: () =>
    Ref.get(stateRef).pipe(
      Effect.map((state) =>
        Array.from(
          state.sessions,
          ([id, session]): CreatedSession => ({
            id,
            rootEntry: session.rootEntry,
          }),
        ),
      ),
    ),
  moveLeaf: (sessionId: SessionId, toEntryId: EntryId) =>
    withSession(stateRef, sessionId, (session) =>
      Effect.gen(function* () {
        if (!session.entries.has(toEntryId)) {
          return yield* Effect.fail(new JournalNotFound({ id: toEntryId, what: "entry" }));
        }

        const record: Record = {
          id: createRecordId(),
          kind: "leaf_moved",
          payload: { toEntryId },
        };
        yield* appendLine(backing, { item: record, sessionId, type: "record" });
        const leaf = session.entries.get(toEntryId);

        if (leaf === undefined) {
          return yield* Effect.die("Session entry vanished while its semaphore was held.");
        }

        yield* updateSession(stateRef, sessionId, (current) => ({
          ...current,
          leaf,
          records: [...current.records, record],
        }));
        return record;
      }),
    ),
  readBranch: (sessionId: SessionId) =>
    withSession(stateRef, sessionId, (session) => {
      const branch: Array<Entry> = [];
      let entry: Entry | undefined = session.leaf;

      while (entry !== undefined) {
        branch.push(entry);
        entry = entry.parentId === null ? undefined : session.entries.get(entry.parentId);
      }

      return Effect.succeed(branch.reverse());
    }),
  readRecords: (sessionId: SessionId) =>
    withSession(stateRef, sessionId, (session) => Effect.succeed(session.records)),
});

export const createMemoryJournalBacking = (): MemoryJournalBacking => ({
  [memoryJournalBacking]: Ref.unsafeMake<ReadonlyArray<JournalLine>>([]),
});

export const JournalMemory = (backing: MemoryJournalBacking): Layer.Layer<Journal, JournalError> =>
  Layer.effect(
    Journal,
    Effect.gen(function* () {
      const lines = yield* Ref.get(backing[memoryJournalBacking]);
      const state = yield* deriveState(lines);
      const stateRef = yield* Ref.make(state);
      return createJournalMemory(backing, stateRef);
    }),
  );

export const createMemoryJournalHarness = () => {
  const backing = createMemoryJournalBacking();

  return {
    layer: JournalMemory(backing),
    reopen: () => JournalMemory(backing),
    snapshotLines: (): Effect.Effect<ReadonlyArray<unknown>> =>
      Ref.get(backing[memoryJournalBacking]).pipe(
        Effect.map((lines): ReadonlyArray<unknown> => structuredClone(lines)),
      ),
  };
};
