/**
 * Owns Kernel-facing session creation and later lifecycle restoration from the Journal.
 * It exists so Session identity, Leaf position, and revision remain journal-derived at one seam.
 */

import { type Entry, Journal, type JournalFailure, type SessionId } from "@peye/journal";
import { Context, Effect, Layer } from "effect";
import { Mailbox, type MailboxFailure } from "./mailbox.js";
import {
  applyRecoveryPlan,
  boundedRecoveryRecords,
  type RecoveryReport,
  recoverSession,
} from "./recovery.js";
import { ToolRegistry } from "./tool.js";

export interface SessionInfo {
  readonly id: SessionId;
  readonly leaf: Entry;
  readonly revision: number;
}

export interface SessionSummary {
  readonly id: SessionId;
  readonly revision: number;
}

export interface ResumedSessionInfo extends SessionInfo {
  readonly recovery: RecoveryReport;
}

export type SessionsFailure = JournalFailure | MailboxFailure;

export interface SessionsOptions {
  readonly recoveryDiagnosticSink?: (report: RecoveryReport) => Effect.Effect<void>;
}

export interface SessionsService {
  readonly create: () => Effect.Effect<SessionInfo, SessionsFailure>;
  readonly list: () => Effect.Effect<ReadonlyArray<SessionSummary>, JournalFailure>;
  readonly resume: (sessionId: SessionId) => Effect.Effect<ResumedSessionInfo, SessionsFailure>;
}

export class Sessions extends Context.Tag("@peye/kernel/Sessions")<Sessions, SessionsService>() {}

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
                  const report = yield* applyRecoveryPlan(journal, sessionId, plan, {
                    availableToolNames: new Set(registry.list().map((tool) => tool.name)),
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
      };
    }),
  );
