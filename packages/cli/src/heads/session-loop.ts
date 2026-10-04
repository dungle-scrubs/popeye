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
 * per-turn rendering with exit policy, and optional turn options, whose Session fields are bound
 * for the loop's lifetime and whose delivery fields go with each prompt. Turn failures propagate
 * to the caller's boundary; per-turn defects are the boundary's shape, not the loop's.
 * Not responsible for wire encoding (heads own their line formats) or for
 * Protocol framing (rpc-transport owns LF/1MB) or for boundary envelopes (heads own theirs).
 */

import type { SessionId } from "@dungle-scrubs/popeye-journal";
import { Data, Deferred, Effect, Fiber, Option, Ref, Stream } from "effect";

import type { DriverSnapshot, Progress, TurnOptions, TurnResult } from "../compose.js";
import { Driver, SessionLifecycle } from "../compose.js";
import type { HeadExitCode } from "./head-wire.js";

export type HeadProgressHandler = (progress: Progress) => Effect.Effect<void, unknown>;

interface SettledResult {
  readonly entryCountAfter: number;
  readonly entryCountBefore: number;
  readonly snapshot: DriverSnapshot;
  readonly stopReason: TurnResult["stopReason"];
}

export type SettledTurn = SettledResult &
  (
    | { readonly kind: "turn" }
    | { readonly commandName: string; readonly commandValue: unknown; readonly kind: "command" }
  );

class SlashCommandSyntaxError extends Data.TaggedError("SlashCommandSyntaxError")<{
  readonly message: string;
}> {}

const slashCommand = (
  input: string,
): Effect.Effect<
  { readonly args: string; readonly name: string } | undefined,
  SlashCommandSyntaxError
> => {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return Effect.succeed(undefined);
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(trimmed);
  return match === null || match[1] === undefined
    ? Effect.fail(new SlashCommandSyntaxError({ message: "Invalid slash Command syntax." }))
    : Effect.succeed({ args: match[2] ?? "", name: match[1] });
};

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
  /**
   * Split at loop start (issue 88): the Session fields are bound as the Session's Turn options
   * for the loop's lifetime, so Goal continuations and a sole /goal resume carry them too;
   * deliveryMode and expectedRevision go with each prompt.
   */
  readonly turnOptions?: TurnOptions;
}

/**
 * Runs prompts sequentially against a single Session, handling Progress subscription
 * only when onProgress is supplied. The Session is created or resumed once, then
 * reused for all prompts. Returns the first non-zero exit code, or 0 if all Turns
 * completed. Requires Driver in context.
 * On a normal return, and only then, the loop reports a clean close for its Session through
 * SessionLifecycle when one is provided (ADR-0002). It never calls closeSession. A failure or a
 * defect skips the report, so reconciliation later reads the run as killed.
 */
export const runSessionLoop = (
  options: SessionLoopOptions,
): Effect.Effect<HeadExitCode, unknown, Driver> =>
  Effect.gen(function* () {
    const driver = yield* Driver;
    const session = yield* options.sessionId === undefined
      ? driver.createSession()
      : driver.resumeSession(options.sessionId);
    const { deliveryMode, expectedRevision, ...sessionTurnOptions } = options.turnOptions ?? {};
    const delivery: TurnOptions = {
      ...(deliveryMode === undefined ? {} : { deliveryMode }),
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    };
    const loop = Effect.gen(function* () {
      if (options.onSession !== undefined) {
        yield* options.onSession(session.id);
      }
      return yield* runPrompts(driver, session, options, delivery);
    });
    // Issue 88: bind, use, and release as one region, so no exit (an interruption as the bind
    // lands included) leaves the Session bound.
    const exitCode = yield* Object.keys(sessionTurnOptions).length === 0
      ? loop
      : Effect.acquireUseRelease(
          driver.bindSessionTurnOptions(session.id, sessionTurnOptions),
          () => loop,
          () => driver.releaseSessionTurnOptions(session.id),
        );
    const lifecycle = yield* Effect.serviceOption(SessionLifecycle);
    if (Option.isSome(lifecycle)) {
      yield* lifecycle.value.headExit(session.id, driver.listSessions());
    }
    return exitCode;
  });

