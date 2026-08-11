import { Schema } from "effect";
import { expect, test } from "vitest";

import { InteractionRequestSchema, InteractionResponseSchema } from "./interactions.js";

test("Interaction request frames carry id, kind, timeout, and declared fallback", () => {
  const requests = [
    {
      _tag: "interaction-request",
      fallback: { kind: "select", value: "safe" },
      id: "interaction-select",
      kind: "select",
      options: [
        { label: "Safe", value: "safe" },
        { label: "Fast", value: "fast" },
      ],
      prompt: "Choose a mode.",
      timeoutMs: 30_000,
    },
    {
      _tag: "interaction-request",
      fallback: { kind: "confirm", value: false },
      id: "interaction-confirm",
      kind: "confirm",
      prompt: "Continue?",
      timeoutMs: 15_000,
    },
    {
      _tag: "interaction-request",
      fallback: { kind: "input", value: "default name" },
      id: "interaction-input",
      kind: "input",
      placeholder: "Session name",
      prompt: "Name this Session.",
      timeoutMs: 20_000,
    },
  ] as const;
  const responses = [
    {
      _tag: "interaction-response",
      id: "interaction-select",
      kind: "select",
      value: "safe",
    },
    {
      _tag: "interaction-response",
      id: "interaction-confirm",
      kind: "confirm",
      value: true,
    },
    {
      _tag: "interaction-response",
      id: "interaction-input",
      kind: "input",
      value: "M20",
    },
  ] as const;

  for (const request of requests) {
    const decoded = Schema.decodeUnknownSync(InteractionRequestSchema, {
      onExcessProperty: "error",
    })(request);
    expect(Schema.encodeSync(InteractionRequestSchema)(decoded)).toEqual(request);
  }
  for (const response of responses) {
    const decoded = Schema.decodeUnknownSync(InteractionResponseSchema, {
      onExcessProperty: "error",
    })(response);
    expect(Schema.encodeSync(InteractionResponseSchema)(decoded)).toEqual(response);
  }
});
