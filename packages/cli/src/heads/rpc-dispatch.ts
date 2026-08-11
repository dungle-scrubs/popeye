/**
 * Owns RPC dispatch policy and serialized output independently of protocol command routing.
 * Session workers preserve FIFO order, the sessionless worker preserves connection-level order, and
 * control handlers bypass both. Interrupting an interruptible write releases its permit after
 * interruption finalizers run. An explicitly uninterruptible write keeps its permit until it
 * completes or reaches an interruptible region.
 */

import type { Scope } from "effect";
import { Cause, Data, Deferred, Effect, Fiber, FiberSet, Queue, Ref } from "effect";

import type { HeadWriteError, HeadWriter } from "./shared.js";

export const RPC_CONTROL_FORK_CAPACITY = 64;
export const RPC_SESSION_MAP_CAPACITY = 1_024;
export const RPC_SESSION_QUEUE_CAPACITY = 64;
export const RPC_SESSIONLESS_QUEUE_CAPACITY = 64;

export type RpcDispatchBound =
  | "control_forks"
  | "session_map"
  | "session_queue"
  | "sessionless_queue";

export class RpcDispatchBoundExceeded extends Data.TaggedError("RpcDispatchBoundExceeded")<{
  readonly bound: RpcDispatchBound;
  readonly limit: number;
  readonly message: string;
}> {}

export interface RpcDispatchContext {
  readonly bypass: boolean;
  readonly queueDepth: number;
  readonly session: string;
}

export type RpcDispatchRoute =
  | { readonly _tag: "control" }
  | { readonly _tag: "session"; readonly sessionId: string }
  | { readonly _tag: "sessionless" };

export interface RpcDispatchFrame {
  readonly eofBehavior: "drain" | "interrupt";
  readonly onBoundExceeded: (
    error: RpcDispatchBoundExceeded,
    context: RpcDispatchContext,
  ) => Effect.Effect<void, HeadWriteError>;
  readonly route: RpcDispatchRoute;
  readonly run: (context: RpcDispatchContext) => Effect.Effect<void, unknown>;
}

export interface RpcDispatcher {
  readonly awaitIdle: Effect.Effect<void>;
  readonly dispatch: (frame: RpcDispatchFrame) => Effect.Effect<void, HeadWriteError>;
  readonly finish: Effect.Effect<void>;
}

interface SessionQueue {
  readonly queue: Queue.Queue<QueuedFrame>;
}

interface QueuedFrame {
  readonly context: RpcDispatchContext;
  readonly frame: RpcDispatchFrame;
}

interface InFlightState {
  readonly count: number;
  readonly idle: Deferred.Deferred<void>;
}

