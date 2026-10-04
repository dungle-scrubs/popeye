import { SessionIdSchema } from "@dungle-scrubs/popeye-journal";
import { Deferred, Effect, Exit, Fiber, Stream } from "effect";
import { expect, test } from "vitest";

import { type Progress, ProgressHub, ProgressHubLive } from "./progress.js";

test("a publisher succeeds when subscribers disconnect during thinking publication", async () => {
  const publisherExit = await Effect.runPromise(
    Effect.gen(function* () {
      const progress = yield* ProgressHub;
      const sessionId = SessionIdSchema.make("disconnect-progress");
      const subscribers = yield* Effect.forEach([0, 1, 2, 3], () =>
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const fiber = yield* Effect.fork(
            Stream.runForEach(progress.subscribe(sessionId), () =>
              Deferred.succeed(ready, undefined),
            ),
          );
          yield* Deferred.await(ready);
          return fiber;
        }),
      );
      const started = yield* Deferred.make<void>();
      const publisher = yield* Effect.fork(
        Deferred.succeed(started, undefined).pipe(
          Effect.zipRight(
            Effect.forEach(
              Array.from({ length: 3000 }, (_, index) => index),
              (index) =>
                progress.publish(sessionId, { _tag: "assistantThinking", text: String(index) }),
            ),
          ),
        ),
      );
      yield* Deferred.await(started);
      yield* Effect.forEach(subscribers, Fiber.interrupt);
      return yield* Fiber.await(publisher);
    }).pipe(Effect.provide(ProgressHubLive())),
  );

  expect(Exit.isSuccess(publisherExit)).toBe(true);
});

test("a slow subscriber reports exactly the drops since its previous delivery", async () => {
  const observed: Array<Progress> = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const progress = yield* ProgressHub;
      const sessionId = SessionIdSchema.make("slow-progress");
      const ready = yield* Deferred.make<void>();
      const subscriber = yield* Effect.fork(
        Stream.runForEach(progress.subscribe(sessionId), (item) =>
          Effect.sync(() => observed.push(item)).pipe(
            Effect.zipRight(
              item._tag === "phaseChanged" && item.phase === "IDLE"
                ? Deferred.succeed(ready, undefined).pipe(
                    Effect.zipRight(Effect.sleep("100 millis")),
                  )
                : Effect.void,
            ),
          ),
        ),
      );
      yield* Deferred.await(ready);
      yield* Effect.forEach(["1", "2", "3", "4", "5", "6"], (text) =>
        progress.publish(sessionId, { _tag: "assistantText", text }),
      );
      yield* Effect.sleep("150 millis");
      yield* Fiber.interrupt(subscriber);
    }).pipe(Effect.provide(ProgressHubLive(4))),
  );

  expect(observed.filter((item) => item._tag === "progressDropped")).toEqual([
    { _tag: "progressDropped", count: 2 },
  ]);
  expect(observed.at(-1)).toEqual({ _tag: "assistantText", text: "6" });
});
