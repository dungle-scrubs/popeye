/**
 * Owns mailbox-serialized turn execution from Context assembly through settlement.
 * It exists so per-Session view pinning, per-request tool declarations, tool-batch
 * via Tool seam, steering/follow-up queueing, and compaction no-tools are hidden
 * behind one deep interface openTurn(sessionId, prompt, leasedGeneration).
 *
 * Why this module: turn.ts was a God Module; callers should depend on a small
 * Turn handle. This module hides retry/batch/compaction/steering.
 * Deep module over TurnDurability (C2 architecture review): turn-scoped Journal durability
 * (operation records, assistant/toolResult/steering entries, deduplication, revision counting)
 * hides behind TurnDurability's handle; this module retains coordination (Context → Provider →
 * Tool batch → steering decision) and delegates writes to durability. TurnDurability is its
 * private seam, not a public dependency — callers depend on TurnOrchestrator, not on durability.
 * Not responsible for Journal folding (journal owns that) or generation lifetime
 * (GenerationRuntime owns that). Provider transport stays behind Provider seam.
 */

import {
  EntryDraftSchema,
  foldContext,
  Journal,
  type JournalFailure,
  type SessionId,
} from "@pop-eye/journal";
import { ProtocolError } from "@pop-eye/protocol";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberId,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
} from "effect";
import {
  Compaction,
  type CompactionPolicyOptions,
  CompactionPolicyOptionsSchema,
  compactBranch,
  entryToContextItem,
  resolveCompactionPolicyOptions,
} from "./compaction-policy.js";
import type { AssistantDiagnostic } from "./entry-payloads.js";
import { BudgetExceeded, type ProviderError, TurnQueueFull } from "./errors.js";
import { Mailbox, type MailboxFailure } from "./mailbox.js";
import { PluginHost } from "./plugin-host.js";
import { type Progress, ProgressHub, type TurnPhase } from "./progress.js";
import {
  type AssistantStopReason,
  AssistantStopReasonSchema,
  type ContextItem,
  Provider,
  ThinkingLevelSchema,
} from "./provider.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_PROVIDER_ROUNDS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  makeProviderRequestRuntime,
} from "./provider-retry.js";
import { ToolRegistry } from "./tool.js";
import { executeToolBatch, type ToolBatchResult, type ToolCall } from "./tool-batch.js";
import { makeTurnDurabilityHandle } from "./turn-durability.js";

export const TurnOptionsSchema = Schema.Struct({
  abortGraceMs: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  compaction: Schema.optional(CompactionPolicyOptionsSchema),
  contextBudget: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
  deliveryMode: Schema.optional(Schema.Literal("followUp", "steer")),
  expectedRevision: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
  maxAttempts: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  maxProviderRounds: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  /** @deprecated Use maxProviderRounds. */
  maxToolRounds: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  model: Schema.optional(Schema.NonEmptyString),
  retryBaseDelayMs: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
  thinkingLevel: Schema.optional(ThinkingLevelSchema),
  toolConcurrency: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
});

export type TurnOptions = Schema.Schema.Type<typeof TurnOptionsSchema>;

export const TurnResultSchema = Schema.Struct({
  stopReason: AssistantStopReasonSchema,
});

export type TurnResult = Schema.Schema.Type<typeof TurnResultSchema>;

export const AbortTurnResultSchema = Schema.Union(
  Schema.Struct({
    aborted: Schema.Literal(false),
    reason: Schema.Literal("none", "settling"),
    turnOrdinal: Schema.UndefinedOr(Schema.Number.pipe(Schema.int(), Schema.positive())),
  }),
  Schema.Struct({
    aborted: Schema.Literal(true),
    turnOrdinal: Schema.Number.pipe(Schema.int(), Schema.positive()),
  }),
  Schema.Struct({
    aborted: Schema.Literal(true),
    note: Schema.Literal("loop-prevented"),
    turnOrdinal: Schema.Number.pipe(Schema.int(), Schema.positive()),
  }),
);

export type AbortTurnResult = Schema.Schema.Type<typeof AbortTurnResultSchema>;

export type TurnFailure = JournalFailure | MailboxFailure | ProtocolError | TurnQueueFull;

export type TurnOptionsResolver = (
  options: TurnOptions,
) => Effect.Effect<TurnOptions, JournalFailure>;

export interface TurnOrchestratorService {
  readonly abortTurn: (sessionId: SessionId) => Effect.Effect<AbortTurnResult>;
  readonly openTurn: (
    sessionId: SessionId,
    content: string,
    leasedGeneration?: unknown,
    options?: TurnOptions,
    resolveOptions?: TurnOptionsResolver,
  ) => Effect.Effect<TurnResult, TurnFailure>;
  readonly steer: (
    sessionId: SessionId,
    content: string,
  ) => Effect.Effect<void, ProtocolError | TurnQueueFull>;
  readonly subscribeProgress: (sessionId: SessionId) => Stream.Stream<Progress>;
}

export class TurnOrchestrator extends Context.Tag("@pop-eye/kernel/TurnOrchestrator")<
  TurnOrchestrator,
  TurnOrchestratorService
>() {}

interface ActiveTurn {
  readonly abortGraceMs: number;
  readonly completion: Deferred.Deferred<
    Exit.Exit<TurnResult, BudgetExceeded | JournalFailure | ProviderError>
  >;
  readonly fiber: Fiber.Fiber<TurnResult, BudgetExceeded | JournalFailure | ProviderError>;
  readonly forceAbort: Effect.Effect<void>;
  readonly stage: Ref.Ref<TurnStage>;
  readonly steering: Ref.Ref<SteeringState>;
  readonly steeringMutex: Effect.Semaphore;
  readonly turnOrdinal: number;
}

type TurnStage = "finishing" | "running" | "settling" | "settling-aborted";

interface SteeringItem {
  readonly content: string;
  readonly options: TurnOptions;
  readonly resolveOptions: TurnOptionsResolver;
}

interface SteeringState {
  readonly accepting: boolean;
  readonly items: ReadonlyArray<SteeringItem>;
}

type OfferSteeringResult = { readonly _tag: "closed" } | { readonly _tag: "queued" };

