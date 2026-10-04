import { Schema } from "effect";
import { expect, test } from "vitest";

import { ThinkingChangePayloadSchema } from "./entry-payloads.js";
import { ThinkingLevelSchema } from "./provider.js";

test("Kernel thinking level schema accepts explicit off", () => {
  expect(Schema.decodeUnknownSync(ThinkingLevelSchema)("off")).toBe("off");
});

test("thinking_change payload accepts and round-trips explicit off", () => {
  const payload = { thinkingLevel: "off" };
  const decoded = Schema.decodeUnknownSync(ThinkingChangePayloadSchema, {
    onExcessProperty: "error",
  })(payload);
  expect(Schema.encodeSync(ThinkingChangePayloadSchema)(decoded)).toEqual(payload);
});
