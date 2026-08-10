import { SessionIdSchema } from "@peye/journal";
import { Schema } from "effect";
import { expect, test } from "vitest";

import { createCapabilityGrants, grantedCapabilities, hasCapability } from "./capability.js";

test("Capability grants are per session", () => {
  const firstSession = Schema.decodeSync(SessionIdSchema)("session-a");
  const secondSession = Schema.decodeSync(SessionIdSchema)("session-b");
  const firstGrants = createCapabilityGrants(firstSession, ["shell"]);
  const secondGrants = createCapabilityGrants(secondSession);

  expect(hasCapability(firstGrants, "shell")).toBe(true);
  expect(hasCapability(secondGrants, "shell")).toBe(false);
  expect(firstGrants.sessionId).toBe(firstSession);
  expect(secondGrants.sessionId).toBe(secondSession);
});

test("Grant set is visible in the snapshot", () => {
  const sessionId = Schema.decodeSync(SessionIdSchema)("session-snapshot");
  const grants = createCapabilityGrants(sessionId, ["shell", "network", "shell"]);

  const visible = grantedCapabilities(grants);

  expect(visible).toEqual(["network", "shell"]);
  expect(visible).not.toBe(grants.capabilities);
});
