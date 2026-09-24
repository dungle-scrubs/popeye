import { SessionIdSchema } from "@dungle-scrubs/popeye-journal";
import { Effect } from "effect";
import { expect, test } from "vitest";

import {
  BudgetExceeded,
  CompactionDisabled,
  GateRejected,
  NothingToCompact,
  ProviderError,
  ToolError,
} from "./errors.js";

test("ProviderError is recoverable by tag and preserves its transient field", async () => {
  const result = await Effect.runPromise(
    Effect.fail(
      new ProviderError({
        message: "The provider returned an unavailable response.",
        status: 503,
        transient: true,
      }),
    ).pipe(Effect.catchTag("ProviderError", (error) => Effect.succeed(error.transient))),
  );

  expect(result).toBe(true);
});

test("ToolError is recoverable by tag and preserves its tool name", async () => {
  const result = await Effect.runPromise(
    Effect.fail(
      new ToolError({
        message: "The tool could not read the requested file.",
        toolCallId: "call-4",
        toolName: "read_file",
      }),
    ).pipe(Effect.catchTag("ToolError", (error) => Effect.succeed(error.toolName))),
  );

  expect(result).toBe("read_file");
});

test("GateRejected is recoverable by tag and preserves its reason", async () => {
  const result = await Effect.runPromise(
    Effect.fail(
      new GateRejected({ plugin: "workspace-guard", reason: "filesystem write is denied" }),
    ).pipe(Effect.catchTag("GateRejected", (error) => Effect.succeed(error.reason))),
  );

  expect(result).toBe("filesystem write is denied");
});

test("BudgetExceeded is recoverable by tag and preserves its required budget", async () => {
  const result = await Effect.runPromise(
    Effect.fail(
      new BudgetExceeded({
        budget: 1_000,
        optionsDiagnostic: "minimum retained context is 1,200 tokens",
        required: 1_200,
      }),
    ).pipe(Effect.catchTag("BudgetExceeded", (error) => Effect.succeed(error.required))),
  );

  expect(result).toBe(1_200);
});

test("Compaction precondition failures are recoverable by their tags", async () => {
  const nothing = new NothingToCompact({
    message: "Nothing to compact.",
    sessionId: SessionIdSchema.make("session"),
  });
  const disabled = new CompactionDisabled({
    message: "Compaction disabled.",
    sessionId: SessionIdSchema.make("session"),
  });

  expect(nothing._tag).toBe("NothingToCompact");
  expect(disabled._tag).toBe("CompactionDisabled");
});
