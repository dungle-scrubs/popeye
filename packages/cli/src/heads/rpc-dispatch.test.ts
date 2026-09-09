import { Deferred, Effect, Exit, Fiber } from "effect";
import { expect, test } from "vitest";
import { HeadWriteError, type HeadWriter } from "./head-wire.js";
import {
  makeRpcDispatcher,
  RPC_CONTROL_FORK_CAPACITY,
  RPC_SESSION_QUEUE_CAPACITY,
  RPC_SESSIONLESS_QUEUE_CAPACITY,
  serializedWriter,
} from "./rpc-dispatch.js";

const healthyWriterState = { checkPoisoned: Effect.void };

test("session handlers run in stdin order even when the first handler stalls", async () => {
  const events: Array<string> = [];

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondFinished = yield* Deferred.make<void>();
        const dispatcher = yield* makeRpcDispatcher(healthyWriterState);

        yield* dispatcher.dispatch({
          eofBehavior: "drain",
          onBoundExceeded: () => Effect.die("The session queue unexpectedly overflowed."),
          route: { _tag: "session", sessionId: "session-a" },
          run: () =>
            Effect.sync(() => void events.push("first:start")).pipe(
              Effect.zipRight(Deferred.succeed(firstStarted, undefined)),
              Effect.zipRight(Deferred.await(releaseFirst)),
              Effect.zipRight(Effect.sync(() => void events.push("first:end"))),
            ),
        });
        yield* Deferred.await(firstStarted);
        yield* dispatcher.dispatch({
          eofBehavior: "drain",
          onBoundExceeded: () => Effect.die("The session queue unexpectedly overflowed."),
          route: { _tag: "session", sessionId: "session-a" },
          run: () =>
            Effect.sync(() => void events.push("second")).pipe(
              Effect.zipRight(Deferred.succeed(secondFinished, undefined)),
            ),
        });

        yield* Effect.yieldNow();
        yield* Effect.yieldNow();
        expect(events).toEqual(["first:start"]);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondFinished);
      }),
    ),
  );

  expect(events).toEqual(["first:start", "first:end", "second"]);
});

test("a failed session handler does not stop later frames on the same queue", async () => {
  const failure = new HeadWriteError({
    cause: new Error("sink closed"),
    message: "Head output failed: sink closed",
  });

  const secondRan = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const secondFinished = yield* Deferred.make<void>();
        const dispatcher = yield* makeRpcDispatcher(healthyWriterState);

        yield* dispatcher.dispatch({
          eofBehavior: "drain",
          onBoundExceeded: () => Effect.die("The session queue unexpectedly overflowed."),
          route: { _tag: "session", sessionId: "session-after-failure" },
          run: () => Effect.fail(failure),
        });
        yield* dispatcher.dispatch({
          eofBehavior: "drain",
          onBoundExceeded: () => Effect.die("The session queue unexpectedly overflowed."),
          route: { _tag: "session", sessionId: "session-after-failure" },
          run: () => Deferred.succeed(secondFinished, undefined).pipe(Effect.asVoid),
        });

        return yield* Effect.raceFirst(
          Deferred.await(secondFinished).pipe(Effect.as(true)),
          Effect.sleep("50 millis").pipe(Effect.as(false)),
        );
      }),
    ),
  );

  expect(secondRan).toBe(true);
});

test("sessionless create and list handlers preserve stdin order", async () => {
  const events: Array<string> = [];

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const createStarted = yield* Deferred.make<void>();
        const releaseCreate = yield* Deferred.make<void>();
        const listFinished = yield* Deferred.make<void>();
        const dispatcher = yield* makeRpcDispatcher(healthyWriterState);

        yield* dispatcher.dispatch({
          eofBehavior: "drain",
          onBoundExceeded: () => Effect.die("The sessionless queue unexpectedly overflowed."),
          route: { _tag: "sessionless" },
          run: () =>
            Effect.sync(() => void events.push("create:start")).pipe(
              Effect.zipRight(Deferred.succeed(createStarted, undefined)),
              Effect.zipRight(Deferred.await(releaseCreate)),
              Effect.zipRight(Effect.sync(() => void events.push("create:end"))),
            ),
        });
        yield* Deferred.await(createStarted);
        yield* dispatcher.dispatch({
          eofBehavior: "drain",
          onBoundExceeded: () => Effect.die("The sessionless queue unexpectedly overflowed."),
          route: { _tag: "sessionless" },
          run: () =>
            Effect.sync(() => void events.push("list")).pipe(
              Effect.zipRight(Deferred.succeed(listFinished, undefined)),
            ),
        });

        yield* Effect.yieldNow();
        yield* Effect.yieldNow();
        expect(events).toEqual(["create:start"]);
        yield* Deferred.succeed(releaseCreate, undefined);
        yield* Deferred.await(listFinished);
      }),
    ),
  );

  expect(events).toEqual(["create:start", "create:end", "list"]);
});

