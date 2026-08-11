/**
 * Owns the first-party Session naming Plugin.
 * It exists so Session naming uses a Command Contribution instead of a built-in command path.
 */
import { defineCommandContribution, type PluginManifest } from "@pop-eye/plugins";
import { Schema } from "effect";

const SESSION_NAME_MAX_LENGTH = 200;
const SessionNameSchema = Schema.String.pipe(
  Schema.filter((name) => name.trim().length > 0, {
    message: () => "Session name must contain a non-whitespace character",
  }),
  Schema.maxLength(SESSION_NAME_MAX_LENGTH, {
    message: () => `Session name must be at most ${SESSION_NAME_MAX_LENGTH} characters`,
  }),
);

export const sessionNamePlugin = {
  contributions: [
    defineCommandContribution({
      arguments: Schema.Struct({ name: SessionNameSchema }),
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
