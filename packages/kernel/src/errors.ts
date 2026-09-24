/**
 * Owns kernel failures so turn coordination can preserve actionable causes in typed channels.
 * It exists to prevent provider, tool, gate, and budget concerns from leaking into heads.
 */

import type { EntryId, SessionId } from "@dungle-scrubs/popeye-journal";
import { Data } from "effect";

import type { ProviderUsage } from "./provider.js";

export class ProviderError extends Data.TaggedError("ProviderError")<{
  readonly message: string;
  readonly status?: number;
  readonly transient: boolean;
  readonly usage?: ProviderUsage;
}> {}

export class ToolError extends Data.TaggedError("ToolError")<{
  readonly message: string;
  readonly toolCallId: string;
  readonly toolName: string;
}> {}

export class DuplicateToolName extends Data.TaggedError("DuplicateToolName")<{
  readonly message: string;
  readonly name: string;
}> {}

export class GateRejected extends Data.TaggedError("GateRejected")<{
  readonly plugin: string;
  readonly reason: string;
}> {}

export class BudgetExceeded extends Data.TaggedError("BudgetExceeded")<{
  readonly budget: number;
  readonly compactionApplied?: EntryId;
  readonly optionsDiagnostic: string;
  readonly required: number;
}> {}

export class NothingToCompact extends Data.TaggedError("NothingToCompact")<{
  readonly message: string;
  readonly sessionId: SessionId;
}> {}

export class CompactionDisabled extends Data.TaggedError("CompactionDisabled")<{
  readonly message: string;
  readonly sessionId: SessionId;
}> {}

export class MailboxFull extends Data.TaggedError("MailboxFull")<{
  readonly capacity: number;
  readonly sessionId: SessionId;
}> {}

export class MailboxSessionNotFound extends Data.TaggedError("MailboxSessionNotFound")<{
  readonly sessionId: SessionId;
}> {}

export class MailboxClosed extends Data.TaggedError("MailboxClosed")<{
  readonly sessionId: SessionId;
}> {}

export class TurnQueueFull extends Data.TaggedError("TurnQueueFull")<{
  readonly capacity: number;
  readonly queue: "followUp" | "steering";
  readonly sessionId: SessionId;
}> {}
