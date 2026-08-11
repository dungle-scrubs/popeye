/**
 * Owns rpc dispatch policy: write serialization now; Session queueing arrives next.
 * It exists so rpc.ts keeps framing and decoding while dispatch policy stays testable in isolation.
 * Interrupting an interruptible write releases its permit after interruption finalizers run. An
 * explicitly uninterruptible write keeps its permit until it completes or reaches an interruptible region.
 */
import { Effect, Ref } from "effect";

import type { HeadWriteError, HeadWriter } from "./shared.js";

export interface SerializedHeadWriter extends HeadWriter {
  readonly poisoned: Effect.Effect<boolean>;
}

export const serializedWriter = (writer: HeadWriter): Effect.Effect<SerializedHeadWriter> =>
  Effect.gen(function* () {
    const poison = yield* Ref.make<HeadWriteError | undefined>(undefined);
    const semaphore = yield* Effect.makeSemaphore(1);

    return {
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
                Effect.tapError((error) => Ref.set(poison, error).pipe(Effect.uninterruptible)),
              );
          }),
        ),
    };
  });