test("a full session queue rejects only the excess frame and preserves accepted work", async () => {
  const completed: Array<number> = [];

  const rejection = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const acceptedFinished = yield* Deferred.make<void>();
        const rejected = yield* Deferred.make<unknown>();
        const dispatcher = yield* makeRpcDispatcher(healthyWriterState);
        const capacity = RPC_SESSION_QUEUE_CAPACITY ?? 64;

        yield* dispatcher.dispatch({
          eofBehavior: "drain",
          onBoundExceeded: (error) => Deferred.succeed(rejected, error).pipe(Effect.asVoid),
          route: { _tag: "session", sessionId: "session-bounded" },
          run: () =>
            Deferred.succeed(firstStarted, undefined).pipe(
              Effect.zipRight(Deferred.await(releaseFirst)),
            ),
        });
        yield* Deferred.await(firstStarted);
        yield* Effect.forEach(
          Array.from({ length: capacity }, (_, index) => index),
          (index) =>
            dispatcher.dispatch({
              eofBehavior: "drain",
              onBoundExceeded: (error) => Deferred.succeed(rejected, error).pipe(Effect.asVoid),
              route: { _tag: "session", sessionId: "session-bounded" },
              run: () =>
                Effect.sync(() => void completed.push(index)).pipe(
                  Effect.zipRight(
                    index === capacity - 1
                      ? Deferred.succeed(acceptedFinished, undefined)
                      : Effect.void,
                  ),
                ),
            }),
          { discard: true },
        );
        yield* dispatcher.dispatch({
          eofBehavior: "drain",
          onBoundExceeded: (error) => Deferred.succeed(rejected, error).pipe(Effect.asVoid),
          route: { _tag: "session", sessionId: "session-bounded" },
          run: () => Effect.sync(() => void completed.push(capacity)),
        });
        const result = yield* Effect.raceFirst(
          Deferred.await(rejected).pipe(Effect.map((error) => error as unknown | undefined)),
          Effect.sleep("50 millis").pipe(Effect.as(undefined)),
        );
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(acceptedFinished);
        return result;
      }),
    ),
  );

  expect(RPC_SESSION_QUEUE_CAPACITY).toBe(64);
  expect(rejection).toMatchObject({ bound: "session_queue", limit: 64 });
  expect(completed).toEqual(Array.from({ length: 64 }, (_, index) => index));
});

test("the session map rejects new sessions at capacity while existing queues keep running", async () => {
  const sessionMapCapacity = 1_024;
  let existingRuns = 0;
  let overflowRuns = 0;

  const rejection = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const rejected = yield* Deferred.make<unknown>();
        const dispatcher = yield* makeRpcDispatcher(healthyWriterState);

        yield* Effect.forEach(
          Array.from({ length: sessionMapCapacity }, (_, index) => index),
          (index) =>
            dispatcher.dispatch({
              eofBehavior: "drain",
              onBoundExceeded: () => Effect.die("The session map unexpectedly overflowed."),
              route: { _tag: "session", sessionId: `session-map-${index}` },
              run: () => Effect.void,
            }),
          { discard: true },
        );
        yield* dispatcher.awaitIdle;

        yield* dispatcher.dispatch({
          eofBehavior: "drain",
          onBoundExceeded: (error) => Deferred.succeed(rejected, error).pipe(Effect.asVoid),
          route: { _tag: "session", sessionId: "session-map-overflow" },
          run: () =>
            Effect.sync(() => {
              overflowRuns += 1;
            }),
        });
        const result = yield* Effect.raceFirst(
          Deferred.await(rejected).pipe(Effect.map((error) => error as unknown | undefined)),
          Effect.sleep("100 millis").pipe(Effect.as(undefined)),
        );

        yield* dispatcher.dispatch({
          eofBehavior: "drain",
          onBoundExceeded: () => Effect.die("An existing session queue was rejected."),
          route: { _tag: "session", sessionId: "session-map-0" },
          run: () =>
            Effect.sync(() => {
              existingRuns += 1;
            }),
        });
        yield* dispatcher.awaitIdle;
        return result;
      }),
    ),
  );

  expect(rejection).toMatchObject({ bound: "session_map", limit: 1_024 });
  expect(existingRuns).toBe(1);
  expect(overflowRuns).toBe(0);
});

