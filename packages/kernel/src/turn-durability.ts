/**
 * Owns TurnDurability deep module for turn-scoped Journal durability.
 * It exists so per-turn Journal writes — operation records, assistant entries, tool results with deduplication, steering entries, and revision counting — hide behind one deep interface.
 *
 * Why this module: TurnOrchestrator was 1,520 lines owning Context assembly, Provider retry, Tool batch, steering/follow-up queueing, compaction, and Journal appends. Understanding "when does a Tool result become durable?" required reading the whole file, and adding a new durable write (e.g. fencing) touched the entire turn loop. The seam between "coordinate the turn" and "make it durable" was missing. Bugs hid between helpers: persistedToolCallIds deduplication, operationFinished idempotence, and abortState finalization were closure-captured Refs scattered across execute().
 *
 * This module hides the one durability Ref set (persistedToolCallIds, persistenceMutex, abortState, operationFinished/Recorded) and the uninterruptible Journal appends (appendOperationStarted/Finished, appendToolStarted, appendEntry for assistant/toolResult/steering) behind makeTurnDurabilityHandle(sessionId, operationId, turnOrdinal). TurnOrchestrator retains coordination (Context → Provider → Tool batch → steering decision) and depends on TurnDurability's small handle interface. SessionStore remains the single Journal caller for session lifecycle (D-001); TurnDurability is the single caller for turn-scoped writes, so Journal write invariants are inspectable in one place.
 *
 * Not responsible for Context assembly (journal/foldContext owns folding), for Provider retry (provider-retry owns bound), for Tool execution (tool-batch owns concurrency), or for Mailbox serialization (callers own that). The seam is Journal I/O for turn writes: two adapters justify it — LiveTurnDurability over a real Journal + FakeTurnDurability over an in-memory commit log in tests (turn-durability.test proves deduplication without Journal I/O).
 */

import type { JournalFailure } from "@pop-eye/journal";
import { EntryDraftSchema, type JournalService, type SessionId } from "@pop-eye/journal";
import { Effect, Ref } from "effect";
import type { AssistantDiagnostic } from "./entry-payloads.js";
import type { ProgressHub } from "./progress.js";
import type { AssistantStopReason } from "./provider.js";
import {
  appendOperationFinished,
  appendOperationStarted,
  appendToolStarted,
  createOperationId,
  type OperationId,
  OperationIdSchema,
} from "./records.js";
import type { ToolBatchResult, ToolCall } from "./tool-batch.js";

interface ToolAbortState {
  readonly completed: ReadonlyMap<string, ToolBatchResult>;
  readonly finalized: boolean;
}

export interface TurnDurabilityHandle {
  /** Persisted toolCallIds deduplication — uninterruptible, mutex-serialized. */
  readonly appendToolResult: (
    result: ToolBatchResult,
    toolName: string,
  ) => Effect.Effect<boolean, JournalFailure>;
  /** Idempotent finalization for aborted turns — drains executingCalls via appendToolResult. */
  readonly finalizeAbortedTools: (
    executingCalls: ReadonlyArray<ToolCall> | undefined,
  ) => Effect.Effect<boolean, JournalFailure>;
  /** Begin operation — uninterruptible appendOperationStarted, idempotent. */
  readonly beginOperation: (promptEntryId: string) => Effect.Effect<void, JournalFailure>;
  /** Finish operation — idempotent appendOperationFinished (once per turn). */
  readonly finishOperation: (outcome: AssistantStopReason) => Effect.Effect<void, JournalFailure>;
  /** Append assistant message entry. */
  readonly appendAssistant: (
    content: string,
    stopReason: AssistantStopReason,
    diagnostic: AssistantDiagnostic | undefined,
  ) => Effect.Effect<import("@pop-eye/journal").Entry, JournalFailure>;
  /** Append steering user entries (sequential, with progress). */
  readonly appendSteering: (
    items: ReadonlyArray<{ readonly content: string }>,
  ) => Effect.Effect<void, JournalFailure>;
  /** Record tool start + progress. */
  readonly markToolStarted: (call: ToolCall, replay: string) => Effect.Effect<void, JournalFailure>;
  /** Current durable revision (countDurableLines). */
  readonly currentRevision: () => Effect.Effect<number, JournalFailure>;
  /** Expose operationId for span attributes. */
  readonly operationId: string;
  readonly turnOrdinal: number;
}

export interface TurnDurabilityOptions {
  readonly journal: JournalService;
  readonly progress: ProgressHub["Type"];
  readonly sessionId: SessionId;
  readonly operationId?: string;
  readonly turnOrdinal: number;
}

