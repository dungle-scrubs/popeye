import { expect, test } from "vitest";

import * as kernel from "./index.js";

test("exports the kernel package marker", () => {
  expect(kernel.kernelPackage).toBe("@peye/kernel");
});

test("exports every public kernel failure", () => {
  expect(kernel.BudgetExceeded).toBeDefined();
  expect(kernel.CompactionDisabled).toBeDefined();
  expect(kernel.DuplicateToolName).toBeDefined();
  expect(kernel.GateRejected).toBeDefined();
  expect(kernel.MailboxClosed).toBeDefined();
  expect(kernel.MailboxFull).toBeDefined();
  expect(kernel.MailboxSessionNotFound).toBeDefined();
  expect(kernel.NothingToCompact).toBeDefined();
  expect(kernel.ProviderError).toBeDefined();
  expect(kernel.ToolError).toBeDefined();
});

test("exports the record and recovery seams", () => {
  expect(kernel.OperationIdSchema).toBeDefined();
  expect(kernel.OperationStartedPayloadSchema).toBeDefined();
  expect(kernel.ToolStartedPayloadSchema).toBeDefined();
  expect(kernel.OperationFinishedPayloadSchema).toBeDefined();
  expect(kernel.appendOperationStarted).toBeTypeOf("function");
  expect(kernel.appendToolStarted).toBeTypeOf("function");
  expect(kernel.appendOperationFinished).toBeTypeOf("function");
  expect(kernel.boundedRecoveryRecords).toBeTypeOf("function");
  expect(kernel.recoverSession).toBeTypeOf("function");
  expect(kernel.applyRecoveryPlan).toBeTypeOf("function");
});

test("exports the Compaction policy seam for explicit plugin commands", () => {
  expect(kernel.Compaction).toBeDefined();
  expect(kernel.CompactionLive).toBeTypeOf("function");
  expect(kernel.DEFAULT_COMPACTION_POLICY).toBeDefined();
});

test("exports schemas for every Driver result and option shape", () => {
  expect(kernel.AbortTurnResultSchema).toBeDefined();
  expect(kernel.CompactionResultSchema).toBeDefined();
  expect(kernel.DriverSnapshotSchema).toBeDefined();
  expect(kernel.RecoveryReportSchema).toBeDefined();
  expect(kernel.ResumedSessionInfoSchema).toBeDefined();
  expect(kernel.SessionInfoSchema).toBeDefined();
  expect(kernel.SessionSummarySchema).toBeDefined();
  expect(kernel.TurnOptionsSchema).toBeDefined();
  expect(kernel.TurnResultSchema).toBeDefined();
});

test("exports the known-good Driver layer composition", () => {
  expect(kernel.DriverDefault).toBeTypeOf("function");
});
