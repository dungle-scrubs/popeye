/**
 * Owns Head Session Loop deep module for sequential prompt execution.
 * It exists so print and json Heads share one correct lifecycle: create or resume a Session,
 * subscribe to Progress until turnSettled, run the Turn, join the fiber, read the Snapshot,
 * and map stopReason to the canonical exit code. The loop is the SINGLE place that enforces
 * "a Head trusts only Snapshots, never Progress" and that prompts run sequentially and stop
 * at the first non-zero exit.
 * Why this module: print.ts and json.ts duplicated createSession/resumeSession, the
 * Deferred subscriptionReady handshake, Stream.takeUntil(turnSettled), Fiber.join, and
 * exitCodeForStopReason sequencing. The former shared.ts grab-bag extracted only writers and
 * boundary; it did not own the lifecycle, so a fix to back-pressure had to be validated in
 * two places.
 * This module owns the lifecycle and exposes two thin adapters via one seam.
 * Not responsible for wire encoding (json owns ProgressSchema/SnapshotSchema) or for
 * Protocol framing (rpc-transport owns LF/1MB) or for boundary envelope (HeadWire owns headErrorEnvelope).
 */

import type { SessionId } from "@popeye/journal";
import { Deferred, Effect, Fiber, Stream } from "effect";

import type { DriverSnapshot, TurnResult } from "../compose.js";
import { Driver } from "../compose.js";
import { exitCodeForStopReason, type HeadExitCode } from "./head-wire.js";

export type HeadProgressHandler = (progress: unknown) => Effect.Effect<void, unknown>;
export type HeadSnapshotHandler = (snapshot: DriverSnapshot) => Effect.Effect<void, unknown>;

export interface SessionLoopOptions {
  readonly onProgress?: HeadProgressHandler;
  /** Called after each Turn settles with the authoritative Snapshot. */
  readonly onSnapshot: HeadSnapshotHandler;
  readonly prompts: ReadonlyArray<string>;
  readonly sessionId?: SessionId;
}

/**
 * Runs prompts sequentially against a single Session, handling Progress subscription
 * only when onProgress is supplied. The Session is created or resumed once, then
 * reused for all prompts. Returns the first non-zero exit code, or 0 if all Turns
 * completed with done/truncated. Requires Driver in context.
 */
export const runSessionLoop = (
  options: SessionLoopOptions,
): Effect.Effect<HeadExitCode, unknown, Driver> =>
  Effect.gen(function* () {
    const driver = yield* Driver;
    const session = yield* options.sessionId === undefined
      ? driver.createSession()
      : driver.resumeSession(options.sessionId);

    for (const prompt of options.prompts) {
      let stopReason: TurnResult["stopReason"];

      if (options.onProgress !== undefined) {
        const onProgress = options.onProgress;
        const onSnapshot = options.onSnapshot;
        stopReason = yield* Effect.scoped(
          Effect.gen(function* () {
            const subscriptionReady = yield* Deferred.make<void>();
            const progressFiber = yield* driver.subscribeProgress(session.id).pipe(
              Stream.takeUntil((progress) => progress._tag === "turnSettled"),
              Stream.runForEach((progress) =>
                Deferred.succeed(subscriptionReady, undefined).pipe(
                  Effect.zipRight(onProgress(progress)),
                ),
              ),
              Effect.forkScoped,
            );

            yield* Deferred.await(subscriptionReady);
            const result = yield* driver.prompt(session.id, prompt);
            yield* Fiber.join(progressFiber);
            const snapshot = yield* driver.getSnapshot(session.id);
            yield* onSnapshot(snapshot);
            return result.stopReason;
          }),
        );
      } else {
        const result = yield* driver.prompt(session.id, prompt);
        const snapshot = yield* driver.getSnapshot(session.id);
        yield* options.onSnapshot(snapshot);
        stopReason = result.stopReason;
      }

      const exitCode = exitCodeForStopReason(stopReason);
      if (exitCode !== 0) {
        return exitCode;
      }
    }

    return 0 as HeadExitCode;
  });
