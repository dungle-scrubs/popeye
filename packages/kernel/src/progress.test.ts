import { SessionIdSchema } from "@peye/journal";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { expect, test } from "vitest";

import { type Progress, ProgressHub, ProgressHubLive } from "./progress.js";

test("phase transitions surface as structured progress while slow subscribers report dropped items", async () => {
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
      yield* progress.publish(sessionId, { _tag: "phaseChanged", phase: "ASSEMBLING" });
      yield* progress.publish(sessionId, { _tag: "phaseChanged", phase: "STREAMING" });
      yield* progress.publish(sessionId, { _tag: "phaseChanged", phase: "SETTLING" });
      yield* Effect.sleep("150 millis");
      yield* Fiber.interrupt(subscriber);
    }).pipe(Effect.provide(ProgressHubLive(1))),
  );

  expect(observed).toContainEqual({ _tag: "phaseChanged", phase: "SETTLING" });
  expect(observed).toContainEqual({ _tag: "progressDropped", count: 2 });
});
