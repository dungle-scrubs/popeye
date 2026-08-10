/**
 * Owns the in-process protocol-shaped interface used to drive the Kernel.
 * It exists because D-021 makes the Driver the seam used by tests and the SDK, and the surface
 * plugin Commands are exercised on before wire Heads exist. The interface is deliberately shaped
 * like the Protocol so M20 wire frames map to it one-to-one. It is not a wire transport.
 */

import {
  type CompactionPayload,
  EntryDraftSchema,
  type EntryId,
  EntrySchema,
  Journal,
  JournalError,
  type JournalFailure,
  type SessionId,
  SessionIdSchema,
} from "@peye/journal";
import { Context, Effect, Layer, Ref, Schema, type Stream } from "effect";

import { Compaction, type CompactionFailure, type CompactionResult } from "./compaction-policy.js";
import { Mailbox, type MailboxFailure } from "./mailbox.js";
import { type Progress, ProgressHub, TurnPhaseSchema } from "./progress.js";
import type { ThinkingLevel } from "./provider.js";
import {
  type ResumedSessionInfo,
  type SessionInfo,
  type SessionSummary,
  Sessions,
  type SessionsFailure,
} from "./sessions.js";
import {
  type AbortTurnResult,
  type TurnFailure,
  type TurnOptions,
  type TurnResult,
  Turns,
  type TurnsService,
} from "./turn.js";

export const DriverSnapshotSchema = Schema.Struct({
  entries: Schema.Array(EntrySchema),
  leaf: EntrySchema,
  model: Schema.optional(Schema.String),
  phase: TurnPhaseSchema,
  revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  sessionId: SessionIdSchema,
  thinkingLevel: Schema.optional(
    Schema.Literal("high", "low", "max", "medium", "minimal", "xhigh"),
  ),
});

export type DriverSnapshot = Schema.Schema.Type<typeof DriverSnapshotSchema>;

interface SessionSettings {
  readonly model?: string;
  readonly thinkingLevel?: ThinkingLevel;
}

export type DriverFailure =
  | CompactionFailure
  | JournalFailure
  | MailboxFailure
  | SessionsFailure
  | TurnFailure;

export interface DriverService {
  readonly abortTurn: (sessionId: SessionId) => Effect.Effect<AbortTurnResult>;
  readonly attach: (sessionId: SessionId) => Effect.Effect<DriverSnapshot, JournalFailure>;
  readonly branch: (
    sessionId: SessionId,
    toEntryId: EntryId,
  ) => Effect.Effect<DriverSnapshot, JournalFailure | MailboxFailure>;
  readonly compactNow: (sessionId: SessionId) => Effect.Effect<CompactionResult, CompactionFailure>;
  readonly createSession: () => Effect.Effect<SessionInfo, SessionsFailure>;
  readonly detach: (sessionId: SessionId) => Effect.Effect<void>;
  readonly fork: (
    sessionId: SessionId,
    fromEntryId: EntryId,
  ) => Effect.Effect<DriverSnapshot, JournalFailure | MailboxFailure>;
  readonly getSnapshot: (sessionId: SessionId) => Effect.Effect<DriverSnapshot, JournalFailure>;
  readonly listSessions: () => Effect.Effect<ReadonlyArray<SessionSummary>, JournalFailure>;
  readonly prompt: (
    sessionId: SessionId,
    content: string,
    options?: TurnOptions,
  ) => Effect.Effect<TurnResult, TurnFailure>;
  readonly resumeSession: (
    sessionId: SessionId,
  ) => Effect.Effect<ResumedSessionInfo, SessionsFailure>;
  readonly setModel: (
    sessionId: SessionId,
    model: string,
  ) => Effect.Effect<void, JournalFailure | MailboxFailure>;
  readonly setThinkingLevel: (
    sessionId: SessionId,
    thinkingLevel: ThinkingLevel,
  ) => Effect.Effect<void, JournalFailure | MailboxFailure>;
  readonly steer: TurnsService["steer"];
  readonly subscribeProgress: (sessionId: SessionId) => Stream.Stream<Progress>;
}

export class Driver extends Context.Tag("@peye/kernel/Driver")<Driver, DriverService>() {}

const remapEntryId = (
  ids: ReadonlyMap<EntryId, EntryId>,
  sourceId: EntryId,
): Effect.Effect<EntryId, JournalError> => {
  const mapped = ids.get(sourceId);
  return mapped === undefined
    ? Effect.fail(
        new JournalError({
          corruptionClass: "invalid_compaction",
          message: `Fork could not remap Compaction Entry ${sourceId}.`,
        }),
      )
    : Effect.succeed(mapped);
};

const remapCompaction = (
  ids: ReadonlyMap<EntryId, EntryId>,
  payload: CompactionPayload,
): Effect.Effect<CompactionPayload, JournalError> =>
  Effect.gen(function* () {
    const firstSummarizedId = yield* remapEntryId(ids, payload.firstSummarizedId);
    const lastSummarizedId = yield* remapEntryId(ids, payload.lastSummarizedId);
    const retainedTailIds = yield* Effect.forEach(payload.retainedTailIds, (id) =>
      remapEntryId(ids, id),
    );
    return {
      firstSummarizedId,
      lastSummarizedId,
      retainedTailIds,
      summary: payload.summary,
    };
  });

export const DriverLive: Layer.Layer<
  Driver,
  never,
  Compaction | Journal | Mailbox | ProgressHub | Sessions | Turns
