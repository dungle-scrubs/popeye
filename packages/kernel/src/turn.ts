/**
 * Owns mailbox-serialized turn execution from Context assembly through settlement.
 * It exists so prompts, Provider output, durable Entries, progress, and abort share one lifecycle.
 */

import {
  EntryDraftSchema,
  foldContext,
  Journal,
  type JournalFailure,
  type SessionId,
} from "@peye/journal";
import { ProtocolError } from "@peye/protocol";
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
  Schedule,
  Stream,
} from "effect";
import type { AssistantDiagnostic } from "./entry-payloads.js";
import { BudgetExceeded, type ProviderError, TurnQueueFull } from "./errors.js";
import { Mailbox, type MailboxFailure } from "./mailbox.js";
import { type Progress, ProgressHub, type TurnPhase } from "./progress.js";
import {
  type AssistantStopReason,
  asContextToolCalls,
  type ContextItem,
  Provider,
} from "./provider.js";
import {
  appendOperationFinished,
  appendOperationStarted,
  appendToolStarted,
  createOperationId,
} from "./records.js";
import { ToolRegistry } from "./tool.js";
import { executeToolBatch, type ToolBatchResult, type ToolCall } from "./tool-batch.js";

export interface TurnOptions {
  readonly abortGraceMs?: number;
  readonly contextBudget?: number;
  readonly deliveryMode?: "followUp" | "steer";
  readonly expectedRevision?: number;
  readonly maxAttempts?: number;
  readonly maxProviderRounds?: number;
  /** @deprecated Use maxProviderRounds. */
  readonly maxToolRounds?: number;
  readonly toolConcurrency?: number;
}

export interface TurnResult {
  readonly stopReason: AssistantStopReason;
}

export type AbortTurnResult =
  | {
      readonly aborted: false;
      readonly reason: "none" | "settling";
      readonly turnOrdinal: number | undefined;
    }
  | { readonly aborted: true; readonly turnOrdinal: number }
  | {
      readonly aborted: true;
      readonly note: "loop-prevented";
      readonly turnOrdinal: number;
    };

export type TurnFailure = JournalFailure | MailboxFailure | ProtocolError | TurnQueueFull;

export interface TurnsService {
  readonly abortTurn: (sessionId: SessionId) => Effect.Effect<AbortTurnResult>;
  readonly runTurn: (
    sessionId: SessionId,
    content: string,
    options?: TurnOptions,
  ) => Effect.Effect<TurnResult, TurnFailure>;
  readonly steer: (
    sessionId: SessionId,
    content: string,
  ) => Effect.Effect<void, ProtocolError | TurnQueueFull>;
  readonly subscribeProgress: (sessionId: SessionId) => Stream.Stream<Progress>;
}

export class Turns extends Context.Tag("@peye/kernel/Turns")<Turns, TurnsService>() {}

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
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_PROVIDER_ROUNDS = 32;
const DEFAULT_ABORT_GRACE_MS = 5_000;

/** Maximum steering or follow-up items retained per session. Excess input fails typed. */
export const TURN_INPUT_QUEUE_CAPACITY = 64;

interface BufferedToolCall extends ToolCall {
  readonly index?: number;
}

interface ToolAbortState {
  readonly completed: ReadonlyMap<string, ToolBatchResult>;
  readonly finalized: boolean;
}

const asContextItem = (entry: {
  readonly kind: string;
  readonly payload: unknown;
}): ContextItem | undefined => {
  if (entry.kind !== "message" || typeof entry.payload !== "object" || entry.payload === null) {
    return undefined;
  }
  const payload = entry.payload as {
    readonly content?: unknown;
    readonly isError?: unknown;
    readonly role?: unknown;
    readonly toolCallId?: unknown;
    readonly toolCalls?: unknown;
    readonly toolName?: unknown;
  };
  if (typeof payload.content !== "string" || typeof payload.role !== "string") {
    return undefined;
  }
  if (payload.role === "assistant") {
    const calls = asContextToolCalls(payload.toolCalls);
    return calls === undefined
      ? { content: payload.content, role: payload.role }
      : { content: payload.content, role: payload.role, toolCalls: calls };
  }
  if (
    payload.role === "toolResult" &&
    typeof payload.toolCallId === "string" &&
    typeof payload.toolName === "string"
  ) {
    return {
      content: payload.content,
      isError: payload.isError === true,
      role: payload.role,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
    };
  }
  return payload.role === "system" || payload.role === "user"
    ? { content: payload.content, role: payload.role }
    : undefined;
};

