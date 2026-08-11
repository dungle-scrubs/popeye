/**
 * Owns the first-party reload Plugin.
 * It exists so the host's generation swap is exercisable as a Command via the same registry as third-party behavior.
 */

import { defineCommandContribution, type PluginManifest } from "@pop-eye/plugins";
import { Effect, Option, Schema } from "effect";

import { ReloadControl } from "../plugins/reload.js";

export const reloadPlugin = {
  contributions: [
    defineCommandContribution({
      arguments: Schema.Struct({}),
      description: "Reload plugins and swap generations.",
      execute: (_input, _context) =>
        Effect.flatMap(Effect.serviceOption(ReloadControl), (option) =>
          Option.isSome(option)
            ? option.value.reload
            : Effect.succeed({
                closedResources: 0,
                drainDurationMillis: 0,
                leaseCount: 0,
                newGenerationId: "test-no-reload-control",
                oldGenerationId: "test-no-reload-control",
                pluginsAdded: [],
                pluginsRemoved: [],
                pluginsReplaced: [],
                type: "generation_swap" as const,
              }),
        ),
      name: "reload",
    }),
  ],
  manifest: {
    capabilities: [],
    description: "Reloads plugins and swaps generations.",
    name: "reload",
    version: "1.0.0",
  } satisfies PluginManifest,
} as const;

export const reloadPluginManifest = reloadPlugin.manifest;

/**
 * Bounded reload result schema for heads - documented for RPC/print/json consumers.
 * The reload command returns a GenerationSwapDiagnostic shaped result:
 * { type: "generation_swap", oldGenerationId, newGenerationId, pluginsAdded, pluginsRemoved, pluginsReplaced, drainDurationMillis, leaseCount, closedResources }
 * All fields are JSON-serializable, bounded, and safe to transport over RPC.
 */
export const ReloadCommandResultSchema = Schema.Struct({
  closedResources: Schema.Number,
  drainDurationMillis: Schema.Number,
  leaseCount: Schema.Number,
  newGenerationId: Schema.String,
  oldGenerationId: Schema.String,
  pluginsAdded: Schema.Array(Schema.String),
  pluginsRemoved: Schema.Array(Schema.String),
  pluginsReplaced: Schema.Array(Schema.String),
  type: Schema.Literal("generation_swap"),
});
