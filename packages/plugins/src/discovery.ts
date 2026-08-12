/**
 * Owns PluginDiscovery deep module for two-phase Plugin discovery around the Trust boundary.
 * It exists so source enumeration, digest binding, and trust decision branching hide behind one
 * seam: phase1Sources(config) for trust-prompt needs and phase2Sources(config, decision) for
 * execution. Phase 2 verifies trusted content immediately before it returns executable sources,
 * failing closed on digest mismatch so a project cannot approve itself by swapping files after
 * trust was granted.
 * Why this module: understanding "how a file becomes a live Tool" previously required bouncing
 * between sources.ts (phase1/2 enumeration + realpath), trust-digest.ts (hash binding), loader.ts
 * (import + timeout), and registry.ts (priority tiebreak) — 6 hops for one concept, each seam's
 * interface nearly as complex as its implementation. This module hides file enumeration via
 * sources.ts, content binding via trust-digest.ts, and the trusted/untrusted branch behind two
 * methods; callers depend on PluginDiscovery, not on sources or digest directly. GenerationRuntime
 * and pipeline are its only consumers, via the single trusted decision type, so digest-mismatch and
 * "untrusted executes no project code" are localized to one module and one test seam.
 * Not responsible for module import or manifest validation (loader owns native import, type
 * stripping caveats, and timeout semantics) or for contribution priority and registry writes
 * (registry owns that) or for generation lifetime and checkout counting (GenerationRuntime owns
 * that). The seam is filesystem + trust: two adapters justify it — real readdir/realpath on
 * the host vs FakeSources/FakeDigest in tests that prove "untrusted → no import" without
 * touching the filesystem.
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
