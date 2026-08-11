/**
 * Owns command result payloads and correlated success or error response envelopes.
 * It exists so Heads decode kernel results and failures without importing the Kernel package.
 */

import { Schema } from "effect";
import { EntryIdSchema, EntrySchema, SessionIdSchema } from "#journal";

import { ProgressSchema, StopReasonSchema } from "./progress.js";
import { NonNegativeIntegerSchema, PositiveIntegerSchema } from "./schema-common.js";
import { SnapshotSchema } from "./snapshot.js";

export const OperationIdSchema = Schema.NonEmptyString.pipe(Schema.brand("OperationId"));

export const ToolReplaySchema = Schema.Literal("never", "safe");

export const ToolRecoveryActionSchema = Schema.Struct({
  action: Schema.Literal(
    "already_resolved",
    "safe_replay",
    "synthesized_interrupted",
    "synthesized_missing_tool",
  ),
  replay: ToolReplaySchema,
  toolCallId: Schema.NonEmptyString,
  toolName: Schema.NonEmptyString,
});

export const RecoveryActionSchema = Schema.Union(
  ToolRecoveryActionSchema,
  Schema.Struct({
    action: Schema.Literal("orphaned_prompt_closed"),
    promptEntryId: EntryIdSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("unrecoverable-on-this-branch"),
    operationId: OperationIdSchema,
    promptEntryId: EntryIdSchema,
  }),
);

export const SafeReplayCallSchema = Schema.Struct({
  argumentsJson: Schema.String,
  name: Schema.NonEmptyString,
  operationId: OperationIdSchema,
  toolCallId: Schema.NonEmptyString,
});

export const RecoveryReportSchema = Schema.Struct({
  actions: Schema.Array(RecoveryActionSchema),
  entriesAppended: Schema.Array(EntryIdSchema),
  operationIdFound: Schema.UndefinedOr(OperationIdSchema),
  safeReplay: Schema.Array(SafeReplayCallSchema),
});

export type RecoveryReport = Schema.Schema.Type<typeof RecoveryReportSchema>;

export const TurnResultSchema = Schema.TaggedStruct("turn", {
  stopReason: StopReasonSchema,
});

export type TurnResult = Schema.Schema.Type<typeof TurnResultSchema>;

export const AbortTurnResultSchema = Schema.Union(
  Schema.TaggedStruct("abortTurnNotAborted", {
    aborted: Schema.Literal(false),
    reason: Schema.Literal("none", "settling"),
    turnOrdinal: Schema.UndefinedOr(PositiveIntegerSchema),
  }),
  Schema.TaggedStruct("abortTurnAborted", {
    aborted: Schema.Literal(true),
    turnOrdinal: PositiveIntegerSchema,
  }),
  Schema.TaggedStruct("abortTurnLoopPrevented", {
    aborted: Schema.Literal(true),
    note: Schema.Literal("loop-prevented"),
    turnOrdinal: PositiveIntegerSchema,
  }),
);

export type AbortTurnResult = Schema.Schema.Type<typeof AbortTurnResultSchema>;

export const CompactionResultSchema = Schema.Struct({
  compactionEntryId: EntryIdSchema,
  entriesCovered: PositiveIntegerSchema,
  sliceCount: PositiveIntegerSchema,
  summaryLength: NonNegativeIntegerSchema,
});

export type CompactionResult = Schema.Schema.Type<typeof CompactionResultSchema>;

export const SessionInfoSchema = Schema.TaggedStruct("sessionCreated", {
  id: SessionIdSchema,
  leaf: EntrySchema,
  revision: NonNegativeIntegerSchema,
});

export type SessionInfo = Schema.Schema.Type<typeof SessionInfoSchema>;

export const SessionSummarySchema = Schema.Struct({
  id: SessionIdSchema,
  revision: NonNegativeIntegerSchema,
});

export type SessionSummary = Schema.Schema.Type<typeof SessionSummarySchema>;

export const SessionListResultSchema = Schema.TaggedStruct("sessionList", {
  sessions: Schema.Array(SessionSummarySchema),
});

export type SessionListResult = Schema.Schema.Type<typeof SessionListResultSchema>;

export const ResumedSessionInfoSchema = Schema.TaggedStruct("sessionResumed", {
  id: SessionIdSchema,
  leaf: EntrySchema,
  recovery: RecoveryReportSchema,
  revision: NonNegativeIntegerSchema,
});

export type ResumedSessionInfo = Schema.Schema.Type<typeof ResumedSessionInfoSchema>;

export const InvokeCommandResultSchema = Schema.TaggedStruct("commandInvoked", {
  commandName: Schema.NonEmptyString,
  value: Schema.Unknown,
});

export type InvokeCommandResult = Schema.Schema.Type<typeof InvokeCommandResultSchema>;

export const ProgressSubscriptionResultSchema = Schema.TaggedStruct("progressSubscribed", {
  initial: Schema.optional(ProgressSchema),
  sessionId: SessionIdSchema,
  subscribed: Schema.Literal(true),
});

export const AckResultSchema = Schema.TaggedStruct("ack", {});

export type AckResult = Schema.Schema.Type<typeof AckResultSchema>;

export const SnapshotResultSchema = Schema.TaggedStruct("snapshot", SnapshotSchema.fields);

export type SnapshotResult = Schema.Schema.Type<typeof SnapshotResultSchema>;

export const ResponseResultSchema = Schema.Union(
  AckResultSchema,
  SnapshotResultSchema,
  TurnResultSchema,
  AbortTurnResultSchema,
  SessionInfoSchema,
  SessionListResultSchema,
  ResumedSessionInfoSchema,
  InvokeCommandResultSchema,
  ProgressSubscriptionResultSchema,
);

export type ResponseResult = Schema.Schema.Type<typeof ResponseResultSchema>;

export const WireErrorCodeSchema = Schema.Literal(
  "budget_exceeded",
  "compaction_disabled",
  "gate_rejected",
  "interaction_timeout",
  "invoke_command_error",
  "journal_error",
  "mailbox_closed",
  "mailbox_full",
  "nothing_to_compact",
  "plugin_load_error",
  "protocol_error",
  "provider_error",
  "session_not_found",
  "stale_revision",
  "tool_error",
  "turn_queue_full",
);

export const WireErrorSchema = Schema.Struct({
  code: WireErrorCodeSchema,
  details: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  message: Schema.String,
});

export type WireError = Schema.Schema.Type<typeof WireErrorSchema>;

export const ResponseSchema = Schema.Union(
  Schema.Struct({
    id: Schema.optional(Schema.String),
    result: ResponseResultSchema,
  }),
  Schema.Struct({
    error: WireErrorSchema,
    id: Schema.optional(Schema.String),
  }),
);

export type Response = Schema.Schema.Type<typeof ResponseSchema>;
