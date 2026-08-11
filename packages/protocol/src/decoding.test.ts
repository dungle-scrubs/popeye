import { Effect } from "effect";
import { expect, test } from "vitest";

import {
  decodeCommand,
  decodeInteractionRequest,
  decodeInteractionResponse,
  decodeProgress,
  decodeResponse,
  decodeSnapshot,
} from "./decoding.js";
import { ProtocolError } from "./errors.js";

const leaf = {
  id: "entry-root",
  kind: "session_root",
  parentId: null,
  payload: {},
} as const;

const snapshot = {
  entries: [leaf],
  leafEntryId: "entry-root",
  phase: "IDLE",
  revision: 0,
  sessionId: "session-20",
} as const;

test("Malformed frames decode to typed ProtocolError", async () => {
  const malformed: ReadonlyArray<Effect.Effect<unknown, ProtocolError>> = [
    decodeCommand({ _tag: "prompt", content: "missing Session", extra: true }),
    decodeSnapshot({ phase: "IDLE" }),
    decodeProgress({ _tag: "toolStarted", toolCallId: "tool-1" }),
    decodeInteractionRequest({
      _tag: "interaction-request",
      id: "interaction-1",
      kind: "confirm",
      prompt: "Continue?",
      timeoutMs: 1_000,
    }),
    decodeInteractionResponse({
      _tag: "interaction-response",
      id: "interaction-1",
      kind: "confirm",
      value: "yes",
    }),
    decodeResponse({ error: {}, result: {} }),
  ];

  const errors = await Effect.runPromise(
    Effect.forEach(malformed, (frame) =>
      Effect.flip(frame).pipe(
        Effect.mapError(() => new Error("Malformed fixture decoded successfully.")),
        Effect.orDie,
      ),
    ),
  );
  for (const error of errors) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect(error.reason).toBe("malformed_frame");
  }

  const unknown = await Effect.runPromise(
    Effect.flip(decodeCommand({ _tag: "future-command", payload: {} })),
  );
  expect(unknown).toBeInstanceOf(ProtocolError);
  expect(unknown.reason).toBe("unknown_command");
});

test("Snapshot decoding ignores fields added by a newer Kernel", async () => {
  const decoded = await Effect.runPromise(
    decodeSnapshot({ ...snapshot, kernelBuild: "future", snapshotFormat: 2 }),
  );

  expect(decoded).toEqual(snapshot);
});

test("Progress decoding ignores new fields on a known variant", async () => {
  const decoded = await Effect.runPromise(
    decodeProgress({
      _tag: "toolStarted",
      name: "read",
      providerMetadata: { cached: true },
      toolCallId: "tool-1",
    }),
  );

  expect(decoded).toEqual({ _tag: "toolStarted", name: "read", toolCallId: "tool-1" });
});

test("an unknown Progress variant decodes to a preserved passthrough", async () => {
  const frame = {
    _tag: "contextWindowMeasured",
    capacity: 128_000,
    nested: { source: "newer-kernel" },
  } as const;

  await expect(Effect.runPromise(decodeProgress(frame))).resolves.toEqual({
    _tag: "unknownProgress",
    frame,
  });
});

test("new enum values decode to explicit other values", async () => {
  const decodedSnapshot = await Effect.runPromise(
    decodeSnapshot({ ...snapshot, phase: "PAUSED", thinkingLevel: "ultra" }),
  );
  const decodedProgress = await Effect.runPromise(
    decodeProgress({ _tag: "turnSettled", revision: 1, stopReason: "superseded" }),
  );

  expect(decodedSnapshot.phase).toEqual({ _tag: "other", value: "PAUSED" });
  expect(decodedSnapshot.thinkingLevel).toEqual({ _tag: "other", value: "ultra" });
  expect(decodedProgress).toEqual({
    _tag: "turnSettled",
    revision: 1,
    stopReason: { _tag: "other", value: "superseded" },
  });
});
