/**
 * Owns Head Session Loop deep module for sequential prompt execution.
 * It exists so print, json, and hcn Heads share one correct lifecycle: create or resume a Session,
 * subscribe to Progress until turnSettled, run the Turn, join the fiber, read the Snapshot,
 * and hand each settled turn to the Head for rendering and exit policy. The loop is the SINGLE
 * place that enforces "a Head trusts only Snapshots, never Progress" and that prompts run
 * sequentially and stop at the first non-zero exit.
 * Why this module: print.ts and json.ts duplicated createSession/resumeSession, the
 * Deferred subscriptionReady handshake, Stream.takeUntil(turnSettled), Fiber.join, and
 * exit-code sequencing. The former shared.ts grab-bag extracted only writers and
 * boundary; it did not own the lifecycle, so a fix to back-pressure had to be validated in
 * two places.
 * This module owns the lifecycle and exposes one seam: heads supply Progress rendering,
 * per-turn rendering with exit policy, and optional turn options. Turn failures propagate
 * to the caller's boundary; per-turn defects are the boundary's shape, not the loop's.
 * Not responsible for wire encoding (heads own their line formats) or for
 * Protocol framing (rpc-transport owns LF/1MB) or for boundary envelopes (heads own theirs).
 */

import type { SessionId } from "@popeye/journal";
import { Deferred, Effect, Fiber, Stream } from "effect";

import type { DriverSnapshot, Progress, TurnOptions, TurnResult } from "../compose.js";
import { Driver } from "../compose.js";
import type { HeadExitCode } from "./head-wire.js";

export type HeadProgressHandler = (progress: Progress) => Effect.Effect<void, unknown>;

export interface SettledTurn {
  readonly entryCountAfter: number;
  readonly entryCountBefore: number;
  readonly snapshot: DriverSnapshot;
  readonly stopReason: TurnResult["stopReason"];
}

/** Renders one settled turn and returns its exit code; non-zero stops the loop. */
export type HeadTurnHandler = (turn: SettledTurn) => Effect.Effect<HeadExitCode, unknown>;

export interface SessionLoopOptions {
  readonly onProgress?: HeadProgressHandler;
  /** Called once after Session create/resume, before the first prompt. */
  readonly onSession?: (sessionId: SessionId) => Effect.Effect<void, unknown>;
  /** Called after each Turn settles with the authoritative Snapshot. */
  readonly onTurnSettled: HeadTurnHandler;
  readonly prompts: ReadonlyArray<string>;
  readonly sessionId?: SessionId;
  readonly turnOptions?: TurnOptions;
}

/**
 * Runs prompts sequentially against a single Session, handling Progress subscription
 * only when onProgress is supplied. The Session is created or resumed once, then
 * reused for all prompts. Returns the first non-zero exit code, or 0 if all Turns
 * completed. Requires Driver in context.
 */
export const runSessionLoop = (
  options: SessionLoopOptions,
): Effect.Effect<HeadExitCode, unknown, Driver> =>
  Effect.gen(function* () {
    const driver = yield* Driver;
    const session = yield* options.sessionId === undefined
      ? driver.createSession()
      : driver.resumeSession(options.sessionId);
    if (options.onSession !== undefined) {
      yield* options.onSession(session.id);
    }
    let entryCountBefore = (yield* driver.getSnapshot(session.id)).entries.length;

    for (const prompt of options.prompts) {
      let stopReason: TurnResult["stopReason"];
      let snapshot: DriverSnapshot;

      if (options.onProgress !== undefined) {
        const onProgress = options.onProgress;
        const settled = yield* Effect.scoped(
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
            const result = yield* options.turnOptions === undefined
              ? driver.prompt(session.id, prompt)
              : driver.prompt(session.id, prompt, options.turnOptions);
            yield* Fiber.join(progressFiber);
            const snapshot = yield* driver.getSnapshot(session.id);
            return { snapshot, stopReason: result.stopReason };
          }),
        );
        stopReason = settled.stopReason;
        snapshot = settled.snapshot;
      } else {
        const result = yield* options.turnOptions === undefined
          ? driver.prompt(session.id, prompt)
          : driver.prompt(session.id, prompt, options.turnOptions);
        snapshot = yield* driver.getSnapshot(session.id);
        stopReason = result.stopReason;
      }

      const turn: SettledTurn = {
        entryCountAfter: snapshot.entries.length,
        entryCountBefore,
        snapshot,
        stopReason,
      };
      entryCountBefore = turn.entryCountAfter;
      const exitCode = yield* options.onTurnSettled(turn);
      if (exitCode !== 0) {
        return exitCode;
      }
    }

    return 0 as HeadExitCode;
  });
