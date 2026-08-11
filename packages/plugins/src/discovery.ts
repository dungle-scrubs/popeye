/**
 * Owns two-phase Plugin discovery around the Trust boundary.
 * It exists so phase 2 verifies trusted content immediately before it returns executable sources.
 * Discovery is not a Trust decision source. A project cannot approve itself.
 */
import { Effect } from "effect";
import {
  classifyResolvedPluginSource,
  type PluginDigestLimits,
  type PluginDiscoveryConfig,
  PluginDiscoveryError,
  type PluginSource,
  type PluginSourceOrigin,
  type PluginSourceScope,
  phase1ExecutionSources,
  phase2ExecutionSources,
} from "./sources.js";
import {
  computeProjectPluginDigest,
  digestMismatchError,
  type PluginDigestError,
} from "./trust-digest.js";

export {
  classifyResolvedPluginSource,
  type PluginDigestLimits,
  type PluginDiscoveryConfig,
  PluginDiscoveryError,
  type PluginSource,
  type PluginSourceOrigin,
  type PluginSourceScope,
  phase2ExecutionSources,
};

export type TrustDecisionForDiscovery =
  | { readonly kind: "prompt_required" | "reprompt_required" | "untrusted" }
  | { readonly kind: "trusted"; readonly trustedDigest: string };

export const phase1Sources = (
  config: PluginDiscoveryConfig,
): Effect.Effect<ReadonlyArray<PluginSource>, PluginDiscoveryError> =>
  phase1ExecutionSources(config);

export const phase2Sources = (
  config: PluginDiscoveryConfig,
  trustDecision: TrustDecisionForDiscovery,
): Effect.Effect<ReadonlyArray<PluginSource>, PluginDigestError> =>
  trustDecision.kind === "trusted"
    ? computeProjectPluginDigest(config).pipe(
        Effect.flatMap((current) =>
          current.digest === trustDecision.trustedDigest
            ? Effect.succeed(current.sources)
            : Effect.fail(
                digestMismatchError(
                  config.projectPath,
                  trustDecision.trustedDigest,
                  current.digest,
                ),
              ),
        ),
      )
    : Effect.succeed([]);
