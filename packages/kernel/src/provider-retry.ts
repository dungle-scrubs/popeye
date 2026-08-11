/**
 * Owns Provider request counting and transient-only retry scheduling.
 * It exists so turn and Compaction requests share one bounded attempt policy.
 */

import { Duration, Effect, Ref, Schedule, ScheduleDecision } from "effect";

import { ProviderError } from "./errors.js";

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_MAX_PROVIDER_ROUNDS = 32;
export const DEFAULT_RETRY_BASE_DELAY_MS = 100;

export interface ProviderRequestRuntime {
  readonly attemptCount: Effect.Effect<number>;
  readonly run: <TValue, TEnvironment>(
    request: (attempt: number) => Effect.Effect<TValue, ProviderError, TEnvironment>,
    onRoundLimit?: Effect.Effect<TValue, ProviderError, TEnvironment>,
  ) => Effect.Effect<TValue, ProviderError, TEnvironment>;
}

export interface ProviderRequestRuntimeOptions {
  readonly baseDelayMs?: number;
  readonly maxAttempts: number;
  readonly maxProviderRounds: number;
  readonly onRetry: (nextAttempt: number, delayMs: number) => Effect.Effect<void>;
}

const retryTransientProvider = <TValue, TEnvironment>(
  request: Effect.Effect<TValue, ProviderError, TEnvironment>,
  options: ProviderRequestRuntimeOptions,
  attemptCount: Effect.Effect<number>,
): Effect.Effect<TValue, ProviderError, TEnvironment> =>
  request.pipe(
    Effect.retry(
      Schedule.exponential(`${options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS} millis`).pipe(
        Schedule.intersect(Schedule.recurs(options.maxAttempts - 1)),
        Schedule.whileInput((error: ProviderError) => error.transient),
        Schedule.onDecision(([delay], decision) =>
          ScheduleDecision.isContinue(decision)
            ? attemptCount.pipe(
                Effect.flatMap((attempt) => options.onRetry(attempt + 1, Duration.toMillis(delay))),
              )
            : Effect.void,
        ),
      ),
    ),
  );

export const makeProviderRequestRuntime = (
  options: ProviderRequestRuntimeOptions,
): Effect.Effect<ProviderRequestRuntime> =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const rounds = yield* Ref.make(0);
    const run: ProviderRequestRuntime["run"] = (request, onRoundLimit) =>
      retryTransientProvider(
        Effect.suspend(() =>
          Ref.updateAndGet(rounds, (count) => count + 1).pipe(
            Effect.flatMap((round) => {
              if (round > options.maxProviderRounds) {
                return (
                  onRoundLimit ??
                  Effect.fail(
                    new ProviderError({
                      message: `Maximum provider round bound of ${options.maxProviderRounds} exceeded.`,
                      transient: false,
                    }),
                  )
                );
              }
              return Ref.updateAndGet(attempts, (count) => count + 1).pipe(Effect.flatMap(request));
            }),
          ),
        ),
        options,
        Ref.get(attempts),
      );
    return {
      attemptCount: Ref.get(attempts),
      run,
    } satisfies ProviderRequestRuntime;
  });