> = Layer.effect(
  Driver,
  Effect.gen(function* () {
    const compaction = yield* Compaction;
    const journal = yield* Journal;
    const mailbox = yield* Mailbox;
    const progress = yield* ProgressHub;
    const sessions = yield* Sessions;
    const turns = yield* Turns;
    const attachedSessions = yield* Ref.make<ReadonlySet<SessionId>>(new Set());
    const sessionSettings = yield* Ref.make<ReadonlyMap<SessionId, SessionSettings>>(new Map());

    const readSnapshot = (sessionId: SessionId): Effect.Effect<DriverSnapshot, JournalFailure> =>
      Effect.gen(function* () {
        const entries = yield* journal.readBranch(sessionId);
        const leaf = yield* journal.getLeaf(sessionId);
        const phase = yield* progress.currentPhase(sessionId);
        const revision = yield* journal.countDurableLines(sessionId);
        const settings = (yield* Ref.get(sessionSettings)).get(sessionId);
        return DriverSnapshotSchema.make({
          entries: [...entries],
          leaf,
          ...(settings?.model === undefined ? {} : { model: settings.model }),
          phase,
          revision,
          sessionId,
          ...(settings?.thinkingLevel === undefined
            ? {}
            : { thinkingLevel: settings.thinkingLevel }),
        });
      });

    const updateSettings = (
      sessionId: SessionId,
      update: (settings: SessionSettings) => SessionSettings,
    ): Effect.Effect<void, JournalFailure | MailboxFailure> =>
      mailbox
        .enqueue(sessionId, {
          name: "driver-settings",
          run: () =>
            Ref.update(sessionSettings, (current) => {
              const next = new Map(current);
              next.set(sessionId, update(current.get(sessionId) ?? {}));
              return next;
            }),
        })
        .pipe(Effect.asVoid);

    const forkBranch = (
      sessionId: SessionId,
      fromEntryId: EntryId,
    ): Effect.Effect<DriverSnapshot, JournalFailure | MailboxFailure> =>
      Effect.gen(function* () {
        const source = yield* journal.readBranch(sessionId);
        const branchPoint = source.findIndex((entry) => entry.id === fromEntryId);
        if (branchPoint < 0) {
          return yield* Effect.fail(
            new JournalError({
              corruptionClass: "dangling_leaf_reference",
              message: `Fork Entry ${fromEntryId} is not on the current Branch.`,
            }),
          );
        }
        const created = yield* sessions.create();
        const sourceRoot = source[0];
        if (sourceRoot === undefined) {
          return yield* Effect.fail(
            new JournalError({
              corruptionClass: "dangling_leaf_reference",
              message: `Fork Session ${sessionId} has no root Entry.`,
            }),
          );
        }
        const ids = new Map<EntryId, EntryId>([[sourceRoot.id, created.leaf.id]]);
        for (const entry of source.slice(1, branchPoint + 1)) {
          const appended =
            entry.kind === "compaction"
              ? yield* journal.appendCompaction(
                  created.id,
                  yield* remapCompaction(ids, entry.payload as CompactionPayload),
                )
              : yield* journal.appendEntry(
                  created.id,
                  EntryDraftSchema.make({ kind: entry.kind, payload: entry.payload }),
                );
          ids.set(entry.id, appended.id);
        }
        const settings = (yield* Ref.get(sessionSettings)).get(sessionId);
        if (settings !== undefined) {
          yield* Ref.update(sessionSettings, (current) =>
            new Map(current).set(created.id, settings),
          );
        }
        return yield* readSnapshot(created.id);
      });

    return {
      abortTurn: (sessionId) => turns.abortTurn(sessionId),
      attach: (sessionId) =>
        readSnapshot(sessionId).pipe(
          Effect.tap(() =>
            Ref.update(attachedSessions, (current) => new Set(current).add(sessionId)),
          ),
        ),
      branch: (sessionId, toEntryId) =>
        mailbox
          .enqueue(sessionId, {
            name: "branch",
            run: () =>
              journal.moveLeaf(sessionId, toEntryId).pipe(Effect.zipRight(readSnapshot(sessionId))),
          })
          .pipe(Effect.map((result) => result.value)),
      compactNow: (sessionId) => compaction.compactNow(sessionId),
      createSession: () => sessions.create(),
      detach: (sessionId) =>
        Ref.update(attachedSessions, (current) => {
          const next = new Set(current);
          next.delete(sessionId);
          return next;
        }),
      fork: (sessionId, fromEntryId) =>
        mailbox
          .enqueue(sessionId, {
            name: "fork",
            run: () => forkBranch(sessionId, fromEntryId),
          })
          .pipe(Effect.map((result) => result.value)),
      getSnapshot: readSnapshot,
      listSessions: () => sessions.list(),
      prompt: (sessionId, content, options = {}) =>
        Ref.get(sessionSettings).pipe(
          Effect.map((current) => current.get(sessionId)),
          Effect.flatMap((settings) =>
            turns.runTurn(sessionId, content, {
              ...options,
              ...(settings?.model === undefined ? {} : { model: settings.model }),
              ...(settings?.thinkingLevel === undefined
                ? {}
                : { thinkingLevel: settings.thinkingLevel }),
            }),
          ),
        ),
      resumeSession: (sessionId) => sessions.resume(sessionId),
      setModel: (sessionId, model) =>
        updateSettings(sessionId, (settings) => ({ ...settings, model })),
      setThinkingLevel: (sessionId, thinkingLevel) =>
        updateSettings(sessionId, (settings) => ({ ...settings, thinkingLevel })),
      steer: (sessionId, content) => turns.steer(sessionId, content),
      subscribeProgress: (sessionId) => progress.subscribe(sessionId),
    } satisfies DriverService;
  }),
);
