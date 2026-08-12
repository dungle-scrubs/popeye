/**
 * Thin adapter over TurnOrchestrator (D-002).
 * Owns the legacy Turns surface so existing callers (Driver, kernel tests, CLI)
 * keep working while TurnOrchestrator owns retry/batch/compaction/steering.
 *
 * Why this shim: keep 518 tests green behind same surface for one commit,
 * avoid big-bang break of M9 soak harness. Final delete of shim is a
 * separate commit after callers migrate to TurnOrchestrator.openTurn.
 * Not responsible for turn lifecycle, per-Session view pinning, or Provider
 * retry - TurnOrchestrator owns those. Not responsible for generation
 * lifetime (GenerationRuntime will own that).
 */

import type { Journal, SessionId } from "@pop-eye/journal";
import type { ProtocolError } from "@pop-eye/protocol";
import { Context, Effect, Layer, type Stream } from "effect";
import type { Compaction } from "./compaction-policy.js";
import type { Mailbox } from "./mailbox.js";
import type { PluginHost } from "./plugin-host.js";
import type { Progress, ProgressHub } from "./progress.js";
import type { Provider } from "./provider.js";
import type { ToolRegistry } from "./tool.js";
import {
  type AbortTurnResult as OrchestratorAbort,
  type TurnFailure as OrchestratorFailure,
  type TurnOptions as OrchestratorOptions,
  type TurnOptionsResolver as OrchestratorResolver,
  type TurnResult as OrchestratorResult,
  TurnOrchestrator,
  TurnOrchestratorLive,
} from "./turn-orchestrator.js";

// Re-export deep-module values for legacy callers.
export {
  AbortTurnResultSchema,
  DEFAULT_RETRY_BASE_DELAY_MS,
  TURN_INPUT_QUEUE_CAPACITY,
  TurnOptionsSchema,
  TurnResultSchema,
  validateTurnOptionsSync,
} from "./turn-orchestrator.js";

export type TurnFailure = OrchestratorFailure;
export type TurnOptions = OrchestratorOptions;
export type TurnOptionsResolver = OrchestratorResolver;
export type TurnResult = OrchestratorResult;
export type AbortTurnResult = OrchestratorAbort;

export interface TurnsService {
  readonly abortTurn: (sessionId: SessionId) => Effect.Effect<AbortTurnResult>;
  readonly runTurn: (
    sessionId: SessionId,
    content: string,
    options?: TurnOptions,
    resolveOptions?: TurnOptionsResolver,
  ) => Effect.Effect<TurnResult, TurnFailure>;
  readonly steer: (
    sessionId: SessionId,
    content: string,
  ) => Effect.Effect<void, ProtocolError | import("./errors.js").TurnQueueFull>;
  readonly subscribeProgress: (sessionId: SessionId) => Stream.Stream<Progress>;
}

export class Turns extends Context.Tag("@pop-eye/kernel/Turns")<Turns, TurnsService>() {}

// Keep synchronous validation in shim as well (defense in depth) by
// delegating to orchestrator which already validates synchronously.
// This ensures expect(() => turns.runTurn(..., {maxProviderRounds:0})).toThrow()
// keeps passing even if orchestrator's validation ever moves inside Effect.

export const TurnsLive = (): Layer.Layer<
  Turns,
  never,
  Compaction | Journal | Mailbox | PluginHost | ProgressHub | Provider | ToolRegistry
> =>
  Layer.effect(
    Turns,
    Effect.gen(function* () {
      const orchestrator = yield* TurnOrchestrator;
      return {
        abortTurn: orchestrator.abortTurn,
        runTurn: (
          sessionId: SessionId,
          content: string,
          options: TurnOptions = {},
          resolveOptions?: TurnOptionsResolver,
        ): Effect.Effect<TurnResult, TurnFailure> =>
          orchestrator.openTurn(sessionId, content, undefined, options, resolveOptions),
        steer: orchestrator.steer,
        subscribeProgress: orchestrator.subscribeProgress,
      } satisfies TurnsService;
    }),
  ).pipe(Layer.provide(TurnOrchestratorLive()));
