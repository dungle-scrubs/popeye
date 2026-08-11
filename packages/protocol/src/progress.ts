/**
 * Owns transient Progress frames streamed to Heads while work runs.
 * It exists to keep hints separate from the authoritative Snapshot contract.
 */

import { Schema } from "effect";
import { EntryIdSchema } from "#journal";

import { TurnPhaseSchema } from "./snapshot.js";

export const StopReasonSchema = Schema.Literal(
  "aborted",
  "done",
  "error",
  "toolCalls",
  "truncated",
);

export const ProgressSchema = Schema.Union(
  Schema.TaggedStruct("assistantText", { text: Schema.String }),
  Schema.TaggedStruct("assistantThinking", { text: Schema.String }),
  Schema.TaggedStruct("compactionApplied", {
    compactionEntryId: EntryIdSchema,
    entriesCovered: Schema.Number.pipe(Schema.int(), Schema.positive()),
    sliceCount: Schema.Number.pipe(Schema.int(), Schema.positive()),
    summaryLength: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  }),
  Schema.TaggedStruct("compactionStarted", {
    entriesCovered: Schema.Number.pipe(Schema.int(), Schema.positive()),
    sliceCount: Schema.Number.pipe(Schema.int(), Schema.positive()),
  }),
  Schema.TaggedStruct("followUpQueued", { content: Schema.String }),
  Schema.TaggedStruct("phaseChanged", { phase: TurnPhaseSchema }),
  Schema.TaggedStruct("progressDropped", { count: Schema.Number }),
  Schema.TaggedStruct("providerRetryScheduled", {
    attempt: Schema.Number,
    delayMs: Schema.Number,
  }),
  Schema.TaggedStruct("steeringApplied", { content: Schema.String }),
  Schema.TaggedStruct("steeringQueued", { content: Schema.String }),
  Schema.TaggedStruct("turnQueued", { content: Schema.String }),
  Schema.TaggedStruct("toolCompleted", {
    isError: Schema.Boolean,
    toolCallId: Schema.String,
  }),
  Schema.TaggedStruct("toolStarted", {
    name: Schema.String,
    toolCallId: Schema.String,
  }),
  Schema.TaggedStruct("turnSettled", {
    revision: Schema.Number,
    stopReason: StopReasonSchema,
  }),
);

export type Progress = Schema.Schema.Type<typeof ProgressSchema>;
