/**
 * Owns ephemeral per-subscriber turn hints and their bounded delivery policy.
 * It exists so slow heads cannot block durable journal work or become snapshot input.
 */

import { EntryIdSchema, type SessionId } from "@peye/journal";
import { Context, Effect, Layer, Queue, Ref, Schema, Stream } from "effect";

export const TurnPhaseSchema = Schema.Literal(
  "ASSEMBLING",
  "EXECUTING",
  "IDLE",
  "SETTLING",
  "STREAMING",
);

export type TurnPhase = Schema.Schema.Type<typeof TurnPhaseSchema>;

export const ProgressSchema = Schema.Union(
  Schema.TaggedStruct("assistantText", { text: Schema.String }),
  Schema.TaggedStruct("assistantThinking", { text: Schema.String }),
  Schema.TaggedStruct("compactionApplied", {
    compactionEntryId: EntryIdSchema,
    entriesCovered: Schema.Number.pipe(Schema.int(), Schema.positive()),
    sliceCount: Schema.Number.pipe(Schema.int(), Schema.positive()),
    summaryLength: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  }),
  Schema.TaggedStruct("compactionStarted", {
    entriesCovered: Schema.Number.pipe(Schema.int(), Schema.positive()),
    sliceCount: Schema.Number.pipe(Schema.int(), Schema.positive()),
  }),
  Schema.TaggedStruct("followUpQueued", { content: Schema.String }),
  Schema.TaggedStruct("phaseChanged", { phase: TurnPhaseSchema }),
  Schema.TaggedStruct("progressDropped", { count: Schema.Number }),
  Schema.TaggedStruct("providerRetryScheduled", {
    attempt: Schema.Number,
    delayMs: Schema.Number,
  }),
  Schema.TaggedStruct("steeringApplied", { content: Schema.String }),
  Schema.TaggedStruct("steeringQueued", { content: Schema.String }),
  Schema.TaggedStruct("turnQueued", { content: Schema.String }),
  Schema.TaggedStruct("toolCompleted", {
    isError: Schema.Boolean,
    toolCallId: Schema.String,
  }),
  Schema.TaggedStruct("toolStarted", {
    name: Schema.String,
    toolCallId: Schema.String,
  }),
  Schema.TaggedStruct("turnSettled", {
    revision: Schema.Number,
    stopReason: Schema.Literal("aborted", "done", "error", "toolCalls", "truncated"),
  }),
);

export type Progress = Schema.Schema.Type<typeof ProgressSchema>;

export const PROGRESS_CAPACITY = 64;

interface Subscriber {
  readonly dropped: Ref.Ref<number>;
  readonly queue: Queue.Queue<Progress>;
}

interface ProgressState {
  readonly phases: Map<SessionId, TurnPhase>;
  readonly subscribers: Map<SessionId, Set<Subscriber>>;
}

export interface ProgressService {
  readonly currentPhase: (sessionId: SessionId) => Effect.Effect<TurnPhase>;
  readonly publish: (sessionId: SessionId, progress: Progress) => Effect.Effect<void>;
  readonly subscribe: (sessionId: SessionId) => Stream.Stream<Progress>;
}

export class ProgressHub extends Context.Tag("@peye/kernel/ProgressHub")<
  ProgressHub,
  ProgressService
>() {}

const removeSubscriber = (
  state: Ref.Ref<ProgressState>,
  sessionId: SessionId,
  subscriber: Subscriber,
): Effect.Effect<void> =>
  Ref.update(state, (current) => {
    const subscribers = new Map(current.subscribers);
    const sessionSubscribers = subscribers.get(sessionId);
    if (sessionSubscribers !== undefined) {
      const next = new Set(sessionSubscribers);
      next.delete(subscriber);
      if (next.size === 0) {
        subscribers.delete(sessionId);
      } else {
        subscribers.set(sessionId, next);
      }
    }
    return { ...current, subscribers };
  });

export const ProgressHubLive = (capacity = PROGRESS_CAPACITY): Layer.Layer<ProgressHub> => {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError("Progress capacity must be a positive safe integer.");
  }
  return Layer.effect(
    ProgressHub,
    Effect.gen(function* () {
      const state = yield* Ref.make<ProgressState>({ phases: new Map(), subscribers: new Map() });
      const publish = (sessionId: SessionId, progress: Progress): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (progress._tag === "phaseChanged") {
            yield* Ref.update(state, (current) => {
              const phases = new Map(current.phases);
              phases.set(sessionId, progress.phase);
              return { ...current, phases };
            });
          }
          const subscribers = yield* Ref.get(state).pipe(
            Effect.map((current) => [...(current.subscribers.get(sessionId) ?? [])]),
          );
          yield* Effect.forEach(subscribers, (subscriber) =>
            Queue.size(subscriber.queue).pipe(
              Effect.flatMap((size) =>
                (size >= capacity
                  ? Ref.update(subscriber.dropped, (count) => count + 1)
                  : Effect.void
                ).pipe(
                  Effect.zipRight(Queue.offer(subscriber.queue, progress).pipe(Effect.asVoid)),
                ),
              ),
            ),
          );
        });
      const currentPhase = (sessionId: SessionId): Effect.Effect<TurnPhase> =>
        Ref.get(state).pipe(Effect.map((current) => current.phases.get(sessionId) ?? "IDLE"));
      const subscribe = (sessionId: SessionId): Stream.Stream<Progress> =>
        Stream.unwrapScoped(
          Effect.acquireRelease(
            Effect.gen(function* () {
              const subscriber: Subscriber = {
                dropped: yield* Ref.make(0),
                queue: yield* Queue.sliding<Progress>(capacity),
              };
              const phase = yield* currentPhase(sessionId);
              yield* Ref.update(state, (current) => {
                const subscribers = new Map(current.subscribers);
                const sessionSubscribers = new Set(subscribers.get(sessionId) ?? []);
                sessionSubscribers.add(subscriber);
                subscribers.set(sessionId, sessionSubscribers);
                return { ...current, subscribers };
              });
              yield* Queue.offer(subscriber.queue, { _tag: "phaseChanged", phase });
              return subscriber;
            }),
            (subscriber) =>
              removeSubscriber(state, sessionId, subscriber).pipe(
                Effect.zipRight(Queue.shutdown(subscriber.queue)),
              ),
          ).pipe(
            Effect.map((subscriber) =>
              Stream.fromQueue(subscriber.queue).pipe(
                Stream.mapEffect((progress) =>
                  Ref.getAndSet(subscriber.dropped, 0).pipe(
                    Effect.map((dropped) => ({ dropped, progress })),
                  ),
                ),
                Stream.flatMap((queued) =>
                  queued.dropped === 0
                    ? Stream.succeed(queued.progress)
                    : Stream.fromIterable([
                        { _tag: "progressDropped" as const, count: queued.dropped },
                        queued.progress,
                      ]),
                ),
              ),
            ),
          ),
        );
      return { currentPhase, publish, subscribe } satisfies ProgressService;
    }),
  );
};
