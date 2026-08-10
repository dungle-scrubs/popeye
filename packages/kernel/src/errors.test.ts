import { expect, test } from "vitest";

import { BudgetExceeded, GateRejected, ProviderError, ToolError } from "./errors.js";

test("ProviderError constructs with its declared fields and round-trips them", () => {
  const error = new ProviderError({
    message: "The provider returned an unavailable response.",
    status: 503,
    transient: true,
  });

  expect(error).toMatchObject({
    _tag: "ProviderError",
    message: "The provider returned an unavailable response.",
    status: 503,
    transient: true,
  });
});

test("ToolError constructs with its declared fields and round-trips them", () => {
  const error = new ToolError({
    message: "The tool could not read the requested file.",
    toolCallId: "call-4",
    toolName: "read_file",
  });

  expect(error).toMatchObject({
    _tag: "ToolError",
    message: "The tool could not read the requested file.",
    toolCallId: "call-4",
    toolName: "read_file",
  });
});

test("GateRejected constructs with its declared fields and round-trips them", () => {
  const error = new GateRejected({
    plugin: "workspace-guard",
    reason: "filesystem write is denied",
  });

  expect(error).toMatchObject({
    _tag: "GateRejected",
    plugin: "workspace-guard",
    reason: "filesystem write is denied",
  });
});

test("BudgetExceeded constructs with its declared fields and round-trips them", () => {
  const error = new BudgetExceeded({
    budget: 1_000,
    optionsDiagnostic: "minimum retained context is 1,200 tokens",
    required: 1_200,
  });

  expect(error).toMatchObject({
    _tag: "BudgetExceeded",
    budget: 1_000,
    optionsDiagnostic: "minimum retained context is 1,200 tokens",
    required: 1_200,
  });
});
