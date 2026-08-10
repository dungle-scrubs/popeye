/**
 * Owns the mailbox, turn execution, tools, steering, recovery, context fold, ai seam, and driver head.
 * It exists to coordinate a session while keeping pi-ai access confined to its ai seam.
 */
export const kernelPackage = "@peye/kernel";

export { type PiAiProviderLayerOptions, PiAiProviderLive } from "./ai/seam.js";
export {
  Compaction,
  type CompactionFailure,
  CompactionLive,
  type CompactionPolicyOptions,
  type CompactionResult,
  type CompactionService,
  compactBranch,
  DEFAULT_COMPACTION_POLICY,
  type ResolvedCompactionPolicyOptions,
  resolveCompactionPolicyOptions,
} from "./compaction-policy.js";
export {
  Driver,
  type DriverFailure,
  DriverLive,
  type DriverService,
  type DriverSnapshot,
  DriverSnapshotSchema,
} from "./driver.js";
export {
  BudgetExceeded,
  CompactionDisabled,
  DuplicateToolName,
  GateRejected,
  MailboxClosed,
  MailboxFull,
  MailboxSessionNotFound,
  NothingToCompact,
  ProviderError,
  ToolError,
  TurnQueueFull,
} from "./errors.js";
export {
  MAILBOX_CAPACITY,
  Mailbox,
  type MailboxCommand,
  type MailboxFailure,
  MailboxLive,
  type MailboxOptions,
  type MailboxResult,
  type MailboxService,
} from "./mailbox.js";
export {
  PROGRESS_CAPACITY,
  type Progress,
  ProgressHub,
  ProgressHubLive,
  ProgressSchema,
  type ProgressService,
  type TurnPhase,
  TurnPhaseSchema,
} from "./progress.js";
export {
  ASSISTANT_STOP_REASONS,
  type AssistantItem,
  type AssistantStopReason,
  asContextToolCalls,
  type ContextItem,
  type ContextToolCall,
  Provider,
  type ProviderService,
  type ProviderStreamOptions,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "./provider.js";
export {
  appendOperationFinished,
  appendOperationStarted,
  appendToolStarted,
  createOperationId,
  type OperationFinishedPayload,
  OperationFinishedPayloadSchema,
  type OperationId,
  OperationIdSchema,
  type OperationOutcome,
  OperationOutcomeSchema,
  type OperationStartedPayload,
  OperationStartedPayloadSchema,
  type ToolReplay,
  ToolReplaySchema,
  type ToolStartedPayload,
  ToolStartedPayloadSchema,
} from "./records.js";
export {
  applyRecoveryPlan,
  boundedRecoveryRecords,
  type RecoveryAction,
  type RecoveryApplicationOptions,
  type RecoveryPlan,
  type RecoveryReport,
  recoverSession,
  type SafeReplayCall,
} from "./recovery.js";
export {
  type ResumedSessionInfo,
  type SessionInfo,
  type SessionSummary,
  Sessions,
  type SessionsFailure,
  SessionsLive,
  type SessionsOptions,
  type SessionsService,
} from "./sessions.js";
export {
  defineTool,
  type RegisteredTool,
  type Tool,
  type ToolExecutionContext,
  type ToolExecutionMode,
  ToolRegistry,
  ToolRegistryLive,
  type ToolRegistryService,
  type ToolResult,
} from "./tool.js";
export {
  DEFAULT_TOOL_CONCURRENCY,
  executeToolBatch,
  type ToolBatchOptions,
  type ToolBatchResult,
  type ToolBatchResults,
  type ToolCall,
} from "./tool-batch.js";
export {
  DEFAULT_RETRY_BASE_DELAY_MS,
  TURN_INPUT_QUEUE_CAPACITY,
  type TurnFailure,
  type TurnOptions,
  type TurnResult,
  Turns,
  TurnsLive,
  type TurnsService,
} from "./turn.js";