const validatePositiveInteger = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
};

const validateTurnOptions = (options: TurnOptions): void => {
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
};

const providerRoundBound = (options: TurnOptions): number =>
  options.maxProviderRounds ?? options.maxToolRounds ?? DEFAULT_MAX_PROVIDER_ROUNDS;

const withoutExpectedRevision = (options: TurnOptions): TurnOptions => {
  const next = { ...options };
  delete next.expectedRevision;
  return next;
};

const phaseChanged = (progress: ProgressHub["Type"], sessionId: SessionId, phase: TurnPhase) =>
  progress.publish(sessionId, { _tag: "phaseChanged", phase });

const causeDetail = (cause: Cause.Cause<unknown>): string => Cause.pretty(cause);

const journalFailureDetail = (failure: JournalFailure, cause: Cause.Cause<unknown>): string =>
  "message" in failure && typeof failure.message === "string"
    ? failure.message
    : causeDetail(cause);

export const TurnsLive = (): Layer.Layer<
  Turns,
  never,
  Journal | Mailbox | ProgressHub | Provider | ToolRegistry
> =>
  Layer.effect(
    Turns,
    Effect.gen(function* () {
      const journal = yield* Journal;
      const mailbox = yield* Mailbox;
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
      ): Effect.Effect<OfferSteeringResult, TurnQueueFull> =>
        turn.steeringMutex.withPermits(1)(
          Ref.modify<SteeringState, OfferSteeringCommit>(turn.steering, (current) => {
            if (!current.accepting) {
              return [{ _tag: "closed" }, current];
            }
            if (current.items.length >= TURN_INPUT_QUEUE_CAPACITY) {
              return [{ _tag: "full" }, current];
            }
            const item: SteeringItem = { content, options };
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
        registration: TurnRegistration | undefined,
      ): Effect.Effect<TurnResult, BudgetExceeded | JournalFailure | ProviderError> =>
        Effect.gen(function* () {
          const priorBranch = yield* journal.readBranch(sessionId);
          const turnOrdinal =
            priorBranch.filter((entry) => {
              const item = asContextItem(entry);
              if (item?.role !== "user") {
                return false;
              }
              const payload = entry.payload as { readonly deliveryMode?: unknown };
              return payload.deliveryMode !== "steer";
            }).length + 1;
          const attempts = yield* Ref.make(0);
          const abortSettleFailure = yield* Ref.make<Cause.Cause<JournalFailure> | undefined>(
            undefined,
          );
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
          const providerRounds = yield* Ref.make(0);
          const executingCalls = yield* Ref.make<ReadonlyArray<ToolCall> | undefined>(undefined);
          const persistedToolCallIds = yield* Ref.make<Set<string>>(new Set());
          const persistenceMutex = yield* Effect.makeSemaphore(1);
          const operationId = yield* createOperationId();
          const operationFinished = yield* Ref.make(false);
          const operationRecorded = yield* Ref.make(false);

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
            Effect.forEach(
              items,
              (item) =>
                journal
                  .appendEntry(
                    sessionId,
                    EntryDraftSchema.make({
                      kind: "message",
                      payload: { content: item.content, deliveryMode: "steer", role: "user" },
                    }),
                  )
                  .pipe(
                    Effect.zipRight(
                      progress.publish(sessionId, {
                        _tag: "steeringApplied",
                        content: item.content,
                      }),
                    ),
                  ),
              { concurrency: 1 },
            ).pipe(
              Effect.zipRight(Ref.update(steeringDrainedCount, (count) => count + items.length)),
            );

          const queueConvertedSteering = (
            items: ReadonlyArray<SteeringItem>,
          ): Effect.Effect<void> =>
            Effect.gen(function* () {
              const queued = items.map((item) => ({
                followUp: { content: item.content } satisfies FollowUpItem,
                options: withoutExpectedRevision(item.options),
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
                          Deferred.succeed(accepted, undefined).pipe(Effect.asVoid),
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
                  const assistant = yield* journal.appendEntry(
                    sessionId,
                    EntryDraftSchema.make({
                      kind: "message",
                      payload:
                        diagnostic === undefined
                          ? {
                              content: assistantContent,
                              role: "assistant",
                              stopReason: reason,
                            }
                          : {
                              content: assistantContent,
                              diagnostic,
                              role: "assistant",
                              stopReason: reason,
                            },
                    }),
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
                const shouldFinish =
                  (yield* Ref.get(operationRecorded)) &&
                  !(yield* Ref.getAndSet(operationFinished, true));
                if (shouldFinish) {
                  yield* appendOperationFinished(journal, sessionId, {
                    operationId,
                    outcome: reason,
                  });
                }
                yield* finishSettlement(reason);
                return false;
              }).pipe(Effect.onError(() => finishSettlement(reason))),
            );

          const appendToolResult = (
            result: ToolBatchResult,
            toolName: string,
          ): Effect.Effect<boolean, JournalFailure> =>
            persistenceMutex.withPermits(1)(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const persisted = yield* Ref.get(persistedToolCallIds);
                  if (persisted.has(result.toolCallId)) {
                    return false;
                  }
                  yield* journal.appendEntry(
                    sessionId,
                    EntryDraftSchema.make({
                      kind: "message",
                      payload: {
                        content: result.content,
                        isError: result.isError === true,
                        role: "toolResult",
                        toolCallId: result.toolCallId,
                        toolName,
                      },
                    }),
                  );
                  yield* Ref.update(persistedToolCallIds, (current) =>
                    new Set(current).add(result.toolCallId),
                  );
                  return true;
                }),
              ),
            );

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
            Effect.suspend(() =>
              Effect.gen(function* () {
                yield* resetProviderBuffers();
                const providerRound = yield* Ref.updateAndGet(providerRounds, (count) => count + 1);
                const maximumProviderRounds = providerRoundBound(options);
                if (providerRound > maximumProviderRounds) {
                  const detail = `Maximum provider round bound of ${maximumProviderRounds} exceeded.`;
                  yield* Ref.set(text, detail);
                  yield* Ref.set(terminalDiagnostic, {
                    detail,
                    reason: "turn_failure",
                  });
                  yield* Ref.set(stopReason, "error");
                  return;
                }
                const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1);
                const attemptProgress = yield* Ref.make<ReadonlyArray<Progress>>([]);
                yield* Effect.annotateCurrentSpan({ attempt });
                yield* Stream.runForEach(
                  provider.streamAssistant(context, { attempt, turnOrdinal }),
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
            );

          const request = (): Effect.Effect<
            AssistantStopReason,
            BudgetExceeded | JournalFailure | ProviderError
          > =>
            Effect.suspend(() =>
              Effect.gen(function* () {
                yield* resetProviderBuffers();
                yield* phaseChanged(progress, sessionId, "ASSEMBLING");
                const branch = yield* journal.readBranch(sessionId);
                const context = yield* foldContext(branch, {
                  budget: options.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
                  summaryItem: (payload): ContextItem => ({
                    content: payload.summary,
                    role: "system",
                  }),
                  visibility: asContextItem,
                }).pipe(
                  Effect.mapError((error) =>
                    error._tag === "ContextBudgetExceeded"
                      ? new BudgetExceeded({
                          budget: error.budget,
                          optionsDiagnostic: error.optionsDiagnostic,
                          required: error.required,
                        })
                      : error,
                  ),
                );
                yield* phaseChanged(progress, sessionId, "STREAMING");
                yield* consume(context.items).pipe(
                  Effect.retry(
                    Schedule.recurs((options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS) - 1).pipe(
                      Schedule.whileInput((error: ProviderError) => error.transient),
                    ),
                  ),
                );
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
                  appendToolStarted(journal, sessionId, {
                    operationId,
                    replay: toolRegistry.get(call.name)?.replay ?? "never",
                    toolCallId: call.id,
                    toolName: call.name,
                  }).pipe(
                    Effect.zipRight(
                      progress.publish(sessionId, {
                        _tag: "toolStarted",
                        name: call.name,
                        toolCallId: call.id,
                      }),
                    ),
                  );
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
            yield* Effect.uninterruptible(
              appendOperationStarted(journal, sessionId, {
                intent: "turn",
                operationId,
                promptEntryId: user.id,
                turnOrdinal,
              }).pipe(Effect.zipRight(Ref.set(operationRecorded, true))),
            );
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
                        Ref.get(attempts).pipe(
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
          // The grace path must be able to release the caller even when a Tool never leaves an
          // uninterruptible region. ActiveTurn still tracks this detached fiber until settlement.
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
        onAccepted: Effect.Effect<void> | undefined = undefined,
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
                Effect.zipRight(execute(sessionId, content, options, registration)),
                Effect.withSpan("kernel.turn", { attributes: { sessionId } }),
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
      ): Effect.Effect<TurnResult, TurnFailure> =>
        Effect.gen(function* () {
          const offered = yield* offerTurnRegistration(sessionId);
          if (offered.queued) {
            yield* progress.publish(sessionId, { _tag: "turnQueued", content });
          }
          return yield* enqueueTurn(sessionId, content, options, undefined, offered.registration);
        });

      const enqueueFollowUp = (
        sessionId: SessionId,
        content: string,
        options: TurnOptions,
      ): Effect.Effect<TurnResult, TurnFailure | TurnQueueFull> =>
        Effect.gen(function* () {
          const item = yield* offerFollowUp(sessionId, content);
          yield* progress.publish(sessionId, { _tag: "followUpQueued", content });
          return yield* enqueueTurn(sessionId, content, options, item);
        });

      const enqueueDetachedFollowUp = (
        sessionId: SessionId,
        content: string,
      ): Effect.Effect<void, TurnQueueFull> =>
        Effect.gen(function* () {
          const item = yield* offerFollowUp(sessionId, content);
          yield* progress.publish(sessionId, { _tag: "followUpQueued", content });
          yield* Effect.forkDaemon(enqueueTurn(sessionId, content, {}, item).pipe(Effect.asVoid));
        });

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
        runTurn: (
          sessionId: SessionId,
          content: string,
          options: TurnOptions = {},
        ): Effect.Effect<TurnResult, TurnFailure> => {
          validateTurnOptions(options);
          return Effect.suspend(() =>
            Ref.get(active).pipe(
              Effect.flatMap((current) => {
                const turn = current.get(sessionId);
                if (options.deliveryMode !== "steer") {
                  return turn === undefined
                    ? enqueueRegisteredTurn(sessionId, content, options)
                    : enqueueFollowUp(sessionId, content, options);
                }
                if (turn === undefined) {
                  return enqueueRegisteredTurn(sessionId, content, options);
                }
                return offerSteering(turn, sessionId, content, options).pipe(
                  Effect.flatMap((result): Effect.Effect<TurnResult, TurnFailure> => {
                    if (result._tag === "closed") {
                      return enqueueFollowUp(sessionId, content, options);
                    }
                    return awaitTurn(turn);
                  }),
                );
              }),
            ),
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
            const queued = yield* offerSteering(turn, sessionId, content, {});
            if (queued._tag === "closed") {
              yield* enqueueDetachedFollowUp(sessionId, content);
            }
          }),
        subscribeProgress: (sessionId: SessionId) => progress.subscribe(sessionId),
      } satisfies TurnsService;
    }),
  );
