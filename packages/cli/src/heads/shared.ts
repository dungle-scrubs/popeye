/**
 * Owns output pacing and exit status shared by the in-process Heads.
 * It exists so every Head waits for stdout and assigns the same code to each terminal stop reason.
 */
import type { Writable } from "node:stream";

import { Cause, Chunk, Data, Effect, Exit, Logger, Option } from "effect";

import type { DriverSnapshot, TurnResult } from "../compose.js";

/**
 * 0: done or truncated; 1: provider-settled error; 2: aborted; 3: unresolved tool calls;
 * 4: a typed turn failure, defect, interruption, or other Head boundary failure.
 */
export const HEAD_EXIT_CODES = {
  aborted: 2,
  done: 0,
  error: 1,
  /** Defensive default: the kernel currently consumes tool calls and never settles a Head here. */
  toolCalls: 3,
  truncated: 0,
  turnFailure: 4,
} as const;

const STOP_REASON_EXIT_CODES = {
  aborted: HEAD_EXIT_CODES.aborted,
  done: HEAD_EXIT_CODES.done,
  error: HEAD_EXIT_CODES.error,
  toolCalls: HEAD_EXIT_CODES.toolCalls,
  truncated: HEAD_EXIT_CODES.truncated,
} as const satisfies Readonly<Record<TurnResult["stopReason"], number>>;

export type HeadExitCode = (typeof HEAD_EXIT_CODES)[keyof typeof HEAD_EXIT_CODES];

export class HeadWriteError extends Data.TaggedError("HeadWriteError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export interface HeadWriter {
  readonly write: (text: string) => Effect.Effect<void, HeadWriteError>;
}

export interface HeadErrorEnvelope {
  readonly _tag: "headError";
  readonly error: {
    readonly kind: "defect" | "failure" | "interruption";
    readonly message: string;
    readonly tag: string;
  };
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
export const stderrHeadWriter = makeWritableHeadWriter(process.stderr);

export const makeWritableLogfmtLogger = (output: Writable) =>
  Logger.make((options) => {
    output.write(`${Logger.logfmtLogger.log(options)}\n`);
  });

export const exitCodeForStopReason = (stopReason: TurnResult["stopReason"]): HeadExitCode =>
  STOP_REASON_EXIT_CODES[stopReason];

export const errorMessage = (value: unknown): string => {
  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message;
  }
  return String(value);
};

export const errorTag = (value: unknown, fallback: string): string => {
  if (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    typeof value._tag === "string"
  ) {
    return value._tag;
  }
  return value instanceof Error ? value.name : fallback;
};

export const headErrorEnvelope = <TFailure>(cause: Cause.Cause<TFailure>): HeadErrorEnvelope => {
  const failure = Option.getOrUndefined(Cause.failureOption(cause));
  if (failure !== undefined) {
    return {
      _tag: "headError",
      error: {
        kind: "failure",
        message: errorMessage(failure),
        tag: errorTag(failure, "Failure"),
      },
    };
  }

  const defect = Option.getOrUndefined(Chunk.head(Cause.defects(cause)));
  if (defect !== undefined) {
    return {
      _tag: "headError",
      error: {
        kind: "defect",
        message: errorMessage(defect),
        tag: errorTag(defect, "Defect"),
      },
    };
  }

  return {
    _tag: "headError",
    error: {
      kind: "interruption",
      message: "Head execution was interrupted.",
      tag: "Interrupted",
    },
  };
};

export const runHeadBoundary = <TFailure, TRequirements>(
  program: Effect.Effect<HeadExitCode, TFailure, TRequirements>,
  terminalErrorWriter: HeadWriter,
): Effect.Effect<HeadExitCode, HeadWriteError, TRequirements> =>
  Effect.exit(program).pipe(
    Effect.flatMap((exit) => {
      if (Exit.isSuccess(exit)) {
        return Effect.succeed(exit.value);
      }
      const line = `${JSON.stringify(headErrorEnvelope(exit.cause))}\n`;
      return terminalErrorWriter.write(line).pipe(Effect.as(HEAD_EXIT_CODES.turnFailure));
    }),
  );

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
