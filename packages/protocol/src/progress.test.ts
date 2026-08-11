import { Schema } from "effect";
import { expect, test } from "vitest";

import { ProgressSchema } from "./progress.js";

test("Progress frames round-trip every transient hint variant", () => {
  const frames = [
    { _tag: "assistantText", text: "answer" },
    { _tag: "assistantThinking", text: "reasoning" },
    {
      _tag: "compactionApplied",
      compactionEntryId: "entry-compact",
      entriesCovered: 5,
      sliceCount: 2,
      summaryLength: 120,
    },
    { _tag: "compactionStarted", entriesCovered: 5, sliceCount: 2 },
    { _tag: "followUpQueued", content: "next" },
    { _tag: "phaseChanged", phase: "EXECUTING" },
    { _tag: "progressDropped", count: 3 },
    { _tag: "providerRetryScheduled", attempt: 2, delayMs: 1_000 },
    { _tag: "steeringApplied", content: "focus" },
    { _tag: "steeringQueued", content: "focus" },
    { _tag: "turnQueued", content: "next" },
    { _tag: "toolCompleted", isError: false, toolCallId: "tool-1" },
    { _tag: "toolStarted", name: "read", toolCallId: "tool-1" },
    { _tag: "turnSettled", revision: 20, stopReason: "truncated" },
  ] as const;

  for (const frame of frames) {
    const decoded = Schema.decodeUnknownSync(ProgressSchema, {
      onExcessProperty: "error",
    })(frame);
    expect(Schema.encodeSync(ProgressSchema)(decoded)).toEqual(frame);
  }
});
