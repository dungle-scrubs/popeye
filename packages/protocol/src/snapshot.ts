/**
 * Owns the authoritative Snapshot frame rendered by Heads.
 * It exists so every Head receives the complete Branch and the same inspection fields.
 */

import { Schema } from "effect";
import { EntryIdSchema, EntrySchema, SessionIdSchema } from "#journal";

import { THINKING_LEVELS } from "./commands.js";
import { NonNegativeIntegerSchema, OtherEnumValueSchema } from "./schema-common.js";

const TURN_PHASES = ["ASSEMBLING", "EXECUTING", "IDLE", "SETTLING", "STREAMING"] as const;

type KnownTurnPhase = (typeof TURN_PHASES)[number];

const KnownTurnPhaseSchema = Schema.Literal(...TURN_PHASES);

const isKnownTurnPhase = (value: string): value is KnownTurnPhase =>
  (TURN_PHASES as ReadonlyArray<string>).includes(value);

export const TurnPhaseSchema = Schema.transform(
  Schema.NonEmptyString,
  Schema.Union(KnownTurnPhaseSchema, OtherEnumValueSchema),
  {
    decode: (value) => (isKnownTurnPhase(value) ? value : { _tag: "other" as const, value }),
    encode: (_encoded, value) => (typeof value === "string" ? value : value.value),
  },
);

type KnownThinkingLevel = (typeof THINKING_LEVELS)[number];

const KnownThinkingLevelSchema = Schema.Literal(...THINKING_LEVELS);

const isKnownThinkingLevel = (value: string): value is KnownThinkingLevel =>
  (THINKING_LEVELS as ReadonlyArray<string>).includes(value);

export const SnapshotThinkingLevelSchema = Schema.transform(
  Schema.NonEmptyString,
  Schema.Union(KnownThinkingLevelSchema, OtherEnumValueSchema),
  {
    decode: (value) => (isKnownThinkingLevel(value) ? value : { _tag: "other" as const, value }),
    encode: (_encoded, value) => (typeof value === "string" ? value : value.value),
  },
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
  /** Reserved for a Head composed with the plugin host. The Driver does not supply this field. */
  capabilityGrants: Schema.optional(Schema.Array(CapabilityNameSchema)),
  entries: Schema.Array(EntrySchema),
  entryRange: Schema.optional(EntryRangeSchema),
  /** Derived from DriverSnapshot.leaf.id. */
  leafEntryId: EntryIdSchema,
  /** Reserved for a Head composed with the plugin host. The Driver does not supply this field. */
  loadedGeneration: Schema.optional(LoadedGenerationSchema),
  model: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  phase: TurnPhaseSchema,
  revision: NonNegativeIntegerSchema,
  sessionId: SessionIdSchema,
  thinkingLevel: Schema.optional(SnapshotThinkingLevelSchema),
});

export type Snapshot = Schema.Schema.Type<typeof SnapshotSchema>;
