/**
 * Owns the opt-in trust-gate Plugin as a linkable module (second adapter for trust).
 * It exists so project-local code is gated by human trust decisions via PluginInteractions.
 * Why this module: provides the trust prompt as a Hook contribution; alternative fake adapters exist for testing.
 * The gate uses a confirm interaction; fallback untrusted makes headless startup deny immediately via the null layer (no stall, clocked).
 * On reload over rpc, an interactive Head can answer trusted to load stage-2, or the fallback untrusted swaps without project plugins.
 * Not responsible for transport (heads own that) or for Trust store I/O (trust owns that); this module only owns the trust Hook decision.
 */

import {
  DEFAULT_INTERACTION_TIMEOUT_MILLIS,
  defineHookContribution,
  PluginInteractions,
  type TrustHookInput,
  type TrustHookOutput,
} from "@popeye/plugins";
import { Effect } from "effect";

const makeTrustGatePlugin = () => {
  const hookRun = (
    input: TrustHookInput,
  ): Effect.Effect<TrustHookOutput, unknown, PluginInteractions> =>
    Effect.gen(function* () {
      const interactions = yield* PluginInteractions;
      const changeSummary = input.changeSummary as
        | {
            readonly added: ReadonlyArray<string>;
            readonly modified: ReadonlyArray<string>;
            readonly removed: ReadonlyArray<string>;
          }
        | undefined;
      const changeText =
        changeSummary === undefined
          ? "New project plugins detected."
          : `Changes - added: [${changeSummary.added.join(", ")}], modified: [${changeSummary.modified.join(", ")}], removed: [${changeSummary.removed.join(", ")}].`;
      const prompt = [
        `Trust project "${input.projectPath}"?`,
        `Digest: ${input.currentDigest}`,
        changeText,
        `Kind: ${input.kind}`,
      ].join("\n");

      const requestId = `trust-gate-${input.projectPath.replaceAll("/", "-")}-${input.currentDigest.slice(0, 8)}-${Date.now().toString(36)}`;
      const resolution = yield* interactions.request({
        fallback: { kind: "confirm", value: false },
        id: requestId,
        kind: "confirm",
        prompt,
        timeoutMs: DEFAULT_INTERACTION_TIMEOUT_MILLIS,
      });

      const trusted = (resolution.response as { readonly value: boolean }).value;

      if (trusted) {
        yield* Effect.logInfo(
          JSON.stringify({
            diagnostic: "trust_gate_trusted",
            digest: input.currentDigest,
            plugin: "trust-gate",
            projectPath: input.projectPath,
            type: "trust_gate_trusted",
          }),
        ).pipe(
          Effect.annotateLogs({
            diagnostic: "trust_gate_trusted",
            digest: input.currentDigest,
            plugin: "trust-gate",
            projectPath: input.projectPath,
          }),
        );
        return {
          decision: "replace",
          value: { decision: "trusted" },
        } as TrustHookOutput;
      }

      yield* Effect.logWarning(
        JSON.stringify({
          diagnostic: "trust_gate_untrusted",
          digest: input.currentDigest,
          plugin: "trust-gate",
          projectPath: input.projectPath,
          type: "trust_gate_untrusted",
        }),
      ).pipe(
        Effect.annotateLogs({
          diagnostic: "trust_gate_untrusted",
          digest: input.currentDigest,
          plugin: "trust-gate",
          projectPath: input.projectPath,
        }),
      );
      return {
        decision: "replace",
        value: { decision: "untrusted" },
      } as TrustHookOutput;
    });

  return {
    contributions: [
      defineHookContribution({
        mergeClass: "FirstWins",
        name: "trust-gate",
        point: "trust",
        run: hookRun as (input: unknown) => Effect.Effect<unknown, unknown, PluginInteractions>,
      }),
    ],
    manifest: {
      capabilities: [{ name: "interaction" }],
      description:
        "Gates project-local Plugin trust with an interactive confirm prompt; fallback is untrusted.",
      name: "trust-gate",
      version: "1.0.0",
    },
  } as const;
};

export const trustGatePlugin = makeTrustGatePlugin();

export const plugin = makeTrustGatePlugin;

export default makeTrustGatePlugin;
