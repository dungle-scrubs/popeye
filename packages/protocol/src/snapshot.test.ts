import { Schema } from "effect";
import { expect, test } from "vitest";

import { SnapshotSchema } from "./snapshot.js";

test("Snapshot schema carries the full transcript and inspection fields", () => {
  const snapshot = {
    capabilityGrants: ["filesystem-read", "shell"],
    entries: [
      {
        id: "entry-root",
        kind: "session_root",
        parentId: null,
        payload: {},
      },
      {
        id: "entry-user",
        kind: "message",
        parentId: "entry-root",
        payload: {
          content: "Keep this exact Entry payload.",
          nested: { value: 20 },
          role: "user",
        },
      },
    ],
    leafEntryId: "entry-user",
    loadedGeneration: {
      id: "generation-20",
      plugins: ["peye-compact", "peye-session-name"],
    },
    model: "provider/model",
    phase: "STREAMING",
    revision: 20,
    sessionId: "session-20",
    sessionName: "Protocol work",
    thinkingLevel: "high",
  } as const;

  const decoded = Schema.decodeUnknownSync(SnapshotSchema, {
    onExcessProperty: "error",
  })(snapshot);

  expect(Schema.encodeSync(SnapshotSchema)(decoded)).toEqual(snapshot);
  expect(decoded.entries[1]?.payload).toEqual(snapshot.entries[1]?.payload);
});

test("Entry-id addressing is present in the Snapshot schema", () => {
  const snapshot = {
    capabilityGrants: [],
    entries: [
      {
        id: "entry-root",
        kind: "session_root",
        parentId: null,
        payload: {},
      },
    ],
    entryRange: {
      afterEntryId: null,
      beforeEntryId: null,
      hasMoreAfter: false,
      hasMoreBefore: false,
    },
    leafEntryId: "entry-root",
    loadedGeneration: { id: "generation-20", plugins: [] },
    phase: "IDLE",
    revision: 0,
    sessionId: "session-20",
  } as const;

  const decoded = Schema.decodeUnknownSync(SnapshotSchema, {
    onExcessProperty: "error",
  })(snapshot);

  expect(Schema.encodeSync(SnapshotSchema)(decoded)).toEqual(snapshot);
});
