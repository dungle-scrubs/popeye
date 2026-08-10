/**
 * Owns the Plugin manifest Schema and its trust-boundary decoder.
 * It exists so invalid Plugin identity and Capability declarations fail before loading begins.
 */
import { Effect, ParseResult, Schema } from "effect";

import { CapabilityNameSchema } from "./capability.js";
import { PluginLoadError } from "./errors.js";

const kebabName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_NAME_SEGMENT_LENGTH = 64;

const nameSegmentSchema = (label: string) =>
  Schema.String.pipe(
    Schema.filter((name) => name.length > 0 && name === name.trim(), {
      message: () => `${label} must be non-empty and trimmed`,
    }),
    Schema.maxLength(MAX_NAME_SEGMENT_LENGTH, {
      message: () => `${label} must be at most ${MAX_NAME_SEGMENT_LENGTH} characters`,
    }),
    Schema.pattern(kebabName, { message: () => `${label} must use kebab-case` }),
  );

export const PluginNameSchema = nameSegmentSchema("name");
export const ContributionNameSchema = nameSegmentSchema("contribution name");

const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const CapabilityDeclarationSchema = Schema.Struct({
  name: CapabilityNameSchema,
  required: Schema.optional(Schema.Boolean),
});

const CapabilityDeclarationsSchema = Schema.Array(CapabilityDeclarationSchema).pipe(
  Schema.filter(
    (capabilities) =>
      new Set(capabilities.map((capability) => capability.name)).size === capabilities.length,
    { message: () => "capabilities must not contain duplicate names" },
  ),
);

export const PluginManifestSchema = Schema.Struct({
  capabilities: CapabilityDeclarationsSchema,
  description: Schema.optional(Schema.String),
  name: PluginNameSchema,
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
    Effect.mapError((schemaCause) => {
      const [firstIssue] = ParseResult.ArrayFormatter.formatErrorSync(schemaCause);
      const message =
        firstIssue?._tag === "Unexpected"
          ? "manifest must not contain unknown fields"
          : (firstIssue?.message ?? "manifest does not match the Schema");
      return new PluginLoadError({
        cause: "manifest_invalid",
        message: `Invalid Plugin manifest: ${message}.`,
        plugin: pluginNameFrom(input),
        schemaCause,
      });
    }),
  );
