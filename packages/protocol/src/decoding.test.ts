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
