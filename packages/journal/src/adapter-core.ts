/**
 * Owns Journal service behavior shared by every persistence adapter.
 * It exists so validation, per-session serialization, cache invalidation, and state transitions
 * do not drift between the in-memory and durable implementations.
 */
import { randomBytes } from "node:crypto";

import { Effect, Ref, Schema, TSemaphore } from "effect";

import {
  JournalDraftRejected,
  type JournalError,
  type JournalFailure,
  JournalNotFound,
} from "./errors.js";
import {
  branchToLeaf,
  type CreatedSession,
  compactionValidationIssue,
  type DerivedSession,
  Journal,
  type JournalService,
} from "./journal.js";
import {
  type CompactionPayload,
  CompactionPayloadSchema,
  type Entry,
  EntryDraftSchema,
  type EntryId,
  EntryIdSchema,
  type JournalLine,
  type Record,
  RecordDraftSchema,
  type RecordId,
  RecordIdSchema,
  type SessionId,
  SessionIdSchema,
  type SessionRootEntry,
} from "./shapes.js";

const strict: { readonly onExcessProperty: "error" } = { onExcessProperty: "error" };
const decodeEntryDraft = Schema.decodeUnknown(EntryDraftSchema, strict);
const decodeRecordDraft = Schema.decodeUnknown(RecordDraftSchema, strict);
const decodeCompactionPayload = Schema.decodeUnknown(CompactionPayloadSchema, strict);

const createId = (): string => randomBytes(12).toString("base64url");
const createEntryId = (): EntryId => EntryIdSchema.make(createId());
const createRecordId = (): RecordId => RecordIdSchema.make(createId());
const createSessionId = (): SessionId => SessionIdSchema.make(createId());

const missingSession = (sessionId: SessionId): JournalNotFound =>
  new JournalNotFound({ id: sessionId, what: "session" });

const rejectedDraft = (kind: string, cause: unknown): JournalDraftRejected =>
  new JournalDraftRejected({ cause, kind, reason: "invalid_payload" });

const rejectedCompaction = (message: string): JournalDraftRejected =>
  new JournalDraftRejected({ kind: "compaction", message, reason: "invalid_payload" });

const validateCompaction = (
  session: DerivedSession,
  payload: CompactionPayload,
): JournalDraftRejected | undefined => {
  const issue = compactionValidationIssue(session, payload);
  return issue === undefined ? undefined : rejectedCompaction(issue);
};

export interface JournalIoObservation {
  readonly operation: "ack" | "sync" | "write";
  readonly sessionId: SessionId;
}

export interface JournalPersistence {
  readonly initializeSession: (
    sessionId: SessionId,
    rootEntry: SessionRootEntry,
  ) => Effect.Effect<void, JournalError>;
  readonly loadSession: (sessionId: SessionId) => Effect.Effect<DerivedSession, JournalError>;
  readonly observe?: (observation: JournalIoObservation) => Effect.Effect<void>;
  readonly persistLine: (
    sessionId: SessionId,
    line: JournalLine,
  ) => Effect.Effect<void, JournalError>;
}

interface AvailableSession {
  readonly derived: DerivedSession | undefined;
  readonly kind: "available";
  readonly semaphore: TSemaphore.TSemaphore;
}

interface RejectedSession {
  readonly error: JournalError;
  readonly kind: "rejected";
}

type SessionSlot = AvailableSession | RejectedSession;

export interface JournalAdapterState {
  readonly sessions: ReadonlyMap<SessionId, SessionSlot>;
}

export const availableSession = (derived: DerivedSession): SessionSlot => ({
  derived,
  kind: "available",
  semaphore: TSemaphore.unsafeMake(1),
});

export const rejectedSession = (error: JournalError): SessionSlot => ({ error, kind: "rejected" });

