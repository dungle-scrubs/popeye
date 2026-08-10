/**
 * Owns the Plugin manifest Schema and its trust-boundary decoder.
 * It exists so invalid Plugin identity and Capability declarations fail before loading begins.
 */
import { Effect, Schema } from "effect";

import { PluginLoadError } from "./errors.js";

const kebabName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const CapabilityDeclarationSchema = Schema.Struct({
  name: Schema.NonEmptyTrimmedString,
  required: Schema.optional(Schema.Boolean),
});

export const PluginManifestSchema = Schema.Struct({
  capabilities: Schema.Array(CapabilityDeclarationSchema),
  description: Schema.optional(Schema.String),
  name: Schema.String.pipe(
    Schema.pattern(kebabName, { message: () => "name must use kebab-case" }),
  ),
  version: Schema.String.pipe(
    Schema.pattern(semver, { message: () => "version must be a semantic version" }),
  ),
});

export type CapabilityDeclaration = Schema.Schema.Type<typeof CapabilityDeclarationSchema>;
export type PluginManifest = Schema.Schema.Type<typeof PluginManifestSchema>;

const pluginNameFrom = (input: unknown): string => {
  if (typeof input !== "object" || input === null || !("name" in input)) {
    return "<unknown>";
  }
  return typeof input.name === "string" ? input.name : "<unknown>";
};

export const decodePluginManifest = (
  input: unknown,
): Effect.Effect<PluginManifest, PluginLoadError> =>
  Schema.decodeUnknown(PluginManifestSchema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(
      (cause) =>
        new PluginLoadError({
          cause: "manifest_invalid",
          message: `Invalid Plugin manifest: ${String(cause)}`,
          plugin: pluginNameFrom(input),
        }),
    ),
  );