const runPrompts = (
  driver: Driver["Type"],
  session: { readonly id: SessionId },
  options: SessionLoopOptions,
  delivery: TurnOptions,
): Effect.Effect<HeadExitCode, unknown> =>
  Effect.gen(function* () {
    let entryCountBefore = (yield* driver.getSnapshot(session.id)).entries.length;

    if (options.prompts.length === 0 && options.sessionId !== undefined) {
      const resumed = yield* driver.resumeGoal(session.id);
      if (resumed !== undefined) {
        const snapshot = yield* driver.getSnapshot(session.id);
        return yield* options.onTurnSettled({
          entryCountAfter: snapshot.entries.length,
          entryCountBefore,
          kind: "turn",
          snapshot,
          stopReason: resumed.stopReason,
        });
      }
    }

    for (const [promptIndex, prompt] of options.prompts.entries()) {
      let stopReason: TurnResult["stopReason"];
      let snapshot: DriverSnapshot;
      const command = yield* slashCommand(prompt);
      if (command !== undefined) {
        const commandValue = yield* driver.invokeCommand(session.id, command.name, command.args);
        if (
          command.name === "goal" &&
          command.args.trim() === "resume" &&
          promptIndex === options.prompts.length - 1
        ) {
          const resumed = yield* driver.resumeGoal(session.id);
          if (resumed !== undefined) {
            snapshot = yield* driver.getSnapshot(session.id);
            return yield* options.onTurnSettled({
              entryCountAfter: snapshot.entries.length,
              entryCountBefore,
              kind: "turn",
              snapshot,
              stopReason: resumed.stopReason,
            });
          }
        }
        snapshot = yield* driver.getSnapshot(session.id);
        const commandTurn: SettledTurn = {
          commandName: command.name,
          commandValue,
          entryCountAfter: snapshot.entries.length,
          entryCountBefore,
          kind: "command",
          snapshot,
          stopReason: "done",
        };
        entryCountBefore = commandTurn.entryCountAfter;
        const exitCode = yield* options.onTurnSettled(commandTurn);
        if (exitCode !== 0) return exitCode;
        continue;
      }

      if (options.onProgress !== undefined) {
        const onProgress = options.onProgress;
        const settled = yield* Effect.scoped(
          Effect.gen(function* () {
            const subscriptionReady = yield* Deferred.make<void>();
            const targetSettlements = yield* Ref.make<number | undefined>(undefined);
            const observedSettlements = yield* Ref.make(0);
            const progressDropped = yield* Ref.make(false);
            const hasSettled = yield* Ref.make(false);
            const finalSettlement = yield* Deferred.make<void>();
            const progressFiber = yield* driver.subscribeProgress(session.id).pipe(
              Stream.runForEach((progress) =>
                Deferred.succeed(subscriptionReady, undefined).pipe(
                  Effect.zipRight(
                    Ref.get(hasSettled).pipe(
                      Effect.flatMap((settled) =>
                        settled && progress._tag === "phaseChanged" && progress.phase === "IDLE"
                          ? Effect.void
                          : onProgress(progress),
                      ),
                    ),
                  ),
                  Effect.zipRight(
                    progress._tag === "progressDropped"
                      ? Ref.set(progressDropped, true).pipe(
                          Effect.zipRight(Deferred.succeed(finalSettlement, undefined)),
                          Effect.asVoid,
                        )
                      : progress._tag === "turnSettled"
                        ? Ref.update(observedSettlements, (count) => count + 1).pipe(
                            Effect.zipRight(Ref.set(hasSettled, true)),
                            Effect.zipRight(
                              Ref.get(targetSettlements).pipe(
                                Effect.flatMap((target) =>
                                  Ref.get(observedSettlements).pipe(
                                    Effect.flatMap((observed) =>
                                      target !== undefined && observed >= target
                                        ? Deferred.succeed(finalSettlement, undefined).pipe(
                                            Effect.asVoid,
                                          )
                                        : Effect.void,
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          )
                        : Effect.void,
                  ),
                ),
              ),
              Effect.forkScoped,
            );

            yield* Deferred.await(subscriptionReady);
            const result = yield* driver.prompt(session.id, prompt, delivery);
            const snapshot = yield* driver.getSnapshot(session.id);
            const startedTurns = snapshot.entries.slice(entryCountBefore).filter((entry) => {
              if (entry.kind === "goal_continuation") return true;
              if (entry.kind !== "message" || typeof entry.payload !== "object") return false;
              if (entry.payload === null) return false;
              const payload = entry.payload as {
                readonly deliveryMode?: unknown;
                readonly role?: unknown;
              };
              return payload.role === "user" && payload.deliveryMode !== "steer";
            }).length;
            yield* Ref.set(targetSettlements, startedTurns);
            if (
              (yield* Ref.get(observedSettlements)) < startedTurns &&
              !(yield* Ref.get(progressDropped))
            ) {
              yield* Deferred.await(finalSettlement).pipe(
                Effect.timeoutOption("5 seconds"),
                Effect.asVoid,
              );
            }
            yield* Fiber.interrupt(progressFiber);
            return { snapshot, stopReason: result.stopReason };
          }),
        );
        stopReason = settled.stopReason;
        snapshot = settled.snapshot;
      } else {
        const result = yield* driver.prompt(session.id, prompt, delivery);
        snapshot = yield* driver.getSnapshot(session.id);
        stopReason = result.stopReason;
      }

      const turn: SettledTurn = {
        entryCountAfter: snapshot.entries.length,
        entryCountBefore,
        kind: "turn",
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
