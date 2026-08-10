import { expect, test } from "vitest";

import { InteractionTimeout, ProtocolError, StaleRevision } from "./errors.js";

test("ProtocolError constructs with its declared fields and round-trips them", () => {
  const error = new ProtocolError({
    message: "The command is not valid while the session is settling.",
    reason: "phase_invalid_command",
  });

  expect(error).toMatchObject({
    _tag: "ProtocolError",
    message: "The command is not valid while the session is settling.",
    reason: "phase_invalid_command",
  });
});

test("StaleRevision constructs with its declared fields and round-trips them", () => {
  const error = new StaleRevision({ actual: 9, expected: 8 });

  expect(error).toMatchObject({
    _tag: "StaleRevision",
    actual: 9,
    expected: 8,
  });
});

test("InteractionTimeout constructs with its declared fields and round-trips them", () => {
  const error = new InteractionTimeout({ requestId: "request-7", timeoutMs: 30_000 });

  expect(error).toMatchObject({
    _tag: "InteractionTimeout",
    requestId: "request-7",
    timeoutMs: 30_000,
  });
});
