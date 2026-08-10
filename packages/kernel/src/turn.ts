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
import { Cause, Context, Effect, Exit, Fiber, Layer, Ref, Schedule, Stream } from "effect";

import { BudgetExceeded, type ProviderError } from "./errors.js";
import { Mailbox, type MailboxFailure } from "./mailbox.js";
import { type Progress, ProgressHub, ProgressHubLive, type TurnPhase } from "./progress.js";
import { type AssistantStopReason, Provider } from "./provider.js";

export interface TurnOptions {
  readonly contextBudget?: number;
  readonly maxAttempts?: number;
}

export interface TurnResult {
  readonly stopReason: AssistantStopReason;
}

export type TurnFailure = JournalFailure | MailboxFailure;

export interface TurnsService {
  readonly abortTurn: (sessionId: SessionId) => Effect.Effect<void>;
  readonly runTurn: (
    sessionId: SessionId,
    content: string,
    options?: TurnOptions,
  ) => Effect.Effect<TurnResult, TurnFailure>;
  readonly subscribeProgress: (sessionId: SessionId) => Stream.Stream<Progress>;
}

export class Turns extends Context.Tag("@peye/kernel/Turns")<Turns, TurnsService>() {}

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

export const TurnsLive = (): Layer.Layer<Turns, never, Journal | Mailbox | Provider> =>
  Layer.effect(
    Turns,
    Effect.gen(function* () {
      const journal = yield* Journal;
      const mailbox = yield* Mailbox;
      const provider = yield* Provider;
      const progress = yield* ProgressHub;
      const active = yield* Ref.make<Map<SessionId, Fiber.Fiber<void, ProviderError>>>(new Map());
      const execute = (
        sessionId: SessionId,
        content: string,
        options: TurnOptions,
      ): Effect.Effect<TurnResult, JournalFailure> =>
        Effect.gen(function* () {
          const priorBranch = yield* journal.readBranch(sessionId);
          const turnOrdinal =
            priorBranch.filter((entry) => asContextItem(entry)?.role === "assistant").length + 1;
          const user = yield* journal.appendEntry(
            sessionId,
            EntryDraftSchema.make({ kind: "message", payload: { content, role: "user" } }),
          );
          yield* Effect.annotateCurrentSpan({ sessionId, turnOrdinal, userEntryId: user.id });
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
          const attempts = yield* Ref.make(0);
          const text = yield* Ref.make("");
          const stopReason = yield* Ref.make<AssistantStopReason>("done");
          const consume: Effect.Effect<void, ProviderError> = Effect.suspend(
            (): Effect.Effect<void, ProviderError> =>
              Ref.updateAndGet(attempts, (attempt) => attempt + 1).pipe(
                Effect.flatMap((attempt) =>
                  Effect.annotateCurrentSpan({ attempt }).pipe(
                    Effect.zipRight(
                      Stream.runForEach(
                        provider.streamAssistant(context.items, { turnOrdinal }),
                        (item) => {
                          if (item._tag === "textDelta") {
                            return Ref.update(text, (current) => current + item.text).pipe(
                              Effect.zipRight(
                                progress.publish(sessionId, {
                                  _tag: "assistantText",
                                  text: item.text,
                                }),
                              ),
                            );
                          }
                          if (item._tag === "thinkingDelta") {
                            return progress.publish(sessionId, {
                              _tag: "assistantThinking",
                              text: item.text,
                            });
                          }
                          return Ref.set(stopReason, item.stopReason);
                        },
                      ),
                    ),
                  ),
                ),
              ),
          );
          const child = yield* Effect.fork(
            Effect.interruptible(
              consume.pipe(
                Effect.retry(
                  Schedule.recurs((options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS) - 1).pipe(
                    Schedule.whileInput((error: ProviderError) => error.transient),
                  ),
                ),
              ),
            ),
          );
          yield* Ref.update(active, (current) => new Map(current).set(sessionId, child));
          const streamExit = yield* Fiber.await(child);
          yield* Ref.update(active, (current) => {
            const next = new Map(current);
            next.delete(sessionId);
            return next;
          });
          const interrupted =
            Exit.isFailure(streamExit) && Cause.isInterruptedOnly(streamExit.cause);
          const reason = interrupted
            ? "aborted"
            : Exit.isFailure(streamExit)
              ? "error"
              : yield* Ref.get(stopReason);
          yield* phaseChanged(progress, sessionId, "SETTLING");
          const assistant = yield* journal.appendEntry(
            sessionId,
            EntryDraftSchema.make({
              kind: "message",
              payload: { content: yield* Ref.get(text), role: "assistant", stopReason: reason },
            }),
          );
          const revision = yield* journal.countDurableLines(sessionId);
          yield* progress.publish(sessionId, { _tag: "turnSettled", revision, stopReason: reason });
          yield* phaseChanged(progress, sessionId, "IDLE");
          yield* Effect.annotateCurrentSpan({ assistantEntryId: assistant.id, stopReason: reason });
          return { stopReason: reason };
        }).pipe(
          Effect.catchTag("BudgetExceeded", (error) =>
            phaseChanged(progress, sessionId, "SETTLING").pipe(
              Effect.zipRight(
                journal.appendEntry(
                  sessionId,
                  EntryDraftSchema.make({
                    kind: "message",
                    payload: { content: error.message, role: "assistant", stopReason: "error" },
                  }),
                ),
              ),
              Effect.zipRight(phaseChanged(progress, sessionId, "IDLE")),
              Effect.as({ stopReason: "error" as const }),
            ),
          ),
        );

      return {
        abortTurn: (sessionId: SessionId) =>
          Ref.get(active).pipe(
            Effect.flatMap((current) => {
              const child = current.get(sessionId);
              return child === undefined ? Effect.void : Fiber.interrupt(child).pipe(Effect.asVoid);
            }),
          ),
        runTurn: (sessionId: SessionId, content: string, options: TurnOptions = {}) =>
          mailbox
            .enqueue(sessionId, {
              name: "turn",
              run: () =>
                execute(sessionId, content, options).pipe(
                  Effect.withSpan("kernel.turn", { attributes: { sessionId } }),
                ),
            })
            .pipe(Effect.map((result) => result.value)),
        subscribeProgress: (sessionId: SessionId) => progress.subscribe(sessionId),
      } satisfies TurnsService;
    }),
  ).pipe(Layer.provide(ProgressHubLive()));
