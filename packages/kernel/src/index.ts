/**
 * Owns the mailbox, turn execution, tools, steering, recovery, context fold, ai seam, and driver head.
 * It exists to coordinate a session while keeping pi-ai access confined to its ai seam.
 */
export const kernelPackage = "@peye/kernel";

export {
  BudgetExceeded,
  GateRejected,
  MailboxClosed,
  MailboxFull,
  MailboxSessionNotFound,
  ProviderError,
  ToolError,
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
  type SessionInfo,
  type SessionSummary,
  Sessions,
  type SessionsFailure,
  SessionsLive,
  type SessionsService,
} from "./sessions.js";
