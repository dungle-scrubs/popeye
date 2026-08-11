/**
 * Owns Kernel-facing session creation and later lifecycle restoration from the Journal.
 * It exists so Session identity, Leaf position, and revision remain journal-derived at one seam.
 */

import {
  EntryDraftSchema,
  EntrySchema,
  Journal,
  JournalDraftRejected,
  type JournalFailure,
  type SessionId,
  SessionIdSchema,
} from "@pop-eye/journal";
import { Context, Effect, Layer, Schema } from "effect";
import { SessionNamePayloadSchema } from "./entry-payloads.js";
import { Mailbox, type MailboxFailure } from "./mailbox.js";
import {
  applyRecoveryPlan,
  boundedRecoveryRecords,
  type RecoveryReport,
  RecoveryReportSchema,
  recoverSession,
} from "./recovery.js";
import { ToolRegistry } from "./tool.js";

export const SessionInfoSchema = Schema.Struct({
  id: SessionIdSchema,
  leaf: EntrySchema,
  revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});

export type SessionInfo = Schema.Schema.Type<typeof SessionInfoSchema>;

export const SessionSummarySchema = Schema.Struct({
  id: SessionIdSchema,
  revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});

export type SessionSummary = Schema.Schema.Type<typeof SessionSummarySchema>;

export const ResumedSessionInfoSchema = Schema.Struct({
  id: SessionIdSchema,
  leaf: EntrySchema,
  recovery: RecoveryReportSchema,
  revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});

export type ResumedSessionInfo = Schema.Schema.Type<typeof ResumedSessionInfoSchema>;

export type SessionsFailure = JournalFailure | MailboxFailure;

export interface SessionsOptions {
  readonly recoveryDiagnosticSink?: (report: RecoveryReport) => Effect.Effect<void>;
}

export interface SessionsService {
  readonly create: () => Effect.Effect<SessionInfo, SessionsFailure>;
  readonly list: () => Effect.Effect<ReadonlyArray<SessionSummary>, JournalFailure>;
  readonly resume: (sessionId: SessionId) => Effect.Effect<ResumedSessionInfo, SessionsFailure>;
  readonly setSessionName: (
    sessionId: SessionId,
    name: string,
    expectedRevision?: number,
  ) => Effect.Effect<void, SessionsFailure>;
}

export class Sessions extends Context.Tag("@pop-eye/kernel/Sessions")<
  Sessions,
  SessionsService
>() {}

const defaultRecoveryDiagnosticSink = (report: RecoveryReport): Effect.Effect<void> =>
  Effect.logInfo(
    JSON.stringify({
      actionCount: report.actions.length,
      diagnostic: "session_recovery",
      entriesAppended: report.entriesAppended,
      operationIdFound: report.operationIdFound,
      safeReplayCount: report.safeReplay.length,
    }),
  );

export const SessionsLive = (
  options: SessionsOptions = {},
): Layer.Layer<Sessions, never, Journal | Mailbox | ToolRegistry> =>
  Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const journal = yield* Journal;
      const mailbox = yield* Mailbox;
      const registry = yield* ToolRegistry;
      const recoveryDiagnosticSink =
        options.recoveryDiagnosticSink ?? defaultRecoveryDiagnosticSink;

      return {
        create: () =>
          Effect.gen(function* () {
            const created = yield* journal.createSession();
            const revision = yield* journal.countDurableLines(created.id);
            yield* mailbox.activate(created.id);
            return { id: created.id, leaf: created.rootEntry, revision };
          }),
        list: () =>
          journal
            .listSessions()
            .pipe(
              Effect.flatMap((sessions) =>
                Effect.forEach(sessions, ({ id }) =>
                  journal.countDurableLines(id).pipe(Effect.map((revision) => ({ id, revision }))),
                ),
              ),
            ),
        resume: (sessionId: SessionId) =>
          Effect.gen(function* () {
            yield* mailbox.activate(sessionId);
            const recovered = yield* mailbox.enqueue(sessionId, {
              name: "recovery",
              run: () =>
                Effect.gen(function* () {
                  const allRecords = yield* journal.readRecords(sessionId);
                  const records = boundedRecoveryRecords(allRecords);
                  const entries = yield* journal.readBranch(sessionId);
                  const plan = yield* recoverSession(records, entries);
                  const sessionView = yield* registry.view(sessionId);
                  const report = yield* applyRecoveryPlan(journal, sessionId, plan, {
                    availableToolNames: new Set(sessionView.list().map((tool) => tool.name)),
                    snapshot: { entries, records: allRecords },
                  });
                  yield* Effect.annotateCurrentSpan({
                    actionCount: report.actions.length,
                    entriesAppendedCount: report.entriesAppended.length,
                    operationIdFound: report.operationIdFound ?? "none",
                    safeReplayCount: report.safeReplay.length,
                  });
                  yield* recoveryDiagnosticSink(report);
                  const leaf = yield* journal.getLeaf(sessionId);
                  return { leaf, report };
                }).pipe(Effect.withSpan("kernel.recovery", { attributes: { sessionId } })),
            });
            return {
              id: sessionId,
              leaf: recovered.value.leaf,
              recovery: recovered.value.report,
              revision: recovered.revision,
            };
          }),
        setSessionName: (sessionId, name, expectedRevision) =>
          mailbox
            .enqueue(sessionId, {
              ...(expectedRevision === undefined ? {} : { expectedRevision }),
              name: "set-session-name",
              run: () =>
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
                    journal.appendEntry(
                      sessionId,
                      EntryDraftSchema.make({ kind: "session_name", payload }),
                    ),
                  ),
                ),
            })
            .pipe(Effect.asVoid),
      };
    }),
  );
