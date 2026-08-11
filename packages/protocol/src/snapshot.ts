/**
 * Owns the authoritative Snapshot frame rendered by Heads.
 * It exists so every Head receives the complete Branch and the same inspection fields.
 */

import { Schema } from "effect";
import { EntryIdSchema, EntrySchema, SessionIdSchema } from "#journal";

import { ThinkingLevelSchema } from "./commands.js";
import { NonNegativeIntegerSchema } from "./schema-common.js";

export const TurnPhaseSchema = Schema.Literal(
  "ASSEMBLING",
  "EXECUTING",
  "IDLE",
  "SETTLING",
  "STREAMING",
);

export const CapabilityNameSchema = Schema.String.pipe(
  Schema.filter((name) => name.length > 0 && name === name.trim(), {
    message: () => "capability name must be non-empty and trimmed",
  }),
);

export const LoadedGenerationSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  plugins: Schema.Array(Schema.NonEmptyString),
});

export const EntryRangeSchema = Schema.Struct({
  afterEntryId: Schema.NullOr(EntryIdSchema),
  beforeEntryId: Schema.NullOr(EntryIdSchema),
  hasMoreAfter: Schema.Boolean,
  hasMoreBefore: Schema.Boolean,
});

export const SnapshotSchema = Schema.Struct({
  capabilityGrants: Schema.Array(CapabilityNameSchema),
  entries: Schema.Array(EntrySchema),
  entryRange: Schema.optional(EntryRangeSchema),
  leafEntryId: EntryIdSchema,
  loadedGeneration: LoadedGenerationSchema,
  model: Schema.optional(Schema.NonEmptyString),
  phase: TurnPhaseSchema,
  revision: NonNegativeIntegerSchema,
  sessionId: SessionIdSchema,
  sessionName: Schema.optional(Schema.String),
  thinkingLevel: Schema.optional(ThinkingLevelSchema),
});

export type Snapshot = Schema.Schema.Type<typeof SnapshotSchema>;
