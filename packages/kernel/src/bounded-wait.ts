/**
 * Owns the bounded wait the close and abort paths use.
 * It exists because a timed wait inherits its caller's interruptibility: inside an
 * uninterruptible region (a Scope finalizer, a Mailbox drain) Effect.timeoutOption cannot stop
 * the waiting fiber, so it does not return at its deadline (issue 56).
 * Not responsible for stopping underlying work when awaiting a Fiber or Deferred.
 */
import { Cause, Effect, Exit, Option } from "effect";

/**
 * Interrupts `effect` at the deadline or when the caller is interrupted and returns None.
 * Uninterruptible work delays the return until it ends, overrunning the deadline. Awaiting a
 * Fiber or Deferred leaves its underlying work running. Other failures propagate.
 */
export const boundedWait = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  millis: number,
): Effect.Effect<Option.Option<A>, E, R> =>
  Effect.interruptible(effect).pipe(
    Effect.timeoutOption(`${millis} millis`),
    Effect.exit,
    Effect.flatMap((exit) =>
      Exit.isSuccess(exit)
        ? Effect.succeed(exit.value)
        : Cause.isInterruptedOnly(exit.cause)
          ? Effect.succeed(Option.none<A>())
          : Effect.failCause(exit.cause),
    ),
  );
