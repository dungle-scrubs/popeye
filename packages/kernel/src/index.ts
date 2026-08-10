/**
 * Owns the mailbox, turn execution, tools, steering, recovery, context fold, ai seam, and driver head.
 * It exists to coordinate a session while keeping pi-ai access confined to its ai seam.
 */
export const kernelPackage = "@peye/kernel";

export {
  BudgetExceeded,
  GateRejected,
  MailboxFull,
  MailboxSessionNotFound,
  ProviderError,
  ToolError,
} from "./errors.js";
export {
  MAILBOX_CAPACITY,
  Mailbox,
  type MailboxCommand,
  type MailboxCommandOutput,
  type MailboxFailure,
  MailboxLive,
  type MailboxResult,
  type MailboxService,
} from "./mailbox.js";
export {
  type SessionInfo,
  type SessionSummary,
  Sessions,
  SessionsLive,
  type SessionsService,
} from "./sessions.js";
