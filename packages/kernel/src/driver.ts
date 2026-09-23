/**
 * Owns the in-process protocol-shaped interface used to drive the Kernel.
 * It exists because D-021 makes the Driver the seam used by tests and the SDK, and the surface
 * plugin Commands are exercised on before wire Heads exist. The interface is deliberately shaped
 * like the Protocol so M20 wire frames map to it one-to-one. It is not a wire transport.
 * Deep module over SessionView (01 architecture review): all Branch-derived Session
 * settings (model/name/thinkingLevel), revision gating, and branch-contains checks
 * hide behind SessionView.getView — Driver trusts the View instead of re-folding
 * the Branch. Thin adapter over SessionStore (05/D-001): all session lifecycle
 * durability goes through SessionStore (getBranch/appendEntry/appendCompaction/
 * moveLeaf/countDurableLines); compaction still provides Journal to compactBranch as
 * a policy seam, not a direct driver→journal drift. Provider transport stays
 * behind Provider seam.
 *
 * DriverDefault is the supported composition. It shares one ProgressHub instance between
 * TurnOrchestrator, Compaction, and Driver. Composing those layers with separate ProgressHub
 * instances makes phases and subscriptions disagree. Fork copies entries after it creates the
 * target Session. A later copy failure leaves that target Session in the Journal because the
 * Journal has no compensation API.
 *
 * Settings are Branch-derived via SessionView. The newest model_change, session_name,
 * and thinking_change on the current Branch win independently. Branching to an Entry
 * before a change restores the older value. A Branch command waits behind a running
 * Turn, but expectedRevision can reject a stale queued command via SessionView.
 */

import {
  type CompactionPayload,
  CompactionPayloadSchema,
  type Entry,
  EntryDraftSchema,
  type EntryId,
  EntrySchema,
  Journal,
  JournalDraftRejected,
  JournalError,
  type JournalFailure,
  type SessionId,
  SessionIdSchema,
} from "@popeye/journal";
import type { ProtocolError } from "@popeye/protocol";
import { Context, Effect, Layer, Schema, type Stream } from "effect";

import {
  Compaction,
  type CompactionFailure,
  CompactionLive,
  type CompactionPolicyOptions,
  type CompactionResult,
  compactBranch,
} from "./compaction-policy.js";
import {
  MessageEntryPayloadSchema,
  type MessageToolCall,
  ModelChangePayloadSchema,
  SessionNamePayloadSchema,
  ThinkingChangePayloadSchema,
  ToolResultMessagePayloadSchema,
} from "./entry-payloads.js";
import type { TurnQueueFull } from "./errors.js";
import { Mailbox, type MailboxFailure, MailboxLive, type MailboxOptions } from "./mailbox.js";
import { type InvokeCommandError, PluginHost, PluginHostNone } from "./plugin-host.js";
import { type Progress, ProgressHub, ProgressHubLive, TurnPhaseSchema } from "./progress.js";
import { Provider, type ThinkingLevel, ThinkingLevelSchema } from "./provider.js";
import { makeSessionStoreForTest } from "./session-store.js";
import { deriveSettings as deriveViewSettings, requireRevision } from "./session-view.js";
import {
  type ResumedSessionInfo,
  type SessionInfo,
  type SessionSummary,
  Sessions,
  type SessionsFailure,
  SessionsLive,
  type SessionsOptions,
} from "./sessions.js";
import type { ToolRegistry } from "./tool.js";
import {
  type AbortTurnResult,
  type TurnFailure,
  type TurnOptions,
  TurnOrchestrator,
  TurnOrchestratorLive,
  type TurnResult,
} from "./turn-orchestrator.js";

export const DriverSnapshotSchema = Schema.Struct({
  entries: Schema.Array(EntrySchema),
  leaf: EntrySchema,
  model: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  phase: TurnPhaseSchema,
  revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  sessionId: SessionIdSchema,
  thinkingLevel: Schema.optional(ThinkingLevelSchema),
});

export type DriverSnapshot = Schema.Schema.Type<typeof DriverSnapshotSchema>;

interface DriverSnapshotCore {
  readonly entries: ReadonlyArray<Entry>;
  readonly leaf: Entry;
  readonly model?: string;
  readonly name?: string;
  readonly phase: DriverSnapshot["phase"];
  readonly sessionId: SessionId;
  readonly thinkingLevel?: ThinkingLevel;
}

export interface DriverDefaultOptions {
  readonly compaction?: CompactionPolicyOptions;
  readonly mailbox?: MailboxOptions;
  readonly progressCapacity?: number;
  readonly sessions?: SessionsOptions;
}

