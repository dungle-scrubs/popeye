/**
 * Thin adapter over GenerationRuntime (D-003).
 * Owns re-export of generation construction so existing callers keep working while
 * GenerationRuntime owns checkout/drain/busy/view in one Ref.
 * Why this shim: keep 518 tests green behind same surface for one commit; final delete of duplication is this commit.
 * Not responsible for routing (GenerationRuntime owns that) or discovery (pipeline owns that).
 */

export {
  DEFAULT_IMPORT_TIMEOUT_MILLIS,
  DEFAULT_TRUST_RESOLVER_TIMEOUT_MILLIS,
  type GenerationBusyError,
  type GenerationDrainTimeoutError,
  type GenerationLease,
  type GenerationLoadError,
  type GenerationPlugin,
  type GenerationRuntime,
  type GenerationSwapDiagnostic,
  type LoadGenerationOptions,
  loadGeneration,
  makeGenerationRuntime,
  makeGenerationRuntimeWithLoader,
  type PluginGeneration,
  type PluginRuntimeDebugInfo,
  type TrustResolutionRequest,
  type TrustResolver,
} from "./generation-runtime.js";

import { Effect, type Scope } from "effect";
import type { LoadGenerationOptions, PluginGeneration } from "./generation-runtime.js";
import {
  type GenerationLoadError,
  type GenerationSwapDiagnostic,
  makeGenerationRuntime,
} from "./generation-runtime.js";
import type { TrustStore } from "./trust.js";

export interface GenerationLeaseCompat {
  readonly generation: PluginGeneration;
}

export interface PluginRuntime {
  readonly checkout: Effect.Effect<GenerationLeaseCompat, never, Scope.Scope>;
  readonly close: Effect.Effect<void>;
  readonly debugInfo: Effect.Effect<import("./generation-runtime.js").PluginRuntimeDebugInfo>;
  readonly reload: Effect.Effect<GenerationSwapDiagnostic, GenerationLoadError, TrustStore>;
  readonly use: <TOutput, TError, TRequirements>(
    run: (generation: PluginGeneration) => Effect.Effect<TOutput, TError, TRequirements>,
  ) => Effect.Effect<TOutput, TError, TRequirements>;
  readonly useSerialized: <TOutput, TError, TRequirements>(
    run: (generation: PluginGeneration) => Effect.Effect<TOutput, TError, TRequirements>,
  ) => Effect.Effect<TOutput, TError, TRequirements>;
}

export const makePluginRuntime = (
  options: LoadGenerationOptions,
): Effect.Effect<PluginRuntime, GenerationLoadError, TrustStore> =>
  makeGenerationRuntime(options).pipe(
    Effect.map((runtime) => ({
      checkout: runtime.checkout as unknown as PluginRuntime["checkout"],
      close: runtime.close,
      debugInfo: runtime.debugInfo,
      reload: runtime.reload as unknown as PluginRuntime["reload"],
      use: runtime.use,
      useSerialized: runtime.useSerialized,
    })),
  );
