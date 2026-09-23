/**
 * Owns session lifecycle against the Journal seam.
 * It exists so create/list/resume/branch/compact/leaf/revision operate through
 * one Journal caller instead of drifting between sessions.ts and driver.ts.
 * Deep module over RecoveryEngine (C1 architecture review): resume delegates to
 * RecoveryEngine, the single owner of the readRecords→bounded→readBranch→recover→apply→getLeaf
 * sequence, so D-033 second-crash safety is inspected once.
 *
 * Why this module: kernel recovery and session creation were duplicated
 * between sessions.ts and driver.ts (each called Journal directly). This
 * module is the ONE caller for session lifecycle Journal operations.
 * Not responsible for mailbox serialization (callers own that), for
 * ToolRegistry view resolution (caller provides availableToolNames), or
 * for journal persistence (adapter-core owns that). Provider transport
 * stays behind Provider seam.
 */

import {
  type Entry,
  EntryDraftSchema,
  Journal,
  JournalDraftRejected,
  type JournalFailure,
  type SessionId,
} from "@popeye/journal";
import { Context, Effect, Layer, Schema } from "effect";
import { SessionNamePayloadSchema } from "./entry-payloads.js";
import type { RecoveryReport } from "./recovery.js";
import { makeRecoveryEngineForTest } from "./recovery-engine.js";

export interface SessionStoreOptions {
  readonly recoveryDiagnosticSink?: (report: RecoveryReport) => Effect.Effect<void>;
}

export interface SessionStoreService {
  readonly appendCompaction: (
    sessionId: SessionId,
    payload: import("@popeye/journal").CompactionPayload,
  ) => Effect.Effect<Entry, JournalFailure>;
  readonly appendEntry: (
    sessionId: SessionId,
    entry: import("@popeye/journal").EntryDraft,
  ) => Effect.Effect<Entry, JournalFailure>;
  readonly appendSessionName: (
    sessionId: SessionId,
    name: string,
  ) => Effect.Effect<void, JournalFailure>;
  readonly countDurableLines: (sessionId: SessionId) => Effect.Effect<number, JournalFailure>;
  readonly createSession: () => Effect.Effect<
    { readonly id: SessionId; readonly leaf: Entry },
    JournalFailure
  >;
  readonly getBranch: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<Entry>, JournalFailure>;
  readonly getLeaf: (sessionId: SessionId) => Effect.Effect<Entry, JournalFailure>;
  readonly listSessions: () => Effect.Effect<
    ReadonlyArray<{ readonly id: SessionId; readonly revision: number }>,
    JournalFailure
  >;
  readonly moveLeaf: (
    sessionId: SessionId,
    toEntryId: string,
  ) => Effect.Effect<void, JournalFailure>;
  readonly readRecords: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<import("@popeye/journal").Record>, JournalFailure>;
  readonly resume: (
    sessionId: SessionId,
    availableToolNames: ReadonlySet<string>,
  ) => Effect.Effect<{ readonly leaf: Entry; readonly report: RecoveryReport }, JournalFailure>;
}

export class SessionStore extends Context.Tag("@popeye/kernel/SessionStore")<
  SessionStore,
  SessionStoreService
>() {}

const defaultRecoveryDiagnosticSink = (report: RecoveryReport): Effect.Effect<void> =>
  Effect.logInfo(
    JSON.stringify({
      actionCount: report.actions.length,
      diagnostic: "session_recovery",
      entriesAppended: report.entriesAppended,
      operationIdFound: report.operationIdFound ?? "none",
      safeReplayCount: report.safeReplay.length,
    }),
  );

const makeSessionStoreService = (
  journal: import("@popeye/journal").JournalService,
  options: SessionStoreOptions = {},
): SessionStoreService => {
  const recoveryDiagnosticSink = options.recoveryDiagnosticSink ?? defaultRecoveryDiagnosticSink;
  const recoveryEngine = makeRecoveryEngineForTest(journal, { recoveryDiagnosticSink });

  return {
    appendCompaction: (sessionId, payload) => journal.appendCompaction(sessionId, payload),
    appendEntry: (sessionId, entry) => journal.appendEntry(sessionId, entry),
    appendSessionName: (sessionId, name) =>
      Schema.decodeUnknown(SessionNamePayloadSchema)({ name }).pipe(
        Effect.mapError(
          (cause) =>
            new JournalDraftRejected({
              cause,
              kind: "session_name",
              reason: "invalid_payload",
            }),
        ),
        Effect.flatMap((payload) =>
          journal.appendEntry(sessionId, EntryDraftSchema.make({ kind: "session_name", payload })),
        ),
        Effect.asVoid,
      ),
    countDurableLines: (sessionId) => journal.countDurableLines(sessionId),
    createSession: () =>
      Effect.gen(function* () {
        const created = yield* journal.createSession();
        return { id: created.id, leaf: created.rootEntry };
      }),
    getBranch: (sessionId) => journal.readBranch(sessionId),
    getLeaf: (sessionId) => journal.getLeaf(sessionId),
    listSessions: () =>
      journal
        .listSessions()
        .pipe(
          Effect.flatMap((sessions) =>
            Effect.forEach(sessions, ({ id }) =>
              journal.countDurableLines(id).pipe(Effect.map((revision) => ({ id, revision }))),
            ),
          ),
        ),
    moveLeaf: (sessionId, toEntryId) =>
      journal
        .moveLeaf(sessionId, toEntryId as unknown as import("@popeye/journal").EntryId)
        .pipe(Effect.asVoid),
    readRecords: (sessionId) => journal.readRecords(sessionId),
    resume: (sessionId, availableToolNames) => recoveryEngine.resume(sessionId, availableToolNames),
  } satisfies SessionStoreService;
};

export const SessionStoreLive = (
  options: SessionStoreOptions = {},
): Layer.Layer<SessionStore, never, Journal> =>
  Layer.effect(
    SessionStore,
    Effect.gen(function* () {
      const journal = yield* Journal;
      return makeSessionStoreService(journal, options);
    }),
  );

export const makeSessionStoreForTest = (
  journal: import("@popeye/journal").JournalService,
  options: SessionStoreOptions = {},
): SessionStoreService => makeSessionStoreService(journal, options);