const updateSession = (
  stateRef: Ref.Ref<JournalAdapterState>,
  sessionId: SessionId,
  update: (session: AvailableSession) => AvailableSession,
): Effect.Effect<void> =>
  Ref.update(stateRef, (state) => {
    const previous = state.sessions.get(sessionId);
    if (previous === undefined || previous.kind === "rejected") {
      return state;
    }
    const sessions = new Map(state.sessions);
    sessions.set(sessionId, update(previous));
    return { sessions };
  });

const invalidateSession = (
  stateRef: Ref.Ref<JournalAdapterState>,
  sessionId: SessionId,
): Effect.Effect<void> =>
  updateSession(stateRef, sessionId, (session) => ({ ...session, derived: undefined }));

const loadCurrentSession = (
  persistence: JournalPersistence,
  stateRef: Ref.Ref<JournalAdapterState>,
  sessionId: SessionId,
): Effect.Effect<DerivedSession, JournalError | JournalNotFound> =>
  Effect.gen(function* () {
    const slot = (yield* Ref.get(stateRef)).sessions.get(sessionId);
    if (slot === undefined) {
      return yield* Effect.fail(missingSession(sessionId));
    }
    if (slot.kind === "rejected") {
      return yield* Effect.fail(slot.error);
    }
    if (slot.derived !== undefined) {
      return slot.derived;
    }
    const derived = yield* persistence.loadSession(sessionId);
    yield* updateSession(stateRef, sessionId, (current) => ({ ...current, derived }));
    return derived;
  });

const withSession = <TOutput>(
  persistence: JournalPersistence,
  stateRef: Ref.Ref<JournalAdapterState>,
  sessionId: SessionId,
  operation: (session: DerivedSession) => Effect.Effect<TOutput, JournalFailure>,
): Effect.Effect<TOutput, JournalFailure> =>
  Effect.gen(function* () {
    const slot = (yield* Ref.get(stateRef)).sessions.get(sessionId);
    if (slot === undefined) {
      return yield* Effect.fail(missingSession(sessionId));
    }
    if (slot.kind === "rejected") {
      return yield* Effect.fail(slot.error);
    }
    // Read state only after taking the permit. A failed append may invalidate its cache while queued.
    return yield* loadCurrentSession(persistence, stateRef, sessionId)
      .pipe(Effect.flatMap(operation))
      .pipe(TSemaphore.withPermit(slot.semaphore));
  });

const acknowledge = (persistence: JournalPersistence, sessionId: SessionId): Effect.Effect<void> =>
  persistence.observe?.({ operation: "ack", sessionId }) ?? Effect.void;

const persist = (
  persistence: JournalPersistence,
  stateRef: Ref.Ref<JournalAdapterState>,
  sessionId: SessionId,
  line: JournalLine,
): Effect.Effect<void, JournalError> =>
  persistence.persistLine(sessionId, line).pipe(
    Effect.andThen(acknowledge(persistence, sessionId)),
    Effect.catchTag("JournalError", (error) =>
      invalidateSession(stateRef, sessionId).pipe(Effect.andThen(Effect.fail(error))),
    ),
  );

