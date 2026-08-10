import { expect, test } from "vitest";

import * as kernel from "./index.js";

test("exports the kernel package marker", () => {
  expect(kernel.kernelPackage).toBe("@peye/kernel");
});

test("exports every public kernel failure", () => {
  expect(kernel.BudgetExceeded).toBeDefined();
  expect(kernel.GateRejected).toBeDefined();
  expect(kernel.MailboxClosed).toBeDefined();
  expect(kernel.MailboxFull).toBeDefined();
  expect(kernel.MailboxSessionNotFound).toBeDefined();
  expect(kernel.ProviderError).toBeDefined();
  expect(kernel.ToolError).toBeDefined();
});
