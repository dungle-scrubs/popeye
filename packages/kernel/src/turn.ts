/**
 * Owns mailbox-serialized turn execution from Context assembly through settlement.
 * It exists so prompts, Provider output, durable Entries, progress, and abort share one lifecycle.
 */

import {
  type ContextItem,
  EntryDraftSchema,
  foldContext,
  Journal,
  type JournalFailure,
  type SessionId,
} from "@peye/journal";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Schedule,
  Stream,
} from "effect";

import { BudgetExceeded, type ProviderError } from "./errors.js";
import { Mailbox, type MailboxFailure } from "./mailbox.js";
import { type Progress, ProgressHub, type TurnPhase } from "./progress.js";
import { type AssistantStopReason, Provider } from "./provider.js";
import { ToolRegistry } from "./tool.js";
import { executeToolBatch, type ToolBatchResult, type ToolCall } from "./tool-batch.js";

export interface TurnOptions {
  readonly contextBudget?: number;
  readonly maxAttempts?: number;
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

export type TurnFailure = JournalFailure | MailboxFailure;

export interface TurnsService {
  readonly abortTurn: (sessionId: SessionId) => Effect.Effect<AbortTurnResult>;
  readonly runTurn: (
    sessionId: SessionId,
    content: string,
    options?: TurnOptions,
  ) => Effect.Effect<TurnResult, TurnFailure>;
  readonly subscribeProgress: (sessionId: SessionId) => Stream.Stream<Progress>;
}

export class Turns extends Context.Tag("@peye/kernel/Turns")<Turns, TurnsService>() {}

interface ActiveTurn {
  readonly fiber: Fiber.Fiber<TurnResult, BudgetExceeded | JournalFailure | ProviderError>;
  readonly stage: Ref.Ref<"running" | "settling">;
  readonly turnOrdinal: number;
}

type AssistantDiagnostic =
  | {
      readonly detail: string;
      readonly reason: "budget_exceeded" | "journal_failure" | "turn_failure";
    }
  | { readonly attempts: number; readonly detail: string; readonly reason: "provider_error" };

const DEFAULT_CONTEXT_BUDGET = 32_000;
const DEFAULT_MAX_ATTEMPTS = 3;

const asContextItem = (entry: {
  readonly kind: string;
  readonly payload: unknown;
}): ContextItem | undefined => {
  if (entry.kind !== "message" || typeof entry.payload !== "object" || entry.payload === null) {
    return undefined;
  }
  const payload = entry.payload as { readonly content?: unknown; readonly role?: unknown };
  return typeof payload.content === "string" && typeof payload.role === "string"
    ? { content: payload.content, role: payload.role }
    : undefined;
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
      const execute = (
        sessionId: SessionId,
        content: string,
        options: TurnOptions,
      ): Effect.Effect<TurnResult, BudgetExceeded | JournalFailure | ProviderError> =>
        Effect.gen(function* () {
          const priorBranch = yield* journal.readBranch(sessionId);
          const turnOrdinal =
            priorBranch.filter((entry) => asContextItem(entry)?.role === "assistant").length + 1;
          const attempts = yield* Ref.make(0);
          const abortSettleFailure = yield* Ref.make<Cause.Cause<JournalFailure> | undefined>(
            undefined,
          );
          const stage = yield* Ref.make<"running" | "settling">("running");
          const stopReason = yield* Ref.make<AssistantStopReason>("done");
          const text = yield* Ref.make("");
          const toolCalls = yield* Ref.make<ReadonlyArray<ToolCall>>([]);
          const executingCalls = yield* Ref.make<ReadonlyArray<ToolCall> | undefined>(undefined);

          const settle = (
            reason: AssistantStopReason,
            diagnostic: AssistantDiagnostic | undefined,
            contentOverride: string | undefined = undefined,
            appendAssistant = true,
          ): Effect.Effect<void, JournalFailure> =>
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
              }).pipe(
                Effect.ensuring(
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
                  }),
                ),
              ),
            );

          const consume = (
            context: ReadonlyArray<ContextItem>,
          ): Effect.Effect<void, ProviderError> =>
            Effect.suspend(() =>
              Effect.gen(function* () {
                yield* Ref.set(stopReason, "done");
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
                      return Ref.update(toolCalls, (current) => [
                        ...current,
                        {
                          argumentsJson: item.argumentsJson,
                          id: item.id,
                          name: item.name,
                        },
                      ]);
                    }
                    if (item._tag === "toolCallDelta") {
                      return Ref.update(toolCalls, (current) => {
                        const prior = current.find((call) => call.id === item.id);
                        if (prior === undefined && item.name === undefined) {
                          return current;
                        }
                        const next: ToolCall = {
                          argumentsJson: (prior?.argumentsJson ?? "") + item.argumentsJsonDelta,
                          id: item.id,
                          name: item.name ?? prior?.name ?? "",
                        };
                        return prior === undefined
                          ? [...current, next]
                          : current.map((call) => (call.id === item.id ? next : call));
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
                const calls = yield* Ref.get(toolCalls);
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
                  progress.publish(sessionId, {
                    _tag: "toolCompleted",
                    isError: result.isError === true,
                    toolCallId: result.toolCallId,
                  });
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
                yield* Effect.forEach(
                  batch.results,
                  (result) =>
                    journal.appendEntry(
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
                    ),
                  { concurrency: 1 },
                );
                yield* Ref.set(executingCalls, undefined);
                return yield* request();
              }),
            );

          const run = Effect.gen(function* () {
            const user = yield* journal.appendEntry(
              sessionId,
              EntryDraftSchema.make({ kind: "message", payload: { content, role: "user" } }),
            );
            yield* Effect.annotateCurrentSpan({ sessionId, turnOrdinal, userEntryId: user.id });
            const reason = yield* request();
            yield* settle(reason, undefined);
            return { stopReason: reason };
          }).pipe(
            Effect.onInterrupt(() =>
              Ref.get(executingCalls)
                .pipe(
                  Effect.flatMap((calls) =>
                    calls === undefined
                      ? settle("aborted", undefined)
                      : Effect.uninterruptible(
                          Effect.forEach(
                            calls,
                            (call) =>
                              journal
                                .appendEntry(
                                  sessionId,
                                  EntryDraftSchema.make({
                                    kind: "message",
                                    payload: {
                                      content: "Tool execution interrupted.",
                                      isError: true,
                                      role: "toolResult",
                                      toolCallId: call.id,
                                    },
                                  }),
                                )
                                .pipe(
                                  Effect.zipRight(
                                    progress.publish(sessionId, {
                                      _tag: "toolCompleted",
                                      isError: true,
                                      toolCallId: call.id,
                                    }),
                                  ),
                                ),
                            { concurrency: 1 },
                          ).pipe(
                            Effect.zipRight(Effect.annotateCurrentSpan({ interrupted: true })),
                            Effect.zipRight(settle("aborted", undefined, undefined, false)),
                          ),
                        ),
                  ),
                )
                .pipe(
                  Effect.exit,
                  Effect.flatMap((exit) =>
                    Exit.isFailure(exit) ? Ref.set(abortSettleFailure, exit.cause) : Effect.void,
                  ),
                ),
            ),
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
          const child = yield* Effect.fork(
            Deferred.await(start).pipe(Effect.zipRight(Effect.interruptible(run))),
          );
          yield* Ref.update(active, (current) =>
            new Map(current).set(sessionId, { fiber: child, stage, turnOrdinal }),
          );
          yield* Deferred.succeed(start, undefined);
          const exit = yield* Fiber.await(child);
          yield* Ref.update(active, (current) => {
            const next = new Map(current);
            next.delete(sessionId);
            return next;
          });
          return yield* exit;
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
                      : Fiber.interrupt(turn.fiber).pipe(
                          Effect.as<AbortTurnResult>({
                            aborted: true,
                            turnOrdinal: turn.turnOrdinal,
                          }),
                        ),
                ),
              );
            }),
          ),
        runTurn: (sessionId: SessionId, content: string, options: TurnOptions = {}) =>
          mailbox
            .enqueue(sessionId, {
              name: "turn",
              run: () =>
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
            })
            .pipe(Effect.map((result) => result.value)),
        subscribeProgress: (sessionId: SessionId) => progress.subscribe(sessionId),
      } satisfies TurnsService;
    }),
  );
