/**
 * Owns transient Progress frames streamed to Heads while work runs.
 * It exists to keep hints separate from the authoritative Snapshot contract.
 */

import { Schema } from "effect";
import { EntryIdSchema } from "#journal";

import {
  NonNegativeIntegerSchema,
  OtherEnumValueSchema,
  PositiveIntegerSchema,
} from "./schema-common.js";
import { TurnPhaseSchema } from "./snapshot.js";

const STOP_REASONS = ["aborted", "done", "error", "toolCalls", "truncated"] as const;

type KnownStopReason = (typeof STOP_REASONS)[number];

const KnownStopReasonSchema = Schema.Literal(...STOP_REASONS);

const isKnownStopReason = (value: string): value is KnownStopReason =>
  (STOP_REASONS as ReadonlyArray<string>).includes(value);

export const StopReasonSchema = Schema.transform(
  Schema.NonEmptyString,
  Schema.Union(KnownStopReasonSchema, OtherEnumValueSchema),
  {
    decode: (value) => (isKnownStopReason(value) ? value : { _tag: "other" as const, value }),
    encode: (_encoded, value) => (typeof value === "string" ? value : value.value),
  },
);

export const PROGRESS_TAGS = [
  "assistantText",
  "assistantThinking",
  "compactionApplied",
  "compactionStarted",
  "followUpQueued",
  "phaseChanged",
  "progressDropped",
  "providerRetryScheduled",
  "steeringApplied",
  "steeringQueued",
  "turnQueued",
  "toolCompleted",
  "toolStarted",
  "turnSettled",
] as const;

const progressTags: ReadonlySet<string> = new Set(PROGRESS_TAGS);

const KnownProgressSchema = Schema.Union(
  Schema.TaggedStruct("assistantText", { text: Schema.String }),
  Schema.TaggedStruct("assistantThinking", { text: Schema.String }),
  Schema.TaggedStruct("compactionApplied", {
    compactionEntryId: EntryIdSchema,
    entriesCovered: PositiveIntegerSchema,
    sliceCount: PositiveIntegerSchema,
    summaryLength: NonNegativeIntegerSchema,
  }),
  Schema.TaggedStruct("compactionStarted", {
    entriesCovered: PositiveIntegerSchema,
    sliceCount: PositiveIntegerSchema,
  }),
  Schema.TaggedStruct("followUpQueued", { content: Schema.String }),
  Schema.TaggedStruct("phaseChanged", { phase: TurnPhaseSchema }),
  Schema.TaggedStruct("progressDropped", { count: PositiveIntegerSchema }),
  Schema.TaggedStruct("providerRetryScheduled", {
    attempt: PositiveIntegerSchema,
    delayMs: NonNegativeIntegerSchema,
  }),
  Schema.TaggedStruct("steeringApplied", { content: Schema.String }),
  Schema.TaggedStruct("steeringQueued", { content: Schema.String }),
  Schema.TaggedStruct("turnQueued", { content: Schema.String }),
  Schema.TaggedStruct("toolCompleted", {
    isError: Schema.Boolean,
    toolCallId: Schema.NonEmptyString,
  }),
  Schema.TaggedStruct("toolStarted", {
    name: Schema.String,
    toolCallId: Schema.NonEmptyString,
  }),
  Schema.TaggedStruct("turnSettled", {
    revision: NonNegativeIntegerSchema,
    stopReason: StopReasonSchema,
  }),
);

const UnknownProgressFrameSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
}).pipe(
  Schema.filter(
    (frame): frame is Readonly<Record<string, unknown>> & { readonly _tag: string } =>
      typeof frame._tag === "string" && !progressTags.has(frame._tag),
    { message: () => "unknown Progress must have an unrecognized string _tag" },
  ),
);

const UnknownProgressValueSchema = Schema.TaggedStruct("unknownProgress", {
  frame: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

export const UnknownProgressSchema = Schema.transform(
  UnknownProgressFrameSchema,
  UnknownProgressValueSchema,
  {
    decode: (frame) => ({ _tag: "unknownProgress" as const, frame }),
    encode: (_encoded, value) => value.frame,
    strict: false,
  },
);

export const ProgressSchema = Schema.Union(KnownProgressSchema, UnknownProgressSchema);

export type Progress = Schema.Schema.Type<typeof ProgressSchema>;

export type UnknownProgress = Schema.Schema.Type<typeof UnknownProgressSchema>;
