/**
 * Owns Kernel-facing session creation and later lifecycle restoration from the Journal.
 * It exists so Session identity, Leaf position, and revision remain journal-derived at one seam.
 * Thin adapter over SessionStore (D-001): all Journal calls go through SessionStore,
 * the single JournalRecovery consumer placement. History-preserving restructure;
 * recovery.ts stays one commit as re-export.
 */

import {
  EntrySchema,
  Journal,
  type JournalFailure,
  type SessionId,
  SessionIdSchema,
} from "@pop-eye/journal";
import { Context, Effect, Layer, Schema } from "effect";
import { Mailbox, type MailboxFailure } from "./mailbox.js";
import { type RecoveryReport, RecoveryReportSchema } from "./recovery.js";
import { makeSessionStoreForTest } from "./session-store.js";
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
      const store = makeSessionStoreForTest(journal, { recoveryDiagnosticSink });

      return {
        create: () =>
          Effect.gen(function* () {
            const { id, leaf } = yield* store.createSession();
            const revision = yield* store.countDurableLines(id);
            yield* mailbox.activate(id);
            return { id, leaf, revision };
          }),
        list: () => store.listSessions(),
        resume: (sessionId: SessionId) =>
          Effect.gen(function* () {
            yield* mailbox.activate(sessionId);
            const recovered = yield* mailbox.enqueue(sessionId, {
              name: "recovery",
              run: () =>
                Effect.gen(function* () {
                  const view = yield* registry.view(sessionId);
                  const available = new Set(view.list().map((tool) => tool.name));
                  return yield* store.resume(sessionId, available);
                }),
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
              run: () => store.appendSessionName(sessionId, name),
            })
            .pipe(Effect.asVoid),
      };
    }),
  );
