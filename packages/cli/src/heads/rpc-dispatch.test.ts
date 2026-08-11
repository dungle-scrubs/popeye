import { Deferred, Effect, Exit, Fiber } from "effect";
import { expect, test } from "vitest";

import { serializedWriter } from "./rpc-dispatch.js";
import { HeadWriteError, type HeadWriter } from "./shared.js";

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
      const poisoned = yield* writer.poisoned;
      const secondError = yield* Effect.flip(writer.write("second\n"));
      return { firstError, poisoned, secondError };
    }),
  );

  expect(result.firstError).toBe(failure);
  expect(result.poisoned).toBe(true);
  expect(result.secondError).toBe(failure);
  expect(sinkCalls).toBe(1);
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
