/**
 * Owns the first-party compact Plugin.
 * It exists so manual Compaction and its gate use the same public Plugin interface as third-party
 * behavior.
 */
import {
  type CompactionGateHookInput,
  type CompactionGateHookOutput,
  defineCommandContribution,
  defineHookContribution,
  type PluginManifest,
} from "@peye/plugins";
import { Effect, Schema } from "effect";

export interface CompactPluginOptions {
  readonly decideCompaction?: (
    input: CompactionGateHookInput,
  ) => Effect.Effect<CompactionGateHookOutput>;
}

const continueCompaction = (): Effect.Effect<CompactionGateHookOutput> =>
  Effect.succeed({ action: "compact" });

export const makeCompactPlugin = (options: CompactPluginOptions = {}) => ({
  contributions: [
    defineCommandContribution({
      arguments: Schema.Struct({}),
      description: "Compact the current Session Branch.",
      execute: (_input, context) => context.compactNow(),
      name: "compact",
    }),
    defineHookContribution({
      mergeClass: "FirstWins",
      name: "compact-gate",
      point: "compaction-gate",
      run: options.decideCompaction ?? continueCompaction,
    }),
  ],
  manifest: {
    capabilities: [],
    description: "Compacts the current Session Branch.",
    name: "compact",
    version: "1.0.0",
  } satisfies PluginManifest,
});

export const compactPlugin = makeCompactPlugin();
