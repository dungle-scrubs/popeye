import { Schema } from "effect";
import { expect, test } from "vitest";

import { AbortTurnResultSchema, CompactionResultSchema, ResponseSchema } from "./results.js";

const leaf = {
  id: "entry-root",
  kind: "session_root",
  parentId: null,
  payload: {},
} as const;

const expectRoundTrip = <TType, TEncoded>(
  schema: Schema.Schema<TType, TEncoded>,
  value: unknown,
): void => {
  const decoded = Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  const encoded = Schema.encodeSync(schema)(decoded);

  expect(encoded).toEqual(value);
  expect(Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(encoded)).toEqual(decoded);
};

test("AbortTurnResult preserves every tagged outcome through both directions", () => {
  const results = [
    {
      _tag: "abortTurnNotAborted",
      aborted: false,
      reason: "none",
      turnOrdinal: undefined,
    },
    {
      _tag: "abortTurnNotAborted",
      aborted: false,
      reason: "settling",
      turnOrdinal: 2,
    },
    { _tag: "abortTurnAborted", aborted: true, turnOrdinal: 3 },
    {
      _tag: "abortTurnLoopPrevented",
      aborted: true,
      note: "loop-prevented",
      turnOrdinal: 4,
    },
  ] as const;

  for (const result of results) {
    expectRoundTrip(AbortTurnResultSchema, result);
  }
});

test("CompactionResult remains an invoke-command payload, not a bare Response result", () => {
  const compaction = {
    compactionEntryId: "entry-compact",
    entriesCovered: 8,
    sliceCount: 2,
    summaryLength: 240,
  } as const;

  expectRoundTrip(CompactionResultSchema, compaction);
  expect(() =>
    Schema.decodeUnknownSync(ResponseSchema, { onExcessProperty: "error" })({
      id: "compact-response",
      result: compaction,
    }),
  ).toThrow();
});

test("Response round-trips every tagged result family through both directions", () => {
  const responses = [
    { id: "ack-response", result: { _tag: "ack" } },
    {
      id: "snapshot-response",
      result: {
        _tag: "snapshot",
        entries: [leaf],
        leafEntryId: "entry-root",
        phase: "IDLE",
        revision: 20,
        sessionId: "session-20",
      },
    },
    { id: "turn-response", result: { _tag: "turn", stopReason: "done" } },
    {
      id: "abort-not-aborted-response",
      result: {
        _tag: "abortTurnNotAborted",
        aborted: false,
        reason: "none",
        turnOrdinal: undefined,
      },
    },
    {
      id: "abort-response",
      result: { _tag: "abortTurnAborted", aborted: true, turnOrdinal: 1 },
    },
    {
      id: "abort-loop-response",
      result: {
        _tag: "abortTurnLoopPrevented",
        aborted: true,
        note: "loop-prevented",
        turnOrdinal: 2,
      },
    },
    {
      id: "create-response",
      result: { _tag: "sessionCreated", id: "session-20", leaf, revision: 0 },
    },
    {
      id: "list-response",
      result: {
        _tag: "sessionList",
        sessions: [{ id: "session-20", revision: 20 }],
      },
    },
    {
      id: "resume-response",
      result: {
        _tag: "sessionResumed",
        id: "session-20",
        leaf,
        recovery: {
          actions: [
            {
              action: "synthesized_interrupted",
              replay: "never",
              toolCallId: "tool-1",
              toolName: "read",
            },
          ],
          entriesAppended: ["entry-recovered"],
          operationIdFound: undefined,
          safeReplay: [],
        },
        revision: 21,
      },
    },
    {
      id: "invoke-response",
      result: {
        _tag: "commandInvoked",
        commandName: "peye/compact",
        value: { entriesCovered: 8 },
      },
    },
    {
      id: "progress-response",
      result: {
        _tag: "progressSubscribed",
        initial: { _tag: "phaseChanged", phase: "IDLE" },
        sessionId: "session-20",
        subscribed: true,
      },
    },
  ] as const;

  for (const response of responses) {
    expectRoundTrip(ResponseSchema, response);
  }
});

test("Response round-trips the error family", () => {
  expectRoundTrip(ResponseSchema, {
    error: {
      code: "stale_revision",
      details: { actual: 20, expected: 19 },
      message: "Expected revision 19, current revision is 20.",
    },
    id: "snapshot-response",
  });
});