export interface DriverService {
  readonly abortTurn: (sessionId: SessionId) => Effect.Effect<AbortTurnResult>;
  readonly branch: (
    sessionId: SessionId,
    toEntryId: EntryId,
    expectedRevision?: number,
  ) => Effect.Effect<DriverSnapshot, JournalFailure | MailboxFailure>;
  readonly compactNow: (
    sessionId: SessionId,
    expectedRevision?: number,
  ) => Effect.Effect<CompactionResult, CompactionFailure>;
  readonly createSession: () => Effect.Effect<SessionInfo, SessionsFailure>;
  readonly fork: (
    sessionId: SessionId,
    fromEntryId: EntryId,
    expectedRevision?: number,
  ) => Effect.Effect<DriverSnapshot, JournalFailure | MailboxFailure>;
  readonly getSnapshot: (
    sessionId: SessionId,
  ) => Effect.Effect<DriverSnapshot, JournalFailure | MailboxFailure>;
  readonly invokeCommand: (
    sessionId: SessionId,
    name: string,
    args: unknown,
    expectedRevision?: number,
  ) => Effect.Effect<unknown, InvokeCommandError | MailboxFailure>;
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
    expectedRevision?: number,
  ) => Effect.Effect<void, JournalFailure | MailboxFailure>;
  readonly setThinkingLevel: (
    sessionId: SessionId,
    thinkingLevel: ThinkingLevel,
    expectedRevision?: number,
  ) => Effect.Effect<void, JournalFailure | MailboxFailure>;
  readonly steer: (
    sessionId: SessionId,
    content: string,
  ) => Effect.Effect<void, ProtocolError | TurnQueueFull>;
  readonly subscribeProgress: (sessionId: SessionId) => Stream.Stream<Progress>;
}

export class Driver extends Context.Tag("@popeye/kernel/Driver")<Driver, DriverService>() {}

const strict: { readonly onExcessProperty: "error" } = { onExcessProperty: "error" };
const decodeCompaction = Schema.decodeUnknown(CompactionPayloadSchema, strict);
const decodeMessage = Schema.decodeUnknown(MessageEntryPayloadSchema, strict);
const decodeModelChange = Schema.decodeUnknown(ModelChangePayloadSchema, strict);
const decodeSessionName = Schema.decodeUnknown(SessionNamePayloadSchema, strict);
const decodeThinkingChange = Schema.decodeUnknown(ThinkingChangePayloadSchema, strict);
const decodeToolResult = Schema.decodeUnknown(ToolResultMessagePayloadSchema, strict);

const entrySchemaMismatch = (entry: Entry, cause: unknown): JournalError =>
  new JournalError({
    cause,
    corruptionClass: "schema_mismatch",
    message: `Entry ${entry.id} payload does not match ${entry.kind}: ${String(cause)}`,
  });

const invalidEntryPayload = (kind: string, cause: unknown): JournalDraftRejected =>
  new JournalDraftRejected({ cause, kind, reason: "invalid_payload" });

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

const unansweredToolCalls = (
  entries: ReadonlyArray<Entry>,
): Effect.Effect<ReadonlyArray<MessageToolCall>, JournalError> =>
  Effect.gen(function* () {
    const newestCompactionIndex = entries.findLastIndex((entry) => entry.kind === "compaction");
    let visibleEntries = entries;
    if (newestCompactionIndex >= 0) {
      const compactionEntry = entries[newestCompactionIndex];
      if (compactionEntry === undefined) {
        return yield* new JournalError({
          corruptionClass: "invalid_compaction",
          message: `Compaction index ${newestCompactionIndex} is outside its Branch.`,
        });
      }
      const payload = yield* decodeCompaction(compactionEntry.payload).pipe(
        Effect.mapError((cause) => entrySchemaMismatch(compactionEntry, cause)),
      );
      const retained = new Set(payload.retainedTailIds);
      visibleEntries = [
        ...entries.slice(0, newestCompactionIndex).filter((entry) => retained.has(entry.id)),
        ...entries.slice(newestCompactionIndex + 1),
      ];
    }
    const pending = new Map<string, MessageToolCall>();
    for (const entry of visibleEntries) {
      if (entry.kind !== "message") {
        continue;
      }
      const payload = yield* decodeMessage(entry.payload).pipe(
        Effect.mapError((cause) => entrySchemaMismatch(entry, cause)),
      );
      if (payload.role === "assistant") {
        for (const call of payload.toolCalls ?? []) {
          pending.set(call.id, call);
        }
      }
      if (payload.role === "toolResult") {
        pending.delete(payload.toolCallId);
      }
    }
    return [...pending.values()];
  });

const makeSnapshot = (core: DriverSnapshotCore, revision: number): DriverSnapshot =>
  DriverSnapshotSchema.make({ ...core, entries: [...core.entries], revision });

export const DriverLive: Layer.Layer<
  Driver,
  never,
  Compaction | Journal | Mailbox | PluginHost | ProgressHub | Provider | Sessions | TurnOrchestrator
