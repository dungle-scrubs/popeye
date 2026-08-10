import { Effect } from "effect";
import { expect, test } from "vitest";

import { InteractionTimeout, ProtocolError, StaleRevision } from "./errors.js";

test("ProtocolError is recoverable by tag and preserves its reason", async () => {
  const result = await Effect.runPromise(
    Effect.fail(
      new ProtocolError({
        message: "The command is not valid while the session is settling.",
        reason: "phase_invalid_command",
      }),
    ).pipe(Effect.catchTag("ProtocolError", (error) => Effect.succeed(error.reason))),
  );

  expect(result).toBe("phase_invalid_command");
});

test("StaleRevision is recoverable by tag and preserves its actual revision", async () => {
  const result = await Effect.runPromise(
    Effect.fail(new StaleRevision({ actual: 9, expected: 8 })).pipe(
      Effect.catchTag("StaleRevision", (error) => Effect.succeed(error.actual)),
    ),
  );

  expect(result).toBe(9);
});

test("InteractionTimeout is recoverable by tag and preserves its timeout", async () => {
  const result = await Effect.runPromise(
    Effect.fail(new InteractionTimeout({ requestId: "request-7", timeoutMs: 30_000 })).pipe(
      Effect.catchTag("InteractionTimeout", (error) => Effect.succeed(error.timeoutMs)),
    ),
  );

  expect(result).toBe(30_000);
});