test("a full sessionless queue rejects only the excess frame", async () => {
  let completed = 0;

  const rejection = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const acceptedFinished = yield* Deferred.make<void>();
        const rejected = yield* Deferred.make<unknown>();
        const dispatcher = yield* makeRpcDispatcher(healthyWriterState);

        yield* dispatcher.dispatch({
          eofBehavior: "drain",
          onBoundExceeded: (error) => Deferred.succeed(rejected, error).pipe(Effect.asVoid),
          route: { _tag: "sessionless" },
          run: () =>
            Deferred.succeed(firstStarted, undefined).pipe(
              Effect.zipRight(Deferred.await(releaseFirst)),
            ),
        });
        yield* Deferred.await(firstStarted);
        yield* Effect.forEach(
          Array.from({ length: RPC_SESSIONLESS_QUEUE_CAPACITY }, (_, index) => index),
          (index) =>
            dispatcher.dispatch({
              eofBehavior: "drain",
              onBoundExceeded: (error) => Deferred.succeed(rejected, error).pipe(Effect.asVoid),
              route: { _tag: "sessionless" },
              run: () =>
                Effect.sync(() => {
                  completed += 1;
                }).pipe(
                  Effect.zipRight(
                    index === RPC_SESSIONLESS_QUEUE_CAPACITY - 1
                      ? Deferred.succeed(acceptedFinished, undefined)
                      : Effect.void,
                  ),
                ),
            }),
          { discard: true },
        );
        yield* dispatcher.dispatch({
          eofBehavior: "drain",
          onBoundExceeded: (error) => Deferred.succeed(rejected, error).pipe(Effect.asVoid),
          route: { _tag: "sessionless" },
          run: () => Effect.die("The rejected sessionless frame ran."),
        });
        const result = yield* Deferred.await(rejected);
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(acceptedFinished);
        return result;
      }),
    ),
  );

  expect(RPC_SESSIONLESS_QUEUE_CAPACITY).toBe(64);
  expect(rejection).toMatchObject({ bound: "sessionless_queue", limit: 64 });
  expect(completed).toBe(64);
});

test("a full control-fork set rejects only the excess frame", async () => {
  let completed = 0;
  let started = 0;

  const rejection = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const allStarted = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const rejected = yield* Deferred.make<unknown>();
        const dispatcher = yield* makeRpcDispatcher(healthyWriterState);
        const controlFrame = () =>
          dispatcher.dispatch({
            eofBehavior: "drain",
            onBoundExceeded: (error) => Deferred.succeed(rejected, error).pipe(Effect.asVoid),
            route: { _tag: "control" as const },
            run: () =>
              Effect.sync(() => {
                started += 1;
              }).pipe(
                Effect.tap(() =>
                  started === RPC_CONTROL_FORK_CAPACITY
                    ? Deferred.succeed(allStarted, undefined)
                    : Effect.void,
                ),
                Effect.zipRight(Deferred.await(release)),
                Effect.zipRight(
                  Effect.sync(() => {
                    completed += 1;
                  }),
                ),
              ),
          });

        yield* Effect.forEach(Array.from({ length: RPC_CONTROL_FORK_CAPACITY }), controlFrame, {
          discard: true,
        });
        yield* Deferred.await(allStarted);
        yield* dispatcher.dispatch({
          eofBehavior: "drain",
          onBoundExceeded: (error) => Deferred.succeed(rejected, error).pipe(Effect.asVoid),
          route: { _tag: "control" },
          run: () => Effect.die("The rejected control frame ran."),
        });
        const result = yield* Deferred.await(rejected);
        yield* Deferred.succeed(release, undefined);
        yield* dispatcher.awaitIdle;
        return result;
      }),
    ),
  );

  expect(RPC_CONTROL_FORK_CAPACITY).toBe(64);
  expect(rejection).toMatchObject({ bound: "control_forks", limit: 64 });
  expect(completed).toBe(64);
});

test("finish interrupts a blocked control handler", async () => {
  const finished = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const controlStarted = yield* Deferred.make<void>();
        const dispatcher = yield* makeRpcDispatcher(healthyWriterState);

        yield* dispatcher.dispatch({
          eofBehavior: "drain",
          onBoundExceeded: () => Effect.die("The control fork set unexpectedly overflowed."),
          route: { _tag: "control" },
          run: () =>
            Deferred.succeed(controlStarted, undefined).pipe(Effect.zipRight(Effect.never)),
        });
        yield* Deferred.await(controlStarted);

        return yield* Effect.raceFirst(
          dispatcher.finish.pipe(Effect.as(true)),
          Effect.sleep("50 millis").pipe(Effect.as(false)),
        );
      }),
    ),
  );

  expect(finished).toBe(true);
});

