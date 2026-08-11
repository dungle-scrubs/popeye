import { Schema } from "effect";
import { expect, test } from "vitest";

import {
  AbortTurnResultSchema,
  CompactionResultSchema,
  InvokeCommandResultSchema,
  ResponseSchema,
  ResumedSessionInfoSchema,
  SessionInfoSchema,
  SessionSummarySchema,
  TurnResultSchema,
} from "./results.js";

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
  expect(Schema.encodeSync(schema)(decoded)).toEqual(value);
};

test("Result and response frames cover the seven driver result families", () => {
  expectRoundTrip(TurnResultSchema, { stopReason: "done" });
  expectRoundTrip(AbortTurnResultSchema, { aborted: true, turnOrdinal: 1 });
  expectRoundTrip(CompactionResultSchema, {
    compactionEntryId: "entry-compact",
    entriesCovered: 8,
    sliceCount: 2,
    summaryLength: 240,
  });
  expectRoundTrip(SessionInfoSchema, { id: "session-20", leaf, revision: 0 });
  expectRoundTrip(SessionSummarySchema, { id: "session-20", revision: 20 });
  expectRoundTrip(ResumedSessionInfoSchema, {
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
      safeReplay: [],
    },
    revision: 21,
  });
  expectRoundTrip(InvokeCommandResultSchema, {
    commandName: "peye/compact",
    value: { entriesCovered: 8 },
  });

  const success = {
    id: "snapshot-response",
    result: {
      capabilityGrants: ["shell"],
      entries: [leaf],
      leafEntryId: "entry-root",
      loadedGeneration: { id: "generation-20", plugins: [] },
      phase: "IDLE",
      revision: 20,
      sessionId: "session-20",
    },
  } as const;
  const failure = {
    error: {
      code: "stale_revision",
      details: { actual: 20, expected: 19 },
      message: "Expected revision 19, current revision is 20.",
    },
    id: "snapshot-response",
  } as const;

  for (const response of [success, failure]) {
    const decoded = Schema.decodeUnknownSync(ResponseSchema, {
      onExcessProperty: "error",
    })(response);
    expect(Schema.encodeSync(ResponseSchema)(decoded)).toEqual(response);
  }
});