> = Layer.effect(
  Driver,
  Effect.gen(function* () {
    const compaction = yield* Compaction;
    const journal = yield* Journal;
    const store = makeSessionStoreForTest(journal);
    const mailbox = yield* Mailbox;
    const pluginHost = yield* PluginHost;
    const progress = yield* ProgressHub;
    const provider = yield* Provider;
    const sessions = yield* Sessions;
    const orchestrator = yield* TurnOrchestrator;

    const readSnapshotCore = (
      sessionId: SessionId,
    ): Effect.Effect<DriverSnapshotCore, JournalFailure> =>
      Effect.gen(function* () {
        const entries = yield* store.getBranch(sessionId);
        const leaf = entries.at(-1);
        if (leaf === undefined) {
          return yield* new JournalError({
            corruptionClass: "dangling_leaf_reference",
            message: `Session ${sessionId} has no current Branch.`,
          });
        }
        const phase = yield* progress.currentPhase(sessionId);
        const settings = yield* deriveViewSettings(entries);
        return {
          entries,
          leaf,
          ...(settings.model === undefined ? {} : { model: settings.model }),
          ...(settings.name === undefined ? {} : { name: settings.name }),
          phase,
          sessionId,
          ...(settings.thinkingLevel === undefined
            ? {}
            : { thinkingLevel: settings.thinkingLevel }),
        };
      });

    const readSnapshot = (
      sessionId: SessionId,
    ): Effect.Effect<DriverSnapshot, JournalFailure | MailboxFailure> =>
      mailbox
        .enqueue(sessionId, {
          name: "read-snapshot",
          run: () => readSnapshotCore(sessionId),
        })
        .pipe(Effect.map((result) => makeSnapshot(result.value, result.revision)));

    const forkBranch = (
      sessionId: SessionId,
      fromEntryId: EntryId,
    ): Effect.Effect<DriverSnapshot, JournalFailure | MailboxFailure> =>
      Effect.gen(function* () {
        const source = yield* store.getBranch(sessionId);
        const branchPoint = source.findIndex((entry) => entry.id === fromEntryId);
        if (branchPoint < 0) {
          return yield* new JournalError({
            corruptionClass: "dangling_leaf_reference",
            message: `Fork Entry ${fromEntryId} is not on the current Branch.`,
          });
        }
        const created = yield* sessions.create();
        const sourceRoot = source[0];
        if (sourceRoot === undefined) {
          return yield* new JournalError({
            corruptionClass: "dangling_leaf_reference",
            message: `Fork Session ${sessionId} has no root Entry.`,
          });
        }
        const ids = new Map<EntryId, EntryId>([[sourceRoot.id, created.leaf.id]]);
        for (const entry of source.slice(1, branchPoint + 1)) {
          const appended =
            entry.kind === "compaction"
              ? yield* decodeCompaction(entry.payload).pipe(
                  Effect.mapError((cause) => entrySchemaMismatch(entry, cause)),
                  Effect.flatMap((payload) => remapCompaction(ids, payload)),
                  Effect.flatMap((payload) => store.appendCompaction(created.id, payload)),
                )
              : yield* store.appendEntry(
                  created.id,
                  EntryDraftSchema.make({ kind: entry.kind, payload: entry.payload }),
                );
          ids.set(entry.id, appended.id);
        }
        const copied = yield* store.getBranch(created.id);
        const unanswered = yield* unansweredToolCalls(copied);
        for (const call of unanswered) {
          const payload = yield* decodeToolResult({
            content: "Tool execution interrupted by fork.",
            isError: true,
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
          }).pipe(Effect.mapError((cause) => invalidEntryPayload("message", cause)));
          yield* store.appendEntry(created.id, EntryDraftSchema.make({ kind: "message", payload }));
        }
        const core = yield* readSnapshotCore(created.id);
        const revision = yield* store.countDurableLines(created.id);
        return makeSnapshot(core, revision);
      });

    const updateModel = (
      sessionId: SessionId,
      model: string,
      expectedRevision: number | undefined,
    ): Effect.Effect<void, JournalFailure | MailboxFailure> =>
      mailbox
        .enqueue(sessionId, {
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
          name: "set-model",
          run: () =>
            decodeModelChange({ model }).pipe(
              Effect.mapError((cause) => invalidEntryPayload("model_change", cause)),
              Effect.flatMap((payload) =>
                store.appendEntry(
                  sessionId,
                  EntryDraftSchema.make({ kind: "model_change", payload }),
                ),
              ),
            ),
        })
        .pipe(Effect.asVoid);

    const updateThinkingLevel = (
      sessionId: SessionId,
      thinkingLevel: ThinkingLevel,
      expectedRevision: number | undefined,
    ): Effect.Effect<void, JournalFailure | MailboxFailure> =>
      mailbox
        .enqueue(sessionId, {
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
          name: "set-thinking-level",
          run: () =>
            decodeThinkingChange({ thinkingLevel }).pipe(
              Effect.mapError((cause) => invalidEntryPayload("thinking_change", cause)),
              Effect.flatMap((payload) =>
                store.appendEntry(
                  sessionId,
                  EntryDraftSchema.make({ kind: "thinking_change", payload }),
                ),
              ),
            ),
        })
        .pipe(Effect.asVoid);

    const appendSessionName = (
      sessionId: SessionId,
      name: string,
    ): Effect.Effect<void, JournalFailure> =>
      decodeSessionName({ name }).pipe(
        Effect.mapError((cause) => invalidEntryPayload("session_name", cause)),
        Effect.flatMap((payload) =>
          store.appendEntry(sessionId, EntryDraftSchema.make({ kind: "session_name", payload })),
        ),
        Effect.asVoid,
      );

    return {
      abortTurn: (sessionId) => orchestrator.abortTurn(sessionId),
      branch: (sessionId, toEntryId, expectedRevision) =>
        mailbox
          .enqueue(sessionId, {
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
            name: "branch",
            run: () =>
              store
                .moveLeaf(sessionId, toEntryId as unknown as string)
                .pipe(Effect.zipRight(readSnapshotCore(sessionId))),
          })
          .pipe(Effect.map((result) => makeSnapshot(result.value, result.revision))),
      compactNow: (sessionId, expectedRevision) =>
        compaction.compactNow(sessionId, expectedRevision),
      createSession: () => sessions.create(),
      fork: (sessionId, fromEntryId, expectedRevision) =>
        mailbox
          .enqueue(sessionId, {
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
            name: "fork",
            run: () => forkBranch(sessionId, fromEntryId),
          })
          .pipe(Effect.map((result) => result.value)),
      getSnapshot: readSnapshot,
      invokeCommand: (sessionId, name, args, expectedRevision) =>
        mailbox
          .enqueue(sessionId, {
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
            name: "invoke-command",
            run: (revision) =>
              pluginHost.invokeCommand(name, args, {
                compactNow: (commandExpectedRevision) =>
                  requireRevision(commandExpectedRevision, revision).pipe(
                    Effect.zipRight(
                      compactBranch({
                        journal,
                        options: compaction.policy,
                        progress,
                        provider,
                        sessionId,
                        turnOrdinal: 0,
                      }),
                    ),
                  ),
                sessionId,
                setSessionName: (sessionName, commandExpectedRevision) =>
                  requireRevision(commandExpectedRevision, revision).pipe(
                    Effect.zipRight(appendSessionName(sessionId, sessionName)),
                  ),
              }),
          })
          .pipe(Effect.map((result) => result.value)),
      listSessions: () => sessions.list(),
      prompt: (sessionId, content, options = {}) =>
        orchestrator.openTurn(sessionId, content, undefined, options, (turnOptions) =>
          Effect.gen(function* () {
            const entries = yield* store
              .getBranch(sessionId)
              .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<Entry>)));
            const settings = yield* deriveViewSettings(entries).pipe(
              Effect.catchAll(() =>
                Effect.succeed({} as import("./session-view.js").SessionSettings),
              ),
            );
            return {
              ...turnOptions,
              ...(settings.model === undefined ? {} : { model: settings.model }),
              ...(settings.thinkingLevel === undefined
                ? {}
                : { thinkingLevel: settings.thinkingLevel }),
            };
          }),
        ),
      resumeSession: (sessionId) =>
        sessions.resume(sessionId).pipe(Effect.tap(() => readSnapshot(sessionId))),
      setModel: updateModel,
      setThinkingLevel: updateThinkingLevel,
      steer: (sessionId, content) => orchestrator.steer(sessionId, content),
      subscribeProgress: (sessionId) => progress.subscribe(sessionId),
    } satisfies DriverService;
  }),
);

export const DriverDefault = (
  options: DriverDefaultOptions = {},
  pluginHost: Layer.Layer<PluginHost> = PluginHostNone,
): Layer.Layer<Driver, never, Journal | Provider | ToolRegistry> => {
  const mailbox = MailboxLive(options.mailbox);
  const progress = ProgressHubLive(options.progressCapacity);
  const shared = Layer.merge(mailbox, progress);
  const compaction = CompactionLive(options.compaction).pipe(Layer.provide(shared));
  const kernel = Layer.mergeAll(shared, compaction);
  const sessions = SessionsLive(options.sessions).pipe(Layer.provide(kernel));
  const turns = TurnOrchestratorLive().pipe(Layer.provide(Layer.merge(kernel, pluginHost)));
  const dependencies = Layer.mergeAll(kernel, pluginHost, sessions, turns);
  return DriverLive.pipe(Layer.provide(dependencies));
};