test("serialized writer keeps concurrent LF-terminated frames intact", async () => {
  const fiberCount = 8;
  const framesPerFiber = 12;
  const chunks: Array<string> = [];
  const slowWriter: HeadWriter = {
    write: (text) =>
      Effect.forEach(
        text,
        (chunk) =>
          Effect.yieldNow().pipe(
            Effect.zipRight(Effect.sync(() => void chunks.push(chunk))),
            Effect.zipRight(Effect.yieldNow()),
          ),
        { discard: true },
      ),
  };

  await Effect.runPromise(
    Effect.gen(function* () {
      const writer = yield* serializedWriter(slowWriter);
      yield* Effect.forEach(
        Array.from({ length: fiberCount }, (_, fiberIndex) => fiberIndex),
        (fiberIndex) =>
          Effect.forEach(
            Array.from({ length: framesPerFiber }, (_, frameIndex) => frameIndex),
            (frameIndex) => writer.write(`fiber-${fiberIndex}/frame-${frameIndex}\n`),
            { discard: true },
          ),
        { concurrency: "unbounded", discard: true },
      );
    }),
  );

  const frames = chunks.join("").trimEnd().split("\n");
  const expected = Array.from({ length: fiberCount }, (_, fiberIndex) =>
    Array.from(
      { length: framesPerFiber },
      (_, frameIndex) => `fiber-${fiberIndex}/frame-${frameIndex}`,
    ),
  ).flat();

  expect(frames).toHaveLength(fiberCount * framesPerFiber);
  expect([...frames].sort()).toEqual(expected.sort());
});

test("serialized writer poisons after a write failure and rejects later writes without sink calls", async () => {
  const failure = new HeadWriteError({
    cause: new Error("sink closed"),
    message: "Head output failed: sink closed",
  });
  let sinkCalls = 0;
  const failingWriter: HeadWriter = {
    write: () => {
      sinkCalls += 1;
      return sinkCalls === 1 ? Effect.fail(failure) : Effect.void;
    },
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const writer = yield* serializedWriter(failingWriter);
      const firstError = yield* Effect.flip(writer.write("first\n"));
      const fatalError = yield* Effect.flip(writer.failure);
      const poisoned = yield* writer.poisoned;
      const secondError = yield* Effect.flip(writer.write("second\n"));
      return { fatalError, firstError, poisoned, secondError };
    }),
  );

  expect(result.firstError).toBe(failure);
  expect(result.fatalError).toBe(failure);
  expect(result.poisoned).toBe(true);
  expect(result.secondError).toBe(failure);
  expect(sinkCalls).toBe(1);
});

test("dispatch rejects poisoned writers before admitting new work", async () => {
  const failure = new HeadWriteError({
    cause: new Error("sink closed"),
    message: "Head output failed: sink closed",
  });
  let boundRejections = 0;
  let handlerRuns = 0;

  const dispatchResult = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const writer = yield* serializedWriter({ write: () => Effect.fail(failure) });
        const dispatcher = yield* makeRpcDispatcher(writer);
        yield* Effect.flip(writer.write("poison\n"));

        const result = yield* Effect.either(
          dispatcher.dispatch({
            eofBehavior: "drain",
            onBoundExceeded: () =>
              Effect.sync(() => {
                boundRejections += 1;
              }),
            route: { _tag: "session", sessionId: "session-after-poison" },
            run: () =>
              Effect.sync(() => {
                handlerRuns += 1;
              }),
          }),
        );
        yield* dispatcher.awaitIdle;
        return result;
      }),
    ),
  );

  expect(dispatchResult).toMatchObject({ _tag: "Left", left: failure });
  expect(boundRejections).toBe(0);
  expect(handlerRuns).toBe(0);
});

test("interrupting a writer that holds the permit releases the next writer", async () => {
  const writes: Array<string> = [];

  const interrupted = await Effect.runPromise(
    Effect.gen(function* () {
      const blockedWriteStarted = yield* Deferred.make<void>();
      const slowWriter: HeadWriter = {
        write: (text) =>
          Effect.sync(() => void writes.push(text)).pipe(
            Effect.zipRight(
              text === "blocked\n"
                ? Deferred.succeed(blockedWriteStarted, undefined).pipe(
                    Effect.zipRight(Effect.never),
                  )
                : Effect.void,
            ),
          ),
      };
      const writer = yield* serializedWriter(slowWriter);
      const blocked = yield* writer.write("blocked\n").pipe(Effect.fork);
      yield* Deferred.await(blockedWriteStarted);
      const next = yield* writer.write("next\n").pipe(Effect.fork);
      yield* Effect.yieldNow();
      expect(writes).toEqual(["blocked\n"]);

      const blockedExit = yield* Fiber.interrupt(blocked);
      yield* Fiber.join(next);
      expect(yield* writer.poisoned).toBe(false);
      return blockedExit;
    }),
  );

  expect(Exit.isInterrupted(interrupted)).toBe(true);
  expect(writes).toEqual(["blocked\n", "next\n"]);
});
