/**
 * Owns the mailbox, turn execution, tools, steering, recovery, context fold, ai seam, and driver head.
 * It exists to coordinate a session while keeping pi-ai access confined to its ai seam.
 */
export const kernelPackage = "@peye/kernel";

export { BudgetExceeded, GateRejected, ProviderError, ToolError } from "./errors.js";
