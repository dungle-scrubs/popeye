/**
 * Owns the first-party Session naming Plugin.
 * It exists so Session naming uses a Command Contribution instead of a built-in command path.
 */
import { defineCommandContribution, type PluginManifest } from "@peye/plugins";
import { Schema } from "effect";

export const sessionNamePlugin = {
  contributions: [
    defineCommandContribution({
      arguments: Schema.Struct({ name: Schema.NonEmptyString }),
      description: "Set the current Session name.",
      execute: ({ name }, context) => context.setSessionName(name),
      name: "session-name",
    }),
  ],
  manifest: {
    capabilities: [],
    description: "Names the current Session.",
    name: "session-name",
    version: "1.0.0",
  } satisfies PluginManifest,
} as const;