export const makeTurnDurabilityHandle = (
  options: TurnDurabilityOptions,
): Effect.Effect<TurnDurabilityHandle, never> =>
  Effect.gen(function* () {
    const { journal, progress, sessionId, turnOrdinal } = options;
    const rawId = options.operationId ?? (yield* createOperationId());
    const operationId = OperationIdSchema.make(rawId as unknown as string);
    const persistedToolCallIds = yield* Ref.make<Set<string>>(new Set());
    const persistenceMutex = yield* Effect.makeSemaphore(1);
    const abortState = yield* Ref.make<ToolAbortState>({
      completed: new Map(),
      finalized: false,
    });
    const operationFinished = yield* Ref.make(false);
    const operationRecorded = yield* Ref.make(false);

    const appendToolResult: TurnDurabilityHandle["appendToolResult"] = (result, toolName) =>
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

    const finalizeAbortedTools: TurnDurabilityHandle["finalizeAbortedTools"] = (executingCalls) =>
      Ref.modify(abortState, (current) => [
        current.finalized ? undefined : current.completed,
        { ...current, finalized: true },
      ]).pipe(
        Effect.flatMap((completed) =>
          completed !== undefined
            ? Effect.gen(function* () {
                if (executingCalls !== undefined) {
                  yield* Effect.forEach(
                    executingCalls,
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

    const beginOperation: TurnDurabilityHandle["beginOperation"] = (promptEntryId) =>
      Effect.uninterruptible(
        appendOperationStarted(journal, sessionId, {
          intent: "turn",
          operationId,
          promptEntryId: promptEntryId as unknown as import("@pop-eye/journal").EntryId,
          turnOrdinal,
        }).pipe(Effect.zipRight(Ref.set(operationRecorded, true))),
      );

    const finishOperation: TurnDurabilityHandle["finishOperation"] = (outcome) =>
      Effect.gen(function* () {
        const shouldFinish =
          (yield* Ref.get(operationRecorded)) && !(yield* Ref.getAndSet(operationFinished, true));
        if (shouldFinish) {
          yield* appendOperationFinished(journal, sessionId, {
            operationId,
            outcome,
          });
        }
      });

    const appendAssistant: TurnDurabilityHandle["appendAssistant"] = (
      content,
      stopReason,
      diagnostic,
    ) =>
      journal.appendEntry(
        sessionId,
        EntryDraftSchema.make({
          kind: "message",
          payload:
            diagnostic === undefined
              ? {
                  content,
                  role: "assistant",
                  stopReason,
                }
              : {
                  content,
                  diagnostic,
                  role: "assistant",
                  stopReason,
                },
        }),
      );

    const appendSteering: TurnDurabilityHandle["appendSteering"] = (items) =>
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
      ).pipe(Effect.asVoid);

    const markToolStarted: TurnDurabilityHandle["markToolStarted"] = (call, replay) =>
      appendToolStarted(journal, sessionId, {
        operationId,
        replay: replay as "never" | "safe",
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

    const currentRevision: TurnDurabilityHandle["currentRevision"] = () =>
      journal.countDurableLines(sessionId).pipe(Effect.catchAll(() => Effect.succeed(0)));

    // Expose abortState completion recording for TurnOrchestrator's onToolCompleted
    const recordToolCompleted = (result: ToolBatchResult): Effect.Effect<boolean, never> =>
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
      );

    return {
      appendAssistant,
      appendSteering,
      appendToolResult,
      beginOperation,
      currentRevision,
      finalizeAbortedTools,
      finishOperation,
      markToolStarted: markToolStarted as TurnDurabilityHandle["markToolStarted"],
      operationId,
      turnOrdinal,
      // internal helper exposed for onToolCompleted path
      recordToolCompleted,
    } as unknown as TurnDurabilityHandle & {
      readonly recordToolCompleted: (r: ToolBatchResult) => Effect.Effect<boolean>;
    };
  });

// Test helper — FakeTurnDurability over in-memory commit log without Journal I/O
export const makeFakeTurnDurabilityHandle = (options: {
  readonly sessionId: SessionId;
  readonly operationId?: OperationId;
  readonly turnOrdinal?: number;
}): Effect.Effect<
  TurnDurabilityHandle & {
    readonly committedToolResults: ReadonlyArray<ToolBatchResult>;
    readonly committedAssistant: ReadonlyArray<string>;
  },
  never
> =>
  Effect.gen(function* () {
    const operationId = (options.operationId as unknown as string) ?? "fake-operation";
    const turnOrdinal = options.turnOrdinal ?? 1;
    const toolResults: Array<ToolBatchResult> = [];
    const assistant: Array<string> = [];
    const persisted = new Set<string>();
    const handle: TurnDurabilityHandle = {
      appendAssistant: (content) =>
        Effect.sync(() => {
          assistant.push(content);
          return { id: `fake-${assistant.length}` } as unknown as import("@pop-eye/journal").Entry;
        }),
      appendSteering: () => Effect.void,
      appendToolResult: (result) =>
        Effect.sync(() => {
          if (persisted.has(result.toolCallId)) return false;
          persisted.add(result.toolCallId);
          toolResults.push(result);
          return true;
        }),
      beginOperation: () => Effect.void,
      currentRevision: () => Effect.succeed(toolResults.length + assistant.length),
      finalizeAbortedTools: () => Effect.succeed(false),
      finishOperation: () => Effect.void,
      markToolStarted: () => Effect.void,
      operationId,
      turnOrdinal,
    };
    return Object.assign(handle, {
      committedAssistant: assistant,
      committedToolResults: toolResults,
    });
  });
