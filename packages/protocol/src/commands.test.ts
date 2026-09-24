import { Schema } from "effect";
import { expect, test } from "vitest";

import { CommandSchema } from "./commands.js";

const sessionId = "session-20";

test("Schema frames exist for every kernel primitive and invoke-command", () => {
  const frames = [
    { _tag: "create", id: "create-1" },
    { _tag: "resume", id: "resume-1", sessionId },
    { _tag: "list", id: "list-1" },
    {
      _tag: "prompt",
      content: "Inspect the repository.",
      deliveryMode: "steer",
      expectedRevision: 3,
      id: "prompt-1",
      sessionId,
    },
    { _tag: "steer", content: "Focus on protocol.", id: "steer-1", sessionId },
    { _tag: "abort", id: "abort-1", sessionId },
    { _tag: "close", id: "close-1", sessionId },
    {
      _tag: "get-snapshot",
      afterEntryId: "entry-1",
      beforeEntryId: "entry-9",
      id: "snapshot-1",
      sessionId,
    },
    { _tag: "subscribe-progress", id: "progress-1", sessionId },
    {
      _tag: "branch",
      expectedRevision: 4,
      id: "branch-1",
      sessionId,
      toEntryId: "entry-4",
    },
    {
      _tag: "fork",
      expectedRevision: 4,
      fromEntryId: "entry-4",
      id: "fork-1",
      sessionId,
    },
    {
      _tag: "set-model",
      expectedRevision: 5,
      id: "model-1",
      model: "provider/model",
      sessionId,
    },
    {
      _tag: "set-thinking",
      expectedRevision: 6,
      id: "thinking-1",
      sessionId,
      thinkingLevel: "high",
    },
    {
      _tag: "invoke-command",
      args: { retainedTailCount: 8 },
      expectedRevision: 7,
      id: "invoke-1",
      name: "popeye/compact",
      sessionId,
    },
  ] as const;

  for (const frame of frames) {
    const decoded = Schema.decodeUnknownSync(CommandSchema, {
      onExcessProperty: "error",
    })(frame);
    expect(Schema.encodeSync(CommandSchema)(decoded)).toEqual(frame);
  }
});