export const makeRpcDispatcher = (
  writer: Pick<SerializedHeadWriter, "checkPoisoned">,
): Effect.Effect<RpcDispatcher, never, Scope.Scope> =>
  Effect.gen(function* () {
    const queueWorkers = yield* FiberSet.make<void, unknown>();
    const controlHandlers = yield* FiberSet.make<void, unknown>();
    const interruptibleHandlers = yield* FiberSet.make<void, unknown>();
    const sessionQueues = new Map<string, SessionQueue>();
    const sessionlessQueue = yield* Queue.dropping<QueuedFrame>(RPC_SESSIONLESS_QUEUE_CAPACITY);
    const controlForks = yield* Ref.make(0);
    const initiallyIdle = yield* Deferred.make<void>();
    yield* Deferred.succeed(initiallyIdle, undefined);
    const inFlight = yield* Ref.make<InFlightState>({ count: 0, idle: initiallyIdle });
    const closing = yield* Ref.make(false);
    const lifecycle = yield* Effect.makeSemaphore(1);

    const admit = Effect.gen(function* () {
      const nextIdle = yield* Deferred.make<void>();
      yield* Ref.update(inFlight, (current) => ({
        count: current.count + 1,
        idle: current.count === 0 ? nextIdle : current.idle,
      }));
    });

    const complete = Ref.modify(inFlight, (current) => {
      const count = current.count - 1;
      return [count === 0 ? current.idle : undefined, { ...current, count }];
    }).pipe(
      Effect.flatMap((idle) =>
        idle === undefined ? Effect.void : Deferred.succeed(idle, undefined).pipe(Effect.asVoid),
      ),
    );

    const runFrame = (
      frame: RpcDispatchFrame,
      context: RpcDispatchContext,
    ): Effect.Effect<void, unknown> => frame.run(context).pipe(Effect.ensuring(complete));

    const runInterruptibleFrame = (
      frame: RpcDispatchFrame,
      context: RpcDispatchContext,
    ): Effect.Effect<void, unknown> =>
      lifecycle
        .withPermits(1)(
          Ref.get(closing).pipe(
            Effect.flatMap((isClosing) =>
              isClosing
                ? complete.pipe(Effect.as(undefined))
                : FiberSet.run(interruptibleHandlers, runFrame(frame, context)).pipe(
                    Effect.map((fiber) => fiber as Fiber.RuntimeFiber<void, unknown> | undefined),
                  ),
            ),
          ),
        )
        .pipe(
          Effect.flatMap((fiber) =>
            fiber === undefined
              ? Effect.void
              : Fiber.join(fiber).pipe(
                  Effect.catchAllCause((cause) =>
                    Cause.isInterruptedOnly(cause) ? Effect.void : Effect.failCause(cause),
                  ),
                ),
          ),
        );

    const runQueuedFrame = (queue: Queue.Queue<QueuedFrame>): Effect.Effect<never, unknown> =>
      Effect.forever(
        Queue.take(queue).pipe(
          Effect.flatMap(({ context, frame }) =>
            (frame.eofBehavior === "interrupt"
              ? runInterruptibleFrame(frame, context)
              : runFrame(frame, context)
            ).pipe(
              Effect.catchAllCause((cause) =>
                Cause.isInterruptedOnly(cause)
                  ? Effect.void
                  : Effect.logWarning("RPC dispatch worker recovered from a frame failure.").pipe(
                      Effect.annotateLogs({
                        cause: Cause.pretty(cause),
                        session: context.session,
                      }),
                    ),
              ),
            ),
          ),
        ),
      );

    yield* FiberSet.run(queueWorkers, runQueuedFrame(sessionlessQueue));

    const sessionQueue = (sessionId: string): Effect.Effect<SessionQueue> =>
      Effect.gen(function* () {
        const existing = sessionQueues.get(sessionId);
        if (existing !== undefined) {
          return existing;
        }
        const queue = yield* Queue.dropping<QueuedFrame>(RPC_SESSION_QUEUE_CAPACITY);
        const created = { queue } satisfies SessionQueue;
        sessionQueues.set(sessionId, created);
        yield* FiberSet.run(queueWorkers, runQueuedFrame(queue));
        return created;
      });

    const reject = (
      frame: RpcDispatchFrame,
      error: RpcDispatchBoundExceeded,
      context: RpcDispatchContext,
    ): Effect.Effect<void, HeadWriteError> =>
      Effect.logWarning("RPC dispatch bound exceeded.").pipe(
        Effect.annotateLogs({ bound: error.bound, limit: error.limit }),
        Effect.zipRight(frame.onBoundExceeded(error, context)),
      );

    const offer = (
      queue: Queue.Queue<QueuedFrame>,
      frame: RpcDispatchFrame,
      session: string,
      bound: RpcDispatchBound,
      limit: number,
    ): Effect.Effect<void, HeadWriteError> =>
      Effect.gen(function* () {
        const queueDepth = Math.max(0, yield* Queue.size(queue));
        const context = { bypass: false, queueDepth, session };
        yield* admit;
        const accepted = yield* Queue.offer(queue, { context, frame });
        if (accepted) {
          return;
        }
        yield* complete;
        const error = new RpcDispatchBoundExceeded({
          bound,
          limit,
          message: `RPC ${bound} bound exceeded its limit of ${limit}.`,
        });
        yield* reject(frame, error, { ...context, queueDepth: limit });
      });

    const awaitIdle = Effect.suspend(function waitForIdle(): Effect.Effect<void> {
      return Ref.get(inFlight).pipe(
        Effect.flatMap((current) => Deferred.await(current.idle)),
        Effect.zipRight(Ref.get(inFlight)),
        Effect.flatMap((current) =>
          current.count === 0 ? Effect.void : Effect.suspend(waitForIdle),
        ),
      );
    });

    return {
      awaitIdle,
      dispatch: (frame) =>
        writer.checkPoisoned.pipe(
          Effect.zipRight(
            Effect.suspend(() => {
              if (frame.route._tag === "control") {
                return Effect.gen(function* () {
                  const admitted = yield* Ref.modify(controlForks, (current) =>
                    current >= RPC_CONTROL_FORK_CAPACITY ? [false, current] : [true, current + 1],
                  );
                  const context = { bypass: true, queueDepth: 0, session: "control" };
                  if (!admitted) {
                    const error = new RpcDispatchBoundExceeded({
                      bound: "control_forks",
                      limit: RPC_CONTROL_FORK_CAPACITY,
                      message: `RPC control_forks bound exceeded its limit of ${RPC_CONTROL_FORK_CAPACITY}.`,
                    });
                    return yield* reject(frame, error, context);
                  }
                  yield* admit;
                  yield* FiberSet.run(
                    controlHandlers,
                    runFrame(frame, context).pipe(
                      Effect.ensuring(Ref.update(controlForks, (current) => current - 1)),
                    ),
                  );
                });
              }
              if (frame.route._tag === "sessionless") {
                return offer(
                  sessionlessQueue,
                  frame,
                  "sessionless",
                  "sessionless_queue",
                  RPC_SESSIONLESS_QUEUE_CAPACITY,
                );
              }
              const sessionId = frame.route.sessionId;
              const existing = sessionQueues.get(sessionId);
              if (existing !== undefined) {
                return offer(
                  existing.queue,
                  frame,
                  sessionId,
                  "session_queue",
                  RPC_SESSION_QUEUE_CAPACITY,
                );
              }
              if (sessionQueues.size >= RPC_SESSION_MAP_CAPACITY) {
                const error = new RpcDispatchBoundExceeded({
                  bound: "session_map",
                  limit: RPC_SESSION_MAP_CAPACITY,
                  message: `RPC session_map bound exceeded its limit of ${RPC_SESSION_MAP_CAPACITY}.`,
                });
                return reject(frame, error, {
                  bypass: false,
                  queueDepth: RPC_SESSION_MAP_CAPACITY,
                  session: sessionId,
                });
              }
              return sessionQueue(sessionId).pipe(
                Effect.flatMap(({ queue }) =>
                  offer(queue, frame, sessionId, "session_queue", RPC_SESSION_QUEUE_CAPACITY),
                ),
              );
            }),
          ),
        ),
      finish: lifecycle
        .withPermits(1)(
          Ref.set(closing, true).pipe(
            Effect.zipRight(
              Effect.all([FiberSet.clear(controlHandlers), FiberSet.clear(interruptibleHandlers)], {
                discard: true,
              }),
            ),
          ),
        )
        .pipe(Effect.zipRight(awaitIdle)),
    };
  });