type OfferSteeringCommit = OfferSteeringResult | { readonly _tag: "full" };

type SettlementSteeringDecision =
  | { readonly _tag: "convert"; readonly items: ReadonlyArray<SteeringItem> }
  | { readonly _tag: "discard" }
  | { readonly _tag: "finish" }
  | { readonly _tag: "loop"; readonly items: ReadonlyArray<SteeringItem> };

type SettlementSteeringMode = "convert" | "discard" | "loop";

interface FollowUpItem {
  readonly content: string;
}

interface TurnRegistration {
  readonly token: symbol;
}

const DEFAULT_CONTEXT_BUDGET = 32_000;
const DEFAULT_ABORT_GRACE_MS = 5_000;

export { DEFAULT_RETRY_BASE_DELAY_MS };

/** Maximum steering or follow-up items retained per session. Excess input fails typed. */
export const TURN_INPUT_QUEUE_CAPACITY = 64;

interface BufferedToolCall extends ToolCall {
  readonly index?: number;
}

interface ToolAbortState {
  readonly completed: ReadonlyMap<string, ToolBatchResult>;
  readonly finalized: boolean;
}

const validatePositiveInteger = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
};

const validateTurnOptions = (
  options: TurnOptions,
  compactionPolicy: CompactionPolicyOptions,
): void => {
  if (options.abortGraceMs !== undefined) {
    validatePositiveInteger("Abort grace milliseconds", options.abortGraceMs);
  }
  if (options.maxAttempts !== undefined) {
    validatePositiveInteger("Maximum attempts", options.maxAttempts);
  }
  if (options.maxProviderRounds !== undefined) {
    validatePositiveInteger("Maximum provider rounds", options.maxProviderRounds);
  }
  if (options.maxToolRounds !== undefined) {
    validatePositiveInteger("Maximum tool rounds", options.maxToolRounds);
  }
  if (options.toolConcurrency !== undefined) {
    validatePositiveInteger("Tool concurrency", options.toolConcurrency);
  }
  resolveCompactionPolicyOptions(compactionPolicy, options.compaction);
};

const providerRoundBound = (options: TurnOptions): number =>
  options.maxProviderRounds ?? options.maxToolRounds ?? DEFAULT_MAX_PROVIDER_ROUNDS;

const withoutExpectedRevision = (options: TurnOptions): TurnOptions => {
  const next = { ...options };
  delete next.expectedRevision;
  return next;
};

const keepTurnOptions: TurnOptionsResolver = (options) => Effect.succeed(options);

const phaseChanged = (progress: ProgressHub["Type"], sessionId: SessionId, phase: TurnPhase) =>
  progress.publish(sessionId, { _tag: "phaseChanged", phase });

const causeDetail = (cause: Cause.Cause<unknown>): string => Cause.pretty(cause);

const journalFailureDetail = (failure: JournalFailure, cause: Cause.Cause<unknown>): string =>
  "message" in failure && typeof failure.message === "string"
    ? failure.message
    : causeDetail(cause);

export const validateTurnOptionsSync = (
  options: TurnOptions,
  compactionPolicy: CompactionPolicyOptions,
): void => validateTurnOptions(options, compactionPolicy);

export const TurnOrchestratorLive = (): Layer.Layer<
  TurnOrchestrator,
  never,
  Compaction | Journal | Mailbox | PluginHost | ProgressHub | Provider | ToolRegistry
