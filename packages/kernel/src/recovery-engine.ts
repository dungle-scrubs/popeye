/**
 * Owns RecoveryEngine deep module for resumable Session recovery.
 * It exists so the 6-step Journal resume path — readRecords → boundedRecoveryRecords → readBranch → recoverSession → applyRecoveryPlan → getLeaf — hides behind one deep interface resume(sessionId, availableToolNames).
 *
 * Why this module: boundedRecoveryRecords / recoverSession / applyRecoveryPlan were three pure helpers (535 lines in recovery.ts) exercised directly by SessionStore, recovery-matrix boundary probes, and recovery-crash double-crash checks. Each caller re-assembled the Journal read → bounded slice → Branch fold → plan synthesis → Journal write sequence differently. Adding a new Record kind (e.g. fencing) required touching all three call sites, and D-033's "every recovery path closes its open operation" (second-crash safety) could only be inspected at the call site, not at the seam. This module owns the one Recovery fold: callers depend on RecoveryEngine.resume(sessionId, availableToolNames) → RecoveryReport, not on the helpers themselves. The helpers stay as private seams inside the engine.
 *
 * Not responsible for Journal folding (journal owns Branch and deriveSession), for compaction validation (journal owns that), or for mailbox serialization (callers own that). The seam is Journal I/O: two adapters justify it — LiveRecoveryEngine over a real Journal (Sqlite or Jsonl) and FakeRecoveryEngine over JournalMemory in tests. Recovery remains a pure function of a bounded Record slice, so every durable action stays inspectable without hidden reads — dryRun exposes that purity for the matrix harness.
 */

import type {
  Entry,
  JournalFailure,
  Record as JournalRecord,
  JournalService,
  SessionId,
} from "@popeye/journal";
import { Journal } from "@popeye/journal";
import { Context, Effect, Layer } from "effect";

import {
  applyRecoveryPlan,
  boundedRecoveryRecords,
  type RecoveryPlan,
  type RecoveryReport,
  recoverSession,
} from "./recovery.js";

export interface RecoveryEngineOptions {
  readonly recoveryDiagnosticSink?: (report: RecoveryReport) => Effect.Effect<void>;
}

export interface RecoveryEngineService {
  /** Pure: bounded slice of Records since last operation_finished. */
  readonly bounded: (records: ReadonlyArray<JournalRecord>) => ReadonlyArray<JournalRecord>;
  /** Pure: synthesize a RecoveryPlan from a bounded Record slice + current Branch entries. */
  readonly plan: (
    records: ReadonlyArray<JournalRecord>,
    entries: ReadonlyArray<Entry>,
  ) => Effect.Effect<RecoveryPlan, import("@popeye/journal").JournalError>;
  /** Dry-run helper for the matrix harness: bounded + plan without Journal writes. */
  readonly dryRun: (
    allRecords: ReadonlyArray<JournalRecord>,
    entries: ReadonlyArray<Entry>,
  ) => Effect.Effect<
    { readonly bounded: ReadonlyArray<JournalRecord>; readonly plan: RecoveryPlan },
    import("@popeye/journal").JournalError
  >;
  /** Durable: the one resume path — reads Journal, derives plan, applies it, returns leaf + report. */
  readonly resume: (
    sessionId: SessionId,
    availableToolNames: ReadonlySet<string>,
  ) => Effect.Effect<{ readonly leaf: Entry; readonly report: RecoveryReport }, JournalFailure>;
}

export class RecoveryEngine extends Context.Tag("@popeye/kernel/RecoveryEngine")<
  RecoveryEngine,
  RecoveryEngineService
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

const makeRecoveryEngineService = (
  journal: JournalService,
  options: RecoveryEngineOptions = {},
): RecoveryEngineService => {
  const recoveryDiagnosticSink = options.recoveryDiagnosticSink ?? defaultRecoveryDiagnosticSink;
  return {
    bounded: boundedRecoveryRecords,
    dryRun: (allRecords: ReadonlyArray<JournalRecord>, entries: ReadonlyArray<Entry>) =>
      Effect.gen(function* () {
        const bounded = boundedRecoveryRecords(allRecords);
        const plan = yield* recoverSession(bounded, entries);
        return { bounded, plan } as const;
      }),
    plan: recoverSession,
    resume: (sessionId: SessionId, availableToolNames: ReadonlySet<string>) =>
      Effect.gen(function* () {
        const allRecords = yield* journal.readRecords(sessionId);
        const records = boundedRecoveryRecords(allRecords);
        const entries = yield* journal.readBranch(sessionId);
        const plan = yield* recoverSession(records, entries);
        const report = yield* applyRecoveryPlan(journal, sessionId, plan, {
          availableToolNames,
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
  } as unknown as RecoveryEngineService;
};

export const RecoveryEngineLive = (
  options: RecoveryEngineOptions = {},
): Layer.Layer<RecoveryEngine, never, Journal> =>
  Layer.effect(
    RecoveryEngine,
    Effect.gen(function* () {
      const journal = yield* Journal;
      return makeRecoveryEngineService(journal, options);
    }),
  );

export const makeRecoveryEngineForTest = (
  journal: JournalService,
  options: RecoveryEngineOptions = {},
): RecoveryEngineService => makeRecoveryEngineService(journal, options);

// Re-export pure helpers for backward compat — callers should prefer RecoveryEngine.bounded / plan / dryRun
export { applyRecoveryPlan, boundedRecoveryRecords, recoverSession } from "./recovery.js";