export interface SerializedHeadWriter extends HeadWriter {
  readonly checkPoisoned: Effect.Effect<void, HeadWriteError>;
  readonly failure: Effect.Effect<never, HeadWriteError>;
  readonly poisoned: Effect.Effect<boolean>;
}

export const serializedWriter = (writer: HeadWriter): Effect.Effect<SerializedHeadWriter> =>
  Effect.gen(function* () {
    const fatal = yield* Deferred.make<never, HeadWriteError>();
    const poison = yield* Ref.make<HeadWriteError | undefined>(undefined);
    const semaphore = yield* Effect.makeSemaphore(1);

    return {
      checkPoisoned: Ref.get(poison).pipe(
        Effect.flatMap((failure) => (failure === undefined ? Effect.void : Effect.fail(failure))),
      ),
      failure: Deferred.await(fatal),
      poisoned: Ref.get(poison).pipe(Effect.map((error) => error !== undefined)),
      write: (text) =>
        semaphore.withPermits(1)(
          Effect.gen(function* () {
            const failure = yield* Ref.get(poison);
            if (failure !== undefined) {
              return yield* Effect.fail(failure);
            }
            return yield* writer
              .write(text)
              .pipe(
                Effect.tapError((error) =>
                  Ref.set(poison, error).pipe(
                    Effect.zipRight(Deferred.fail(fatal, error)),
                    Effect.asVoid,
                    Effect.uninterruptible,
                  ),
                ),
              );
          }),
        ),
    };
  });
