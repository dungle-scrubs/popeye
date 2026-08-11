/**
 * Owns output pacing and exit status shared by the in-process Heads.
 * It exists so every Head waits for stdout and assigns the same code to each terminal stop reason.
 */
import type { Writable } from "node:stream";

import { Data, Effect } from "effect";

import type { DriverSnapshot, TurnResult } from "../compose.js";

/** 0: done or truncated; 1: error; 2: aborted; 3: unresolved tool calls. */
export const HEAD_EXIT_CODES = {
  aborted: 2,
  done: 0,
  error: 1,
  toolCalls: 3,
  truncated: 0,
} as const satisfies Readonly<Record<TurnResult["stopReason"], number>>;

export type HeadExitCode = (typeof HEAD_EXIT_CODES)[keyof typeof HEAD_EXIT_CODES];

export class HeadWriteError extends Data.TaggedError("HeadWriteError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export interface HeadWriter {
  readonly write: (text: string) => Effect.Effect<void, HeadWriteError>;
}

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

export const makeWritableHeadWriter = (output: Writable): HeadWriter => ({
  write: (text) =>
    Effect.async<void, HeadWriteError>((resume) => {
      let waitingForDrain = false;

      const cleanup = (): void => {
        output.off("drain", onDrain);
        output.off("error", onError);
      };
      const onDrain = (): void => {
        cleanup();
        resume(Effect.void);
      };
      const onError = (cause: Error): void => {
        cleanup();
        resume(
          Effect.fail(
            new HeadWriteError({
              cause,
              message: `Head output failed: ${cause.message}`,
            }),
          ),
        );
      };

      output.once("error", onError);
      try {
        waitingForDrain = !output.write(text);
      } catch (cause) {
        onError(asError(cause));
        return;
      }
      if (waitingForDrain) {
        output.once("drain", onDrain);
      } else {
        cleanup();
        resume(Effect.void);
      }

      return Effect.sync(() => {
        if (waitingForDrain) {
          cleanup();
        }
      });
    }),
});

export const stdoutHeadWriter = makeWritableHeadWriter(process.stdout);

export const exitCodeForStopReason = (stopReason: TurnResult["stopReason"]): HeadExitCode =>
  HEAD_EXIT_CODES[stopReason];

export const finalAssistantText = (snapshot: DriverSnapshot): string => {
  for (let index = snapshot.entries.length - 1; index >= 0; index -= 1) {
    const entry = snapshot.entries[index];
    if (entry?.kind !== "message" || typeof entry.payload !== "object" || entry.payload === null) {
      continue;
    }
    const payload = entry.payload as { readonly content?: unknown; readonly role?: unknown };
    if (payload.role === "assistant" && typeof payload.content === "string") {
      return payload.content;
    }
  }
  return "";
};
