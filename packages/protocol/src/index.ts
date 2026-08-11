/**
 * Owns frame schemas, snapshot and progress types, command unions, and interaction requests.
 * It exists as a kernel-independent contract shared by every head.
 */
export const protocolPackage = "@peye/protocol";

export {
  COMMAND_TAGS,
  type Command,
  CommandSchema,
  THINKING_LEVELS,
  ThinkingLevelSchema,
} from "./commands.js";
export {
  decodeCommand,
  decodeInteractionRequest,
  decodeInteractionResponse,
  decodeProgress,
  decodeResponse,
  decodeSnapshot,
} from "./decoding.js";
export {
  InteractionTimeout,
  ProtocolError,
  type ProtocolErrorReason,
  StaleRevision,
} from "./errors.js";
export {
  ConfirmFallbackSchema,
  InputFallbackSchema,
  InteractionFallbackSchema,
  type InteractionRequest,
  InteractionRequestSchema,
  type InteractionResponse,
  InteractionResponseSchema,
  SelectFallbackSchema,
  SelectOptionSchema,
} from "./interactions.js";
export {
  PROGRESS_TAGS,
  type Progress,
  ProgressSchema,
  StopReasonSchema,
  type UnknownProgress,
  UnknownProgressSchema,
} from "./progress.js";
export {
  type AbortTurnResult,
  AbortTurnResultSchema,
  type AckResult,
  AckResultSchema,
  type CompactionResult,
  CompactionResultSchema,
  type InvokeCommandResult,
  InvokeCommandResultSchema,
  ProgressSubscriptionResultSchema,
  type RecoveryReport,
  RecoveryReportSchema,
  type Response,
  ResponseResultSchema,
  ResponseSchema,
  type ResumedSessionInfo,
  ResumedSessionInfoSchema,
  type SessionInfo,
  SessionInfoSchema,
  type SessionListResult,
  SessionListResultSchema,
  type SessionSummary,
  SessionSummarySchema,
  type SnapshotResult,
  SnapshotResultSchema,
  type TurnResult,
  TurnResultSchema,
  type WireError,
  WireErrorCodeSchema,
  WireErrorSchema,
} from "./results.js";
export {
  CapabilityNameSchema,
  EntryRangeSchema,
  LoadedGenerationSchema,
  type Snapshot,
  SnapshotSchema,
  SnapshotThinkingLevelSchema,
  TurnPhaseSchema,
} from "./snapshot.js";
