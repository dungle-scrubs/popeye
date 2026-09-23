import { SessionIdSchema } from "@popeye/journal";
import { Schema } from "effect";
import { expect, test } from "vitest";

import { createCapabilityGrants, grantedCapabilities, hasCapability } from "./capability.js";

test("Capability grants are per Session", () => {
  const firstSession = Schema.decodeSync(SessionIdSchema)("session-a");
  const secondSession = Schema.decodeSync(SessionIdSchema)("session-b");
  const firstGrants = createCapabilityGrants(firstSession, ["shell"]);
  const secondGrants = createCapabilityGrants(secondSession);

  expect(hasCapability(firstGrants, "shell")).toBe(true);
  expect(hasCapability(secondGrants, "shell")).toBe(false);
  expect(firstGrants.sessionId).toBe(firstSession);
  expect(secondGrants.sessionId).toBe(secondSession);
});

test("Grants expose a sorted copy", () => {
  const sessionId = Schema.decodeSync(SessionIdSchema)("session-grants");
  const grants = createCapabilityGrants(sessionId, ["shell", "network", "shell"]);

  const visible = grantedCapabilities(grants);

  expect(visible).toEqual(["network", "shell"]);
  expect(visible).not.toBe(grants.capabilities);
});

test("Grant names must be non-empty and trimmed", () => {
  const sessionId = Schema.decodeSync(SessionIdSchema)("session-invalid-grants");

  expect(() => createCapabilityGrants(sessionId, [""])).toThrow(
    "capability name must be non-empty and trimmed",
  );
  expect(() => createCapabilityGrants(sessionId, [" shell "])).toThrow(
    "capability name must be non-empty and trimmed",
  );
});
