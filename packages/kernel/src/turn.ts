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

import { BudgetExceeded, type ProviderError, TurnQueueFull } from "./errors.js";
import { Mailbox, type MailboxFailure } from "./mailbox.js";
import { type Progress, ProgressHub, type TurnPhase } from "./progress.js";
import {
  type AssistantStopReason,
  type ContextItem,
  type ContextToolCall,
  Provider,
} from "./provider.js";
import { ToolRegistry } from "./tool.js";
import { executeToolBatch, type ToolBatchResult, type ToolCall } from "./tool-batch.js";

export interface TurnOptions {
  readonly abortGraceMs?: number;
  readonly contextBudget?: number;
  readonly deliveryMode?: "followUp" | "steer";
  readonly maxAttempts?: number;
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
  | { readonly aborted: true; readonly turnOrdinal: number };

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
  readonly stage: Ref.Ref<"running" | "settling">;
  readonly steering: Ref.Ref<SteeringState>;
  readonly turnOrdinal: number;
}

interface SteeringState {
  readonly accepting: boolean;
  readonly items: ReadonlyArray<string>;
}

interface FollowUpItem {
  readonly content: string;
}

type AssistantDiagnostic =
  | {
      readonly detail: string;
      readonly reason: "budget_exceeded" | "journal_failure" | "turn_failure";
    }
  | { readonly attempts: number; readonly detail: string; readonly reason: "provider_error" };

const DEFAULT_CONTEXT_BUDGET = 32_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_TOOL_ROUNDS = 16;
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

