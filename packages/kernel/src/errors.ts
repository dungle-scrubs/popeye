/**
 * Owns kernel failures so turn coordination can preserve actionable causes in typed channels.
 * It exists to prevent provider, tool, gate, and budget concerns from leaking into heads.
 */

import type { SessionId } from "@peye/journal";
import { Data } from "effect";

export class ProviderError extends Data.TaggedError("ProviderError")<{
  readonly message: string;
  readonly status?: number;
  readonly transient: boolean;
}> {}

export class ToolError extends Data.TaggedError("ToolError")<{
  readonly message: string;
  readonly toolCallId: string;
  readonly toolName: string;
}> {}

export class GateRejected extends Data.TaggedError("GateRejected")<{
  readonly plugin: string;
  readonly reason: string;
}> {}

export class BudgetExceeded extends Data.TaggedError("BudgetExceeded")<{
  readonly budget: number;
  readonly optionsDiagnostic: string;
  readonly required: number;
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