export const createJournalAdapter = (
  initialState: JournalAdapterState,
  persistence: JournalPersistence,
): Effect.Effect<JournalService, never> =>
  Effect.gen(function* () {
    const stateRef = yield* Ref.make(initialState);

    return Journal.of({
      appendCompaction: (sessionId, input) =>
        withSession(persistence, stateRef, sessionId, (session) =>
          Effect.gen(function* () {
            const payload = yield* decodeCompactionPayload(input).pipe(
              Effect.mapError((cause) => rejectedDraft("compaction", cause)),
            );
            const invalid = validateCompaction(session, payload);
            if (invalid !== undefined) {
              return yield* Effect.fail(invalid);
            }
            const appended: Entry = {
              id: createEntryId(),
              kind: "compaction",
              parentId: session.leaf.id,
              payload,
            };
            yield* persist(persistence, stateRef, sessionId, {
              item: appended,
              sessionId,
              type: "entry",
            });
            yield* updateSession(stateRef, sessionId, (current) => ({
              ...current,
              derived: {
                ...session,
                entries: new Map([...session.entries, [appended.id, appended]]),
                leaf: appended,
              },
            }));
            return appended;
          }),
        ),
      appendEntry: (sessionId, input) =>
        withSession(persistence, stateRef, sessionId, (session) =>
          Effect.gen(function* () {
            const entry = yield* decodeEntryDraft(input).pipe(
              Effect.mapError((cause) => rejectedDraft(input.kind, cause)),
            );
            if (entry.kind === "session_root" || entry.kind === "compaction") {
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
            yield* persist(persistence, stateRef, sessionId, {
              item: appended,
              sessionId,
              type: "entry",
            });
            yield* updateSession(stateRef, sessionId, (current) => ({
              ...current,
              derived: {
                ...session,
                entries: new Map([...session.entries, [appended.id, appended]]),
                leaf: appended,
              },
            }));
            return appended;
          }),
        ),
      appendRecord: (sessionId, input) =>
        withSession(persistence, stateRef, sessionId, (session) =>
          Effect.gen(function* () {
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
            yield* persist(persistence, stateRef, sessionId, {
              item: appended,
              sessionId,
              type: "record",
            });
            yield* updateSession(stateRef, sessionId, (current) => ({
              ...current,
              derived: { ...session, records: [...session.records, appended] },
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
          yield* persistence.initializeSession(id, rootEntry);
          yield* acknowledge(persistence, id);
          const derived: DerivedSession = {
            entries: new Map([[rootEntry.id, rootEntry]]),
            leaf: rootEntry,
            records: [],
            rootEntry,
          };
          yield* Ref.update(stateRef, (state) => ({
            sessions: new Map([...state.sessions, [id, availableSession(derived)]]),
          }));
          return { id, rootEntry } satisfies CreatedSession;
        }),
      countDurableLines: (sessionId) =>
        withSession(persistence, stateRef, sessionId, (session) =>
          Effect.succeed(session.entries.size + session.records.length),
        ),
      getLeaf: (sessionId) =>
        withSession(persistence, stateRef, sessionId, (session) => Effect.succeed(session.leaf)),
      listSessions: () =>
        Ref.get(stateRef).pipe(
          Effect.map((state) =>
            Array.from(state.sessions).flatMap(
              ([id, slot]): ReadonlyArray<CreatedSession> =>
                slot.kind === "available" && slot.derived !== undefined
                  ? [{ id, rootEntry: slot.derived.rootEntry }]
                  : [],
            ),
          ),
        ),
      moveLeaf: (sessionId, toEntryId) =>
        withSession(persistence, stateRef, sessionId, (session) =>
          Effect.gen(function* () {
            if (!session.entries.has(toEntryId)) {
              return yield* Effect.fail(new JournalNotFound({ id: toEntryId, what: "entry" }));
            }
            const record: Record = {
              id: createRecordId(),
              kind: "leaf_moved",
              payload: { toEntryId },
            };
            yield* persist(persistence, stateRef, sessionId, {
              item: record,
              sessionId,
              type: "record",
            });
            const leaf = session.entries.get(toEntryId);
            if (leaf === undefined) {
              return yield* Effect.die("Session entry vanished while its semaphore was held.");
            }
            yield* updateSession(stateRef, sessionId, (current) => ({
              ...current,
              derived: { ...session, leaf, records: [...session.records, record] },
            }));
            return record;
          }),
        ),
      readBranch: (sessionId) =>
        withSession(persistence, stateRef, sessionId, (session) =>
          Effect.succeed(branchToLeaf(session)),
        ),
      readRecords: (sessionId) =>
        withSession(persistence, stateRef, sessionId, (session) => Effect.succeed(session.records)),
    });
  });