> =>
  Layer.effect(
    TurnOrchestrator,
    Effect.gen(function* () {
      const compaction = yield* Compaction;
      const journal = yield* Journal;
      const mailbox = yield* Mailbox;
      const pluginHost = yield* PluginHost;
      const progress = yield* ProgressHub;
      const provider = yield* Provider;
      const toolRegistry = yield* ToolRegistry;
      const active = yield* Ref.make<Map<SessionId, ActiveTurn>>(new Map());
      const followUps = yield* Ref.make<Map<SessionId, ReadonlyArray<FollowUpItem>>>(new Map());
      const turnRegistrations = yield* Ref.make<Map<SessionId, ReadonlyArray<TurnRegistration>>>(
        new Map(),
      );

      const offerTurnRegistration = (
        sessionId: SessionId,
      ): Effect.Effect<
        { readonly queued: boolean; readonly registration: TurnRegistration },
        TurnQueueFull
      > =>
        Ref.modify(turnRegistrations, (current) => {
          const registrations = current.get(sessionId) ?? [];
          if (registrations.length > TURN_INPUT_QUEUE_CAPACITY) {
            return [undefined, current];
          }
          const registration: TurnRegistration = { token: Symbol("turn-registration") };
          const next = new Map(current);
          next.set(sessionId, [...registrations, registration]);
          return [{ queued: registrations.length > 0, registration }, next];
        }).pipe(
          Effect.flatMap((result) =>
            result === undefined
              ? Effect.fail(
                  new TurnQueueFull({
                    capacity: TURN_INPUT_QUEUE_CAPACITY,
                    queue: "followUp",
                    sessionId,
                  }),
                )
              : Effect.succeed(result),
          ),
        );

      const removeTurnRegistration = (
        sessionId: SessionId,
        registration: TurnRegistration,
      ): Effect.Effect<void> =>
        Ref.update(turnRegistrations, (current) => {
          const registrations = current.get(sessionId);
          if (registrations === undefined) {
            return current;
          }
          const next = new Map(current);
          const remaining = registrations.filter((item) => item !== registration);
          if (remaining.length === 0) {
            next.delete(sessionId);
          } else {
            next.set(sessionId, remaining);
          }
          return next;
        });

      const offerFollowUp = (
        sessionId: SessionId,
        content: string,
      ): Effect.Effect<FollowUpItem, TurnQueueFull> =>
        Ref.modify(followUps, (current) => {
          const items = current.get(sessionId) ?? [];
          if (items.length >= TURN_INPUT_QUEUE_CAPACITY) {
            return [undefined, current];
          }
          const item: FollowUpItem = { content };
          const next = new Map(current);
          next.set(sessionId, [...items, item]);
          return [item, next];
        }).pipe(
          Effect.flatMap((item) =>
            item === undefined
              ? Effect.fail(
                  new TurnQueueFull({
                    capacity: TURN_INPUT_QUEUE_CAPACITY,
                    queue: "followUp",
                    sessionId,
                  }),
                )
              : Effect.succeed(item),
          ),
        );

      const removeFollowUp = (sessionId: SessionId, item: FollowUpItem): Effect.Effect<void> =>
        Ref.update(followUps, (current) => {
          const items = current.get(sessionId);
          if (items === undefined) {
            return current;
          }
          const next = new Map(current);
          const remaining = items.filter((candidate) => candidate !== item);
          if (remaining.length === 0) {
            next.delete(sessionId);
          } else {
            next.set(sessionId, remaining);
          }
          return next;
        });

      const offerSteering = (
        turn: ActiveTurn,
        sessionId: SessionId,
        content: string,
        options: TurnOptions,
        resolveOptions: TurnOptionsResolver,
      ): Effect.Effect<OfferSteeringResult, TurnQueueFull> =>
        turn.steeringMutex.withPermits(1)(
          Ref.modify<SteeringState, OfferSteeringCommit>(turn.steering, (current) => {
            if (!current.accepting) {
              return [{ _tag: "closed" }, current];
            }
            if (current.items.length >= TURN_INPUT_QUEUE_CAPACITY) {
              return [{ _tag: "full" }, current];
            }
            const item: SteeringItem = { content, options, resolveOptions };
            return [{ _tag: "queued" }, { ...current, items: [...current.items, item] }];
          }).pipe(
            Effect.flatMap((result): Effect.Effect<OfferSteeringResult, TurnQueueFull> => {
              if (result._tag === "full") {
                return Effect.fail(
                  new TurnQueueFull({
                    capacity: TURN_INPUT_QUEUE_CAPACITY,
                    queue: "steering",
                    sessionId,
                  }),
                );
              }
              return result._tag === "queued"
                ? progress
                    .publish(sessionId, { _tag: "steeringQueued", content })
                    .pipe(Effect.as<OfferSteeringResult>(result))
                : Effect.succeed<OfferSteeringResult>(result);
            }),
          ),
        );

      const awaitTurn = (turn: ActiveTurn): Effect.Effect<TurnResult, JournalFailure> =>
        Deferred.await(turn.completion).pipe(
          Effect.flatMap((exit) =>
            Exit.matchEffect(exit, {
              onFailure: Effect.failCause,
              onSuccess: Effect.succeed,
            }),
          ),
          Effect.catchTag("BudgetExceeded", () =>
            Effect.succeed<TurnResult>({ stopReason: "error" }),
          ),
          Effect.catchTag("ProviderError", () =>
            Effect.succeed<TurnResult>({ stopReason: "error" }),
          ),
          Effect.catchAllCause((cause) =>
            Cause.isInterruptedOnly(cause)
              ? Effect.succeed<TurnResult>({ stopReason: "aborted" })
              : Effect.failCause(cause),
          ),
        );

      const execute = (
        sessionId: SessionId,
        content: string,
        options: TurnOptions,
        leasedGeneration: unknown,
        registration: TurnRegistration | undefined,
      ): Effect.Effect<TurnResult, BudgetExceeded | JournalFailure | ProviderError> =>
        Effect.gen(function* () {
          const priorBranch = yield* journal.readBranch(sessionId);
          const turnOrdinal =
            priorBranch.filter((entry) => {
              const item = entryToContextItem(entry);
              if (item?.role !== "user") {
                return false;
              }
              const payload = entry.payload as { readonly deliveryMode?: unknown };
              return payload.deliveryMode !== "steer";
            }).length + 1;
          const abortSettleFailure = yield* Ref.make<Cause.Cause<JournalFailure> | undefined>(
            undefined,
          );
          const durability = yield* makeTurnDurabilityHandle({
            journal,
            progress,
            sessionId,
            turnOrdinal,
          });
          const abortState = yield* Ref.make<ToolAbortState>({
            completed: new Map(),
            finalized: false,
          });
          const stage = yield* Ref.make<TurnStage>("running");
          const steering = yield* Ref.make<SteeringState>({ accepting: true, items: [] });
          const steeringDrainedCount = yield* Ref.make(0);
          const steeringMutex = yield* Effect.makeSemaphore(1);
          const stopReason = yield* Ref.make<AssistantStopReason>("done");
          const terminalDiagnostic = yield* Ref.make<AssistantDiagnostic | undefined>(undefined);
          const text = yield* Ref.make("");
          const toolCalls = yield* Ref.make<ReadonlyArray<BufferedToolCall>>([]);
          const executingCalls = yield* Ref.make<ReadonlyArray<ToolCall> | undefined>(undefined);
          const compactionAttempted = yield* Ref.make(false);
          const providerRuntime = yield* makeProviderRequestRuntime({
            ...(options.retryBaseDelayMs === undefined
              ? {}
              : { baseDelayMs: options.retryBaseDelayMs }),
            maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
            maxProviderRounds: providerRoundBound(options),
            onRetry: (attempt, delayMs) =>
              progress.publish(sessionId, {
                _tag: "providerRetryScheduled",
                attempt,
                delayMs,
              }),
          });
          const generationId =
            typeof leasedGeneration === "string"
              ? leasedGeneration
              : leasedGeneration !== null &&
                  typeof leasedGeneration === "object" &&
                  "generationId" in (leasedGeneration as Record<string, unknown>) &&
                  typeof (leasedGeneration as Record<string, unknown>).generationId === "string"
                ? ((leasedGeneration as Record<string, unknown>).generationId as string)
                : leasedGeneration !== null &&
                    typeof leasedGeneration === "object" &&
                    "id" in (leasedGeneration as Record<string, unknown>) &&
                    typeof (leasedGeneration as Record<string, unknown>).id === "string"
                  ? ((leasedGeneration as Record<string, unknown>).id as string)
                  : sessionId;
          // D-005: pin the Session view at Turn open; every provider request in this Turn uses it.
          const sessionView = yield* toolRegistry.view(sessionId);
          const sessionTools = sessionView.list();
          yield* Effect.annotateCurrentSpan({
            generationId,
            toolCount: sessionTools.length,
          });

          const takeSteering = (
            closeWhenEmpty: boolean,
          ): Effect.Effect<ReadonlyArray<SteeringItem>> =>
            steeringMutex.withPermits(1)(
              Ref.modify(steering, (current) => [
                current.items,
                {
                  accepting:
                    closeWhenEmpty && current.items.length === 0 ? false : current.accepting,
                  items: [],
                },
              ]),
            );

          const decideSettlementSteering = (
            mode: SettlementSteeringMode,
          ): Effect.Effect<SettlementSteeringDecision> =>
            steeringMutex.withPermits(1)(
              Effect.gen(function* () {
                const current = yield* Ref.get(steering);
                const decision = yield* Ref.modify<TurnStage, SettlementSteeringDecision>(
                  stage,
                  (currentStage) => {
                    if (currentStage === "settling-aborted") {
                      return [{ _tag: "discard" } as const, "finishing" as const];
                    }
                    if (mode === "loop" && current.items.length > 0) {
                      return [{ _tag: "loop", items: current.items } as const, "running" as const];
                    }
                    if (mode === "convert" && current.items.length > 0) {
                      return [
                        { _tag: "convert", items: current.items } as const,
                        "finishing" as const,
                      ];
                    }
                    return [
                      { _tag: mode === "discard" ? "discard" : "finish" } as const,
                      "finishing" as const,
                    ];
                  },
                );
                yield* Ref.set(steering, {
                  accepting: decision._tag === "loop",
                  items: [],
                });
                return decision;
              }),
            );

          const applySteering = (
            items: ReadonlyArray<SteeringItem>,
          ): Effect.Effect<void, JournalFailure> =>
            durability
              .appendSteering(items.map((i) => ({ content: i.content })))
              .pipe(
                Effect.zipRight(Ref.update(steeringDrainedCount, (count) => count + items.length)),
              );

          const queueConvertedSteering = (
            items: ReadonlyArray<SteeringItem>,
          ): Effect.Effect<void> =>
            Effect.gen(function* () {
              const queued = items.map((item) => ({
                followUp: { content: item.content } satisfies FollowUpItem,
                options: withoutExpectedRevision(item.options),
                resolveOptions: item.resolveOptions,
              }));
              yield* Ref.update(followUps, (current) => {
                const next = new Map(current);
                next.set(sessionId, [
                  ...(current.get(sessionId) ?? []),
                  ...queued.map((item) => item.followUp),
                ]);
                return next;
              });
              yield* Effect.forEach(queued, (item) =>
                progress.publish(sessionId, {
                  _tag: "followUpQueued",
                  content: item.followUp.content,
                }),
              );
              yield* Effect.forkDaemon(
                Effect.forEach(
                  queued,
                  (item) =>
                    Effect.gen(function* () {
                      const accepted = yield* Deferred.make<void>();
                      yield* Effect.forkDaemon(
                        enqueueTurn(
                          sessionId,
                          item.followUp.content,
                          item.options,
                          item.followUp,
                          undefined,
                          leasedGeneration,
                          Deferred.succeed(accepted, undefined).pipe(Effect.asVoid),
                          item.resolveOptions,
                        ).pipe(
                          Effect.ensuring(Deferred.succeed(accepted, undefined)),
                          Effect.asVoid,
                        ),
                      );
                      yield* Deferred.await(accepted);
                    }),
                  { concurrency: 1 },
                ).pipe(Effect.asVoid),
              );
            });

          const finishSettlement = (reason: AssistantStopReason): Effect.Effect<void> =>
            Effect.gen(function* () {
              yield* Ref.get(steeringDrainedCount).pipe(
                Effect.flatMap((count) =>
                  Effect.annotateCurrentSpan({ steeringDrainedCount: count }),
                ),
              );
              const revision = yield* journal
                .countDurableLines(sessionId)
                .pipe(Effect.catchAll(() => Effect.succeed(0)));
              yield* progress.publish(sessionId, {
                _tag: "turnSettled",
                revision,
                stopReason: reason,
              });
              yield* phaseChanged(progress, sessionId, "IDLE");
            });

          const settle = (
            reason: AssistantStopReason,
            diagnostic: AssistantDiagnostic | undefined,
            contentOverride: string | undefined = undefined,
            appendAssistant = true,
            steeringMode: SettlementSteeringMode = reason === "error" ? "convert" : "discard",
          ): Effect.Effect<boolean, JournalFailure> =>
            Effect.uninterruptible(
              Effect.gen(function* () {
                yield* Ref.set(stage, "settling");
                yield* phaseChanged(progress, sessionId, "SETTLING");
                const assistantContent = contentOverride ?? (yield* Ref.get(text));
                if (appendAssistant) {
                  const assistant = yield* durability.appendAssistant(
                    assistantContent,
                    reason,
                    diagnostic,
                  );
                  yield* Effect.annotateCurrentSpan({
                    assistantEntryId: assistant.id,
                    stopReason: reason,
                  });
                }
                const steeringDecision = yield* decideSettlementSteering(steeringMode);
                if (steeringDecision._tag === "loop") {
                  yield* applySteering(steeringDecision.items);
                  return true;
                }
                if (steeringDecision._tag === "convert") {
                  yield* queueConvertedSteering(steeringDecision.items);
                }
                yield* durability.finishOperation(reason);
                yield* finishSettlement(reason);
                return false;
              }).pipe(Effect.onError(() => finishSettlement(reason))),
            );

          const appendToolResult = (
            result: ToolBatchResult,
            toolName: string,
          ): Effect.Effect<boolean, JournalFailure> =>
            durability.appendToolResult(result, toolName);

          const finalizeExecutingToolResults = (): Effect.Effect<boolean, JournalFailure> =>
            Ref.modify(abortState, (current) => [
              current.finalized ? undefined : current.completed,
              { ...current, finalized: true },
            ]).pipe(
              Effect.flatMap((completed) =>
                completed !== undefined
                  ? Effect.gen(function* () {
                      const calls = yield* Ref.get(executingCalls);
                      if (calls !== undefined) {
                        yield* Effect.forEach(
                          calls,
                          (call) => {
                            const completedResult = completed.get(call.id);
                            const result =
                              completedResult ??
                              ({
                                content: "Tool execution interrupted.",
                                isError: true,
                                toolCallId: call.id,
                              } satisfies ToolBatchResult);
                            return appendToolResult(result, call.name).pipe(
                              Effect.flatMap((appended) =>
                                appended && completedResult === undefined
                                  ? progress.publish(sessionId, {
                                      _tag: "toolCompleted",
                                      isError: true,
                                      toolCallId: call.id,
                                    })
                                  : Effect.void,
                              ),
                            );
                          },
                          { concurrency: 1 },
                        );
                        yield* Effect.annotateCurrentSpan({ interrupted: true });
                        return true;
                      }
                      return false;
                    })
                  : Effect.succeed(false),
              ),
            );

          const settleAbort = (): Effect.Effect<void> =>
            finalizeExecutingToolResults().pipe(
              Effect.flatMap((hadExecutingCalls) =>
                settle("aborted", undefined, hadExecutingCalls ? "" : undefined, true, "discard"),
              ),
              Effect.uninterruptible,
              Effect.exit,
              Effect.flatMap((exit) =>
                Exit.isFailure(exit) ? Ref.set(abortSettleFailure, exit.cause) : Effect.void,
              ),
            );

          const resetProviderBuffers = (): Effect.Effect<void> =>
            Effect.all(
              [
                Ref.set(executingCalls, undefined),
                Ref.set(stopReason, "done"),
                Ref.set(terminalDiagnostic, undefined),
                Ref.set(text, ""),
                Ref.set(toolCalls, []),
              ],
              { discard: true },
            );

          const consume = (
            context: ReadonlyArray<ContextItem>,
          ): Effect.Effect<void, ProviderError> =>
            providerRuntime.run(
              (attempt) =>
                Effect.gen(function* () {
                  yield* resetProviderBuffers();
                  const attemptProgress = yield* Ref.make<ReadonlyArray<Progress>>([]);
                  yield* Effect.annotateCurrentSpan({ attempt });
                  yield* Stream.runForEach(
                    provider.streamAssistant(context, {
                      attempt,
                      ...(options.model === undefined ? {} : { model: options.model }),
                      purpose: "turn",
                      ...(options.thinkingLevel === undefined
                        ? {}
                        : { thinkingLevel: options.thinkingLevel }),
                      tools: sessionTools,
                      turnOrdinal,
                    }),
                    (item) => {
                      if (item._tag === "textDelta") {
                        const next: Progress = { _tag: "assistantText", text: item.text };
                        return Ref.update(text, (current) => current + item.text).pipe(
                          Effect.zipRight(
                            Ref.update(attemptProgress, (current) => [...current, next]),
                          ),
                        );
                      }
                      if (item._tag === "thinkingDelta") {
                        const next: Progress = { _tag: "assistantThinking", text: item.text };
                        return Ref.update(attemptProgress, (current) => [...current, next]);
                      }
                      if (item._tag === "toolCall") {
                        return Ref.update(toolCalls, (current) => {
                          const priorIndex = current.findIndex((call) => call.id === item.id);
                          const next: BufferedToolCall = {
                            argumentsJson: item.argumentsJson,
                            id: item.id,
                            name: item.name,
                          };
                          return priorIndex < 0
                            ? [...current, next]
                            : current.map((call, index) => (index === priorIndex ? next : call));
                        });
                      }
                      if (item._tag === "toolCallDelta") {
                        return Ref.update(toolCalls, (current) => {
                          const priorIndex = current.findIndex(
                            (call) =>
                              call.id === item.id ||
                              (item.index !== undefined && call.index === item.index),
                          );
                          const prior = current[priorIndex];
                          const next: BufferedToolCall = {
                            argumentsJson: (prior?.argumentsJson ?? "") + item.argumentsJsonDelta,
                            id: item.id,
                            name: item.name ?? prior?.name ?? "",
                            ...(item.index === undefined ? {} : { index: item.index }),
                          };
                          return priorIndex < 0
                            ? [...current, next]
                            : current.map((call, index) => (index === priorIndex ? next : call));
                        });
                      }
                      return Ref.set(stopReason, item.stopReason);
                    },
                  );
                  const buffered = yield* Ref.get(attemptProgress);
                  yield* Effect.forEach(buffered, (item) => progress.publish(sessionId, item));
                }),
              Effect.gen(function* () {
                const detail = `Maximum provider round bound of ${providerRoundBound(options)} exceeded.`;
                yield* Ref.set(text, detail);
                yield* Ref.set(terminalDiagnostic, {
                  detail,
                  reason: "turn_failure",
                });
                yield* Ref.set(stopReason, "error");
              }),
            );

          const request = (): Effect.Effect<
            AssistantStopReason,
            BudgetExceeded | JournalFailure | ProviderError
          > =>
            Effect.suspend(() =>
              Effect.gen(function* () {
                yield* resetProviderBuffers();
                yield* phaseChanged(progress, sessionId, "ASSEMBLING");
                const fold = () =>
                  journal.readBranch(sessionId).pipe(
                    Effect.flatMap((branch) =>
                      foldContext(branch, {
                        budget: options.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
                        summaryItem: (payload): ContextItem => ({
                          content: payload.summary,
                          role: "system",
                        }),
                        visibility: entryToContextItem,
                      }),
                    ),
                  );
                const context = yield* fold().pipe(
                  Effect.catchTag("ContextBudgetExceeded", (error) => {
                    const compactionOptions = resolveCompactionPolicyOptions(
                      compaction.policy,
                      options.compaction,
                    );
                    return Ref.getAndSet(compactionAttempted, true).pipe(
                      Effect.flatMap((alreadyAttempted) =>
                        Effect.gen(function* () {
                          if (!compactionOptions.enabled || alreadyAttempted) {
                            return yield* error;
                          }
                          const decision = yield* pluginHost.compactionGate(sessionId, {
                            reason: "overflow",
                            tokenCount: error.required,
                          });
                          if (decision.action === "skip") {
                            return yield* new BudgetExceeded({
                              budget: error.budget,
                              ...(error.compactionApplied === undefined
                                ? {}
                                : { compactionApplied: error.compactionApplied }),
                              optionsDiagnostic: `Compaction was vetoed by a Plugin: ${decision.reason} Branch to an earlier Entry or start a new Session.`,
                              required: error.required,
                            });
                          }
                          yield* compactBranch({
                            journal,
                            options: compactionOptions,
                            progress,
                            provider,
                            providerRuntime,
                            sessionId,
                            turnOrdinal,
                          }).pipe(
                            Effect.catchTags({
                              CompactionDisabled: (failure) => Effect.die(failure),
                              NothingToCompact: (failure) => Effect.die(failure),
                            }),
                          );
                          return yield* fold();
                        }),
                      ),
                    );
                  }),
                  Effect.mapError((error) =>
                    error._tag === "BudgetExceeded"
                      ? error
                      : error._tag === "ContextBudgetExceeded"
                        ? new BudgetExceeded({
                            budget: error.budget,
                            ...(error.compactionApplied === undefined
                              ? {}
                              : { compactionApplied: error.compactionApplied }),
                            optionsDiagnostic: error.optionsDiagnostic,
                            required: error.required,
                          })
                        : error,
                  ),
                );
                yield* phaseChanged(progress, sessionId, "STREAMING");
                yield* consume(context.items);
                const reason = yield* Ref.get(stopReason);
                if (reason !== "toolCalls") {
                  return reason;
                }
                const calls = (yield* Ref.get(toolCalls)).map(
                  (call): ToolCall => ({
                    argumentsJson: call.argumentsJson,
                    id: call.id,
                    name: call.name,
                  }),
                );
                if (calls.length === 0) {
                  const detail = "Provider returned stopReason toolCalls without any tool calls.";
                  yield* Ref.set(text, detail);
                  yield* Ref.set(terminalDiagnostic, {
                    detail,
                    reason: "turn_failure",
                  });
                  return "error";
                }
                const assistant = yield* journal.appendEntry(
                  sessionId,
                  EntryDraftSchema.make({
                    kind: "message",
                    payload: {
                      content: yield* Ref.get(text),
                      role: "assistant",
                      stopReason: "toolCalls",
                      toolCalls: calls,
                    },
                  }),
                );
                yield* Effect.annotateCurrentSpan({
                  assistantEntryId: assistant.id,
                  stopReason: reason,
                });
                yield* phaseChanged(progress, sessionId, "EXECUTING");
                yield* Ref.set(executingCalls, calls);
                const onToolCompleted = (result: ToolBatchResult): Effect.Effect<void> =>
                  Ref.modify(abortState, (current) =>
                    current.finalized
                      ? [false, current]
                      : [
                          true,
                          {
                            completed: new Map(current.completed).set(result.toolCallId, result),
                            finalized: false,
                          },
                        ],
                  ).pipe(
                    Effect.flatMap((recorded) =>
                      recorded
                        ? progress.publish(sessionId, {
                            _tag: "toolCompleted",
                            isError: result.isError === true,
                            toolCallId: result.toolCallId,
                          })
                        : Effect.void,
                    ),
                  );
                const onToolStarted = (call: ToolCall): Effect.Effect<void, JournalFailure> =>
                  durability.markToolStarted(call, sessionView.get(call.name)?.replay ?? "never");
                const batchOptions =
                  options.toolConcurrency === undefined
                    ? {
                        onToolCompleted,
                        onToolStarted,
                      }
                    : {
                        concurrency: options.toolConcurrency,
                        onToolCompleted,
                        onToolStarted,
                      };
                const batch = yield* executeToolBatch(calls, { sessionId }, batchOptions).pipe(
                  Effect.provideService(ToolRegistry, toolRegistry),
                );
                const toolNames = new Map(calls.map((call) => [call.id, call.name]));
                yield* Effect.uninterruptible(
                  Effect.forEach(
                    batch.results,
                    (result) => {
                      const toolName = toolNames.get(result.toolCallId);
                      return toolName === undefined
                        ? Effect.dieMessage(
                            `Tool result ${result.toolCallId} has no matching executed tool call.`,
                          )
                        : appendToolResult(result, toolName);
                    },
                    { concurrency: 1 },
                  ),
                );
                yield* takeSteering(false).pipe(Effect.flatMap(applySteering));
                return yield* request();
              }),
            );

          const run = Effect.gen(function* () {
            const user = yield* journal.appendEntry(
              sessionId,
              EntryDraftSchema.make({ kind: "message", payload: { content, role: "user" } }),
            );
            yield* durability.beginOperation(user.id);
            yield* Effect.annotateCurrentSpan({ sessionId, turnOrdinal, userEntryId: user.id });
            let reason = yield* request();
            while (
              yield* settle(
                reason,
                yield* Ref.get(terminalDiagnostic),
                undefined,
                true,
                reason === "error" ? "convert" : "loop",
              )
            ) {
              reason = yield* request();
            }
            return { stopReason: reason };
          }).pipe(
            Effect.onInterrupt(settleAbort),
            Effect.catchAllCause((cause) =>
              Ref.get(stage).pipe(
                Effect.flatMap((currentStage) => {
                  if (currentStage !== "running") {
                    return Ref.get(abortSettleFailure).pipe(
                      Effect.flatMap((abortFailure) =>
                        abortFailure === undefined
                          ? Effect.failCause(cause)
                          : Effect.failCause(abortFailure),
                      ),
                    );
                  }
                  if (Cause.isInterruptedOnly(cause)) {
                    return Effect.failCause(cause);
                  }
                  const failure = Option.getOrUndefined(Cause.failureOption(cause));
                  if (failure?._tag === "ProviderError") {
                    return Effect.logError("Provider stream failed", cause).pipe(
                      Effect.zipRight(
                        providerRuntime.attemptCount.pipe(
                          Effect.flatMap((attemptCount) =>
                            settle("error", {
                              attempts: attemptCount,
                              detail: failure.message,
                              reason: "provider_error",
                            }),
                          ),
                        ),
                      ),
                      Effect.zipRight(Effect.failCause(cause)),
                    );
                  }
                  if (failure?._tag === "BudgetExceeded") {
                    return settle(
                      "error",
                      {
                        ...(failure.compactionApplied === undefined
                          ? {}
                          : { compactionApplied: failure.compactionApplied }),
                        detail: failure.optionsDiagnostic,
                        reason: "budget_exceeded",
                      },
                      failure.optionsDiagnostic,
                    ).pipe(Effect.zipRight(Effect.failCause(cause)));
                  }
                  if (
                    failure?._tag === "JournalDraftRejected" ||
                    failure?._tag === "JournalError" ||
                    failure?._tag === "JournalNotFound"
                  ) {
                    return Effect.logError("Turn journal operation failed", cause).pipe(
                      Effect.zipRight(finalizeExecutingToolResults()),
                      Effect.zipRight(
                        settle("error", {
                          detail: journalFailureDetail(failure, cause),
                          reason: "journal_failure",
                        }),
                      ),
                      Effect.zipRight(Effect.failCause(cause)),
                    );
                  }
                  return Effect.logError("Turn failed with a defect", cause).pipe(
                    Effect.zipRight(
                      settle("error", { detail: causeDetail(cause), reason: "turn_failure" }),
                    ),
                    Effect.zipRight(Effect.failCause(cause)),
                  );
                }),
              ),
            ),
          );

          const start = yield* Deferred.make<void>();
          const completion =
            yield* Deferred.make<
              Exit.Exit<TurnResult, BudgetExceeded | JournalFailure | ProviderError>
            >();
          const child = yield* Effect.forkDaemon(
            Deferred.await(start).pipe(
              Effect.zipRight(Effect.interruptible(run)),
              Effect.onExit((exit) => Deferred.succeed(completion, exit)),
            ),
          );
          yield* Ref.update(active, (current) =>
            new Map(current).set(sessionId, {
              abortGraceMs: options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS,
              completion,
              fiber: child,
              forceAbort: settleAbort(),
              stage,
              steering,
              steeringMutex,
              turnOrdinal,
            }),
          );
          if (registration !== undefined) {
            yield* removeTurnRegistration(sessionId, registration);
          }
          yield* Deferred.succeed(start, undefined);
          const exit = yield* Deferred.await(completion);
          yield* Ref.update(active, (current) => {
            const next = new Map(current);
            next.delete(sessionId);
            return next;
          });
          return yield* exit;
        });

      const enqueueTurn = (
        sessionId: SessionId,
        content: string,
        options: TurnOptions,
        followUp: FollowUpItem | undefined = undefined,
        registration: TurnRegistration | undefined = undefined,
        leasedGeneration: unknown = undefined,
        onAccepted: Effect.Effect<void> | undefined = undefined,
        resolveOptions: TurnOptionsResolver = keepTurnOptions,
      ): Effect.Effect<TurnResult, TurnFailure> =>
        mailbox
          .enqueue(sessionId, {
            ...(options.expectedRevision === undefined
              ? {}
              : { expectedRevision: options.expectedRevision }),
            name: "turn",
            ...(onAccepted === undefined ? {} : { onAccepted }),
            run: () =>
              (followUp === undefined
                ? Effect.void
                : removeFollowUp(sessionId, followUp).pipe(
                    Effect.zipRight(Effect.annotateCurrentSpan({ followUpDrainedCount: 1 })),
                  )
              ).pipe(
                Effect.zipRight(resolveOptions(options)),
                Effect.flatMap((resolvedOptions) =>
                  execute(sessionId, content, resolvedOptions, leasedGeneration, registration),
                ),
                Effect.withSpan("kernel.turn", {
                  attributes: {
                    sessionId,
                    generationId:
                      typeof leasedGeneration === "string" ? leasedGeneration : sessionId,
                  },
                }),
                Effect.withSpan("turn.orchestrate", {
                  attributes: {
                    generationId:
                      typeof leasedGeneration === "string"
                        ? leasedGeneration
                        : leasedGeneration !== null &&
                            typeof leasedGeneration === "object" &&
                            "generationId" in (leasedGeneration as Record<string, unknown>)
                          ? String((leasedGeneration as Record<string, unknown>).generationId)
                          : sessionId,
                  },
                }),
                Effect.catchTag("BudgetExceeded", () =>
                  Effect.succeed({ stopReason: "error" as const }),
                ),
                Effect.catchTag("ProviderError", () =>
                  Effect.succeed({ stopReason: "error" as const }),
                ),
                Effect.catchAllCause((cause) =>
                  Cause.isInterruptedOnly(cause)
                    ? Effect.succeed({ stopReason: "aborted" as const })
                    : Effect.failCause(cause),
                ),
              ),
          })
          .pipe(
            Effect.map((result) => result.value),
            Effect.catchAll((error) =>
              (followUp === undefined ? Effect.void : removeFollowUp(sessionId, followUp)).pipe(
                Effect.zipRight(
                  registration === undefined
                    ? Effect.void
                    : removeTurnRegistration(sessionId, registration),
                ),
                Effect.zipRight(Effect.fail(error)),
              ),
            ),
          );

      const enqueueRegisteredTurn = (
        sessionId: SessionId,
        content: string,
        options: TurnOptions,
        leasedGeneration: unknown,
        resolveOptions: TurnOptionsResolver,
      ): Effect.Effect<TurnResult, TurnFailure> =>
        Effect.gen(function* () {
          const offered = yield* offerTurnRegistration(sessionId);
          if (offered.queued) {
            yield* progress.publish(sessionId, { _tag: "turnQueued", content });
          }
          return yield* enqueueTurn(
            sessionId,
            content,
            options,
            undefined,
            offered.registration,
            leasedGeneration,
            undefined,
            resolveOptions,
          );
        });

      const enqueueFollowUp = (
        sessionId: SessionId,
        content: string,
        options: TurnOptions,
        leasedGeneration: unknown,
        resolveOptions: TurnOptionsResolver,
      ): Effect.Effect<TurnResult, TurnFailure | TurnQueueFull> =>
        Effect.gen(function* () {
          const item = yield* offerFollowUp(sessionId, content);
          yield* progress.publish(sessionId, { _tag: "followUpQueued", content });
          return yield* enqueueTurn(
            sessionId,
            content,
            options,
            item,
            undefined,
            leasedGeneration,
            undefined,
            resolveOptions,
          );
        });

      const enqueueDetachedFollowUp = (
        sessionId: SessionId,
        content: string,
        leasedGeneration: unknown = undefined,
      ): Effect.Effect<void, TurnQueueFull> =>
        Effect.gen(function* () {
          const item = yield* offerFollowUp(sessionId, content);
          yield* progress.publish(sessionId, { _tag: "followUpQueued", content });
          yield* Effect.forkDaemon(
            enqueueTurn(sessionId, content, {}, item, undefined, leasedGeneration).pipe(
              Effect.asVoid,
            ),
          );
        });

      const openTurnInternal = (
        sessionId: SessionId,
        content: string,
        leasedGeneration: unknown,
        options: TurnOptions,
        resolveOptions: TurnOptionsResolver,
      ): Effect.Effect<TurnResult, TurnFailure> =>
        Effect.suspend(() =>
          Ref.get(active).pipe(
            Effect.flatMap((current) => {
              const turn = current.get(sessionId);
              if (options.deliveryMode !== "steer") {
                return turn === undefined
                  ? enqueueRegisteredTurn(
                      sessionId,
                      content,
                      options,
                      leasedGeneration,
                      resolveOptions,
                    )
                  : enqueueFollowUp(sessionId, content, options, leasedGeneration, resolveOptions);
              }
              if (turn === undefined) {
                return enqueueRegisteredTurn(
                  sessionId,
                  content,
                  options,
                  leasedGeneration,
                  resolveOptions,
                );
              }
              return offerSteering(turn, sessionId, content, options, resolveOptions).pipe(
                Effect.flatMap((result): Effect.Effect<TurnResult, TurnFailure> => {
                  if (result._tag === "closed") {
                    return enqueueFollowUp(
                      sessionId,
                      content,
                      options,
                      leasedGeneration,
                      resolveOptions,
                    );
                  }
                  return awaitTurn(turn);
                }),
              );
            }),
          ),
        );

      return {
        abortTurn: (sessionId: SessionId) =>
          Ref.get(active).pipe(
            Effect.flatMap((current) => {
              const turn = current.get(sessionId);
              if (turn === undefined) {
                const result: AbortTurnResult = {
                  aborted: false,
                  reason: "none",
                  turnOrdinal: undefined,
                };
                return Effect.succeed(result);
              }
              return Ref.modify(turn.stage, (stage) => {
                if (stage === "settling" || stage === "settling-aborted") {
                  return ["loop-prevented" as const, "settling-aborted" as const];
                }
                return [stage === "finishing" ? "finishing" : "interrupt", stage] as const;
              }).pipe(
                Effect.flatMap(
                  (action): Effect.Effect<AbortTurnResult> =>
                    action === "loop-prevented"
                      ? turn.steeringMutex
                          .withPermits(1)(Ref.set(turn.steering, { accepting: false, items: [] }))
                          .pipe(
                            Effect.as({
                              aborted: true,
                              note: "loop-prevented",
                              turnOrdinal: turn.turnOrdinal,
                            } satisfies AbortTurnResult),
                          )
                      : action === "finishing"
                        ? Effect.succeed<AbortTurnResult>({
                            aborted: false,
                            reason: "settling",
                            turnOrdinal: turn.turnOrdinal,
                          })
                        : Effect.gen(function* () {
                            yield* Fiber.interruptFork(turn.fiber);
                            const settled = yield* Fiber.await(turn.fiber).pipe(
                              Effect.timeoutOption(`${turn.abortGraceMs} millis`),
                            );
                            if (Option.isNone(settled)) {
                              yield* turn.forceAbort;
                              yield* Deferred.succeed(
                                turn.completion,
                                Exit.succeed({ stopReason: "aborted" } satisfies TurnResult),
                              );
                              yield* Effect.logError(
                                "Turn fiber exceeded abort grace and remains leaked.",
                              ).pipe(
                                Effect.annotateLogs({
                                  fiberId: FiberId.threadName(Fiber.id(turn.fiber)),
                                  sessionId,
                                }),
                              );
                            }
                            return {
                              aborted: true,
                              turnOrdinal: turn.turnOrdinal,
                            } satisfies AbortTurnResult;
                          }),
                ),
              );
            }),
          ),
        openTurn: (
          sessionId: SessionId,
          content: string,
          leasedGeneration?: unknown,
          options: TurnOptions = {},
          resolveOptions: TurnOptionsResolver = keepTurnOptions,
        ): Effect.Effect<TurnResult, TurnFailure> => {
          validateTurnOptions(options, compaction.policy);
          return openTurnInternal(
            sessionId,
            content,
            leasedGeneration,
            options,
            resolveOptions,
          ).pipe(
            Effect.withSpan("turn.orchestrate", {
              attributes: {
                generationId:
                  typeof leasedGeneration === "string"
                    ? leasedGeneration
                    : leasedGeneration !== null &&
                        typeof leasedGeneration === "object" &&
                        "generationId" in (leasedGeneration as Record<string, unknown>)
                      ? String((leasedGeneration as Record<string, unknown>).generationId)
                      : sessionId,
                sessionId,
              },
            }),
          );
        },
        steer: (sessionId: SessionId, content: string) =>
          Effect.gen(function* () {
            const turn = (yield* Ref.get(active)).get(sessionId);
            if (turn === undefined) {
              const hasPendingTurn =
                (yield* Ref.get(turnRegistrations)).has(sessionId) ||
                (yield* Ref.get(followUps)).has(sessionId);
              if (hasPendingTurn) {
                return yield* enqueueDetachedFollowUp(sessionId, content);
              }
              return yield* new ProtocolError({
                message: "Steering requires a running turn.",
                reason: "phase_invalid_command",
              });
            }
            const queued = yield* offerSteering(turn, sessionId, content, {}, keepTurnOptions);
            if (queued._tag === "closed") {
              yield* enqueueDetachedFollowUp(sessionId, content);
            }
          }),
        subscribeProgress: (sessionId: SessionId) => progress.subscribe(sessionId),
      } satisfies TurnOrchestratorService;
    }),
  );