const asContextToolCalls = (value: unknown): ReadonlyArray<ContextToolCall> | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const calls: Array<ContextToolCall> = [];
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) {
      return undefined;
    }
    const call = candidate as {
      readonly argumentsJson?: unknown;
      readonly id?: unknown;
      readonly name?: unknown;
    };
    if (
      typeof call.argumentsJson !== "string" ||
      typeof call.id !== "string" ||
      typeof call.name !== "string"
    ) {
      return undefined;
    }
    calls.push({ argumentsJson: call.argumentsJson, id: call.id, name: call.name });
  }
  return calls;
};

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
  if (payload.role === "toolResult" && typeof payload.toolCallId === "string") {
    return {
      content: payload.content,
      isError: payload.isError === true,
      role: payload.role,
      toolCallId: payload.toolCallId,
    };
  }
  return { content: payload.content, role: payload.role };
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
  if (options.maxToolRounds !== undefined) {
    validatePositiveInteger("Maximum tool rounds", options.maxToolRounds);
  }
  if (options.toolConcurrency !== undefined) {
    validatePositiveInteger("Tool concurrency", options.toolConcurrency);
  }
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
      ): Effect.Effect<"closed" | "queued", TurnQueueFull> =>
        Ref.modify(turn.steering, (current) => {
          if (!current.accepting) {
            return ["closed" as const, current];
          }
          if (current.items.length >= TURN_INPUT_QUEUE_CAPACITY) {
            return ["full" as const, current];
          }
          return ["queued" as const, { ...current, items: [...current.items, content] }];
        }).pipe(
          Effect.flatMap((result) =>
            result === "full"
              ? Effect.fail(
                  new TurnQueueFull({
                    capacity: TURN_INPUT_QUEUE_CAPACITY,
                    queue: "steering",
                    sessionId,
                  }),
                )
              : Effect.succeed(result),
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
          const stage = yield* Ref.make<"running" | "settling">("running");
          const steering = yield* Ref.make<SteeringState>({ accepting: true, items: [] });
          const stopReason = yield* Ref.make<AssistantStopReason>("done");
          const terminalDiagnostic = yield* Ref.make<AssistantDiagnostic | undefined>(undefined);
          const text = yield* Ref.make("");
          const toolCalls = yield* Ref.make<ReadonlyArray<BufferedToolCall>>([]);
          const toolRounds = yield* Ref.make(0);
          const executingCalls = yield* Ref.make<ReadonlyArray<ToolCall> | undefined>(undefined);
          const persistedToolCallIds = yield* Ref.make<Set<string>>(new Set());
          const persistenceMutex = yield* Effect.makeSemaphore(1);

          const takeSteering = (closeWhenEmpty: boolean): Effect.Effect<ReadonlyArray<string>> =>
            Ref.modify(steering, (current) => [
              current.items,
              {
                accepting: closeWhenEmpty && current.items.length === 0 ? false : current.accepting,
                items: [],
              },
            ]);

          const applySteering = (
            items: ReadonlyArray<string>,
          ): Effect.Effect<void, JournalFailure> =>
            Effect.forEach(
              items,
              (steeringContent) =>
                journal
                  .appendEntry(
                    sessionId,
                    EntryDraftSchema.make({
                      kind: "message",
                      payload: { content: steeringContent, deliveryMode: "steer", role: "user" },
                    }),
                  )
                  .pipe(
                    Effect.zipRight(
                      progress.publish(sessionId, {
                        _tag: "steeringApplied",
                        content: steeringContent,
                      }),
                    ),
                  ),
              { concurrency: 1 },
            ).pipe(
              Effect.zipRight(Effect.annotateCurrentSpan({ steeringDrainedCount: items.length })),
            );

          const finishSettlement = (reason: AssistantStopReason): Effect.Effect<void> =>
            Effect.gen(function* () {
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
            allowSteering = false,
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
                if (allowSteering) {
                  const items = yield* takeSteering(true);
                  if (items.length > 0) {
                    yield* applySteering(items);
                    yield* Ref.set(stage, "running");
                    return true;
                  }
                } else {
                  yield* Ref.update(steering, () => ({
                    accepting: false,
                    items: [],
                  }));
                }
                yield* finishSettlement(reason);
                return false;
              }).pipe(Effect.onError(() => finishSettlement(reason))),
            );

          const appendToolResult = (
            result: ToolBatchResult,
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

          const settleAbort = (): Effect.Effect<void> =>
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
                            return appendToolResult(result).pipe(
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
                        yield* settle("aborted", undefined, "");
                        return;
                      }
                      yield* settle("aborted", undefined);
                    }).pipe(Effect.uninterruptible)
                  : Effect.void,
              ),
              Effect.exit,
              Effect.flatMap((exit) =>
                Exit.isFailure(exit) ? Ref.set(abortSettleFailure, exit.cause) : Effect.void,
              ),
            );

          const consume = (
            context: ReadonlyArray<ContextItem>,
          ): Effect.Effect<void, ProviderError> =>
            Effect.suspend(() =>
              Effect.gen(function* () {
                yield* Ref.set(executingCalls, undefined);
                yield* Ref.set(stopReason, "done");
                yield* Ref.set(terminalDiagnostic, undefined);
                yield* Ref.set(text, "");
                yield* Ref.set(toolCalls, []);
                const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1);
                const attemptProgress = yield* Ref.make<ReadonlyArray<Progress>>([]);
                yield* Effect.annotateCurrentSpan({ attempt });
                yield* Stream.runForEach(
                  provider.streamAssistant(context, { turnOrdinal }),
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
                const round = yield* Ref.updateAndGet(toolRounds, (count) => count + 1);
                const maxToolRounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
                if (round > maxToolRounds) {
                  const detail = `Maximum tool round bound of ${maxToolRounds} exceeded.`;
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
                const onToolStarted = (call: ToolCall): Effect.Effect<void> =>
                  progress.publish(sessionId, {
                    _tag: "toolStarted",
                    name: call.name,
                    toolCallId: call.id,
                  });
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
                yield* Effect.uninterruptible(
                  Effect.forEach(batch.results, appendToolResult, { concurrency: 1 }),
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
            yield* Effect.annotateCurrentSpan({ sessionId, turnOrdinal, userEntryId: user.id });
            let reason = yield* request();
            while (
              yield* settle(reason, yield* Ref.get(terminalDiagnostic), undefined, true, true)
            ) {
              reason = yield* request();
            }
            return { stopReason: reason };
          }).pipe(
            Effect.onInterrupt(settleAbort),
            Effect.catchAllCause((cause) =>
              Ref.get(stage).pipe(
                Effect.flatMap((currentStage) => {
                  if (currentStage === "settling") {
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
              turnOrdinal,
            }),
          );
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
      ): Effect.Effect<TurnResult, TurnFailure> =>
        mailbox
          .enqueue(sessionId, {
            name: "turn",
            run: () =>
              (followUp === undefined
                ? Effect.void
                : removeFollowUp(sessionId, followUp).pipe(
                    Effect.zipRight(Effect.annotateCurrentSpan({ followUpDrainedCount: 1 })),
                  )
              ).pipe(
                Effect.zipRight(
                  execute(sessionId, content, options).pipe(
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
                ),
              ),
          })
          .pipe(
            Effect.map((result) => result.value),
            Effect.catchAll((error) =>
              followUp === undefined
                ? Effect.fail(error)
                : removeFollowUp(sessionId, followUp).pipe(Effect.zipRight(Effect.fail(error))),
            ),
          );

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
              return Ref.get(turn.stage).pipe(
                Effect.flatMap(
                  (stage): Effect.Effect<AbortTurnResult> =>
                    stage === "settling"
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
                    ? enqueueTurn(sessionId, content, options)
                    : enqueueFollowUp(sessionId, content, options);
                }
                if (turn === undefined) {
                  return Effect.fail(
                    new ProtocolError({
                      message: "Steering requires a running turn.",
                      reason: "phase_invalid_command",
                    }),
                  );
                }
                return offerSteering(turn, sessionId, content).pipe(
                  Effect.flatMap((result): Effect.Effect<TurnResult, TurnFailure> => {
                    if (result === "closed") {
                      return enqueueFollowUp(sessionId, content, options);
                    }
                    return progress
                      .publish(sessionId, { _tag: "steeringQueued", content })
                      .pipe(Effect.zipRight(awaitTurn(turn)));
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
              return yield* new ProtocolError({
                message: "Steering requires a running turn.",
                reason: "phase_invalid_command",
              });
            }
            const queued = yield* offerSteering(turn, sessionId, content);
            if (queued === "closed") {
              return yield* new ProtocolError({
                message: "Steering requires a running turn.",
                reason: "phase_invalid_command",
              });
            }
            yield* progress.publish(sessionId, { _tag: "steeringQueued", content });
          }),
        subscribeProgress: (sessionId: SessionId) => progress.subscribe(sessionId),
      } satisfies TurnsService;
    }),
  );
