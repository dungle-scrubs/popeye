/**
 * Owns HeadWire deep module for wire encoding, exit codes, and boundary handling.
 * It exists so snapshot pagination, wire Schema validation, exit-code mapping, and error envelope hide behind one deep interface.
 *
 * Why this module: a former shared.ts grab-bag (256 lines) owned HeadWriter + HEAD_EXIT_CODES + protocolSnapshot (SnapshotView pagination + Effect.runSync log side-effect) + runHeadBoundary + finalAssistantText, each with an interface as complex as its implementation. Every Head (print, json, rpc) re-derived wire encoding independently - json.ts did Schema.encode(SnapshotSchema), print.ts extracted finalAssistantText, rpc-session-bridge called protocolSnapshot again. Bugs (exit-code mapping, snapshot warning log, Schema encode) hid between the helpers, and adding a Snapshot audit field touched all three Heads plus the grab-bag - 4 hops for one concept.
 *
 * This module hides SnapshotView pagination, wire Schema validation, warning/paginated log side-effects, exit-code mapping, and boundary envelope behind encodeSnapshotLine / encodeProgressLine / exitCodeForStopReason / runHeadBoundary. Heads become thin adapters that pick a line formatter; the wire contract is tested through HeadWire, not by spinning a Head. Deep module over SnapshotView (C2 architecture review): bounded emission, range addressing, and reassembly hide behind snapshotView; HeadWire consumes that seam and adds wire Schema encoding.
 *
 * Not responsible for Session lifecycle (HeadSessionLoop owns create/resume/progress subscription/exit-code sequencing), for byte framing or per-Session FIFO (RpcTransport owns LF/1MB/U+2028 provenance), or for dispatch policy (RpcDispatcher owns queue caps). The seam is process I/O: two adapters justify it — LiveHeadWire over real SnapshotSchema/ProgressSchema + FakeHeadWire over fixture Snapshots in tests (heads.test.ts proves the same wire contract without byte hacks). See @popeye/protocol snapshotView.
 */

import type { Writable } from "node:stream";
import {
  ProgressSchema,
  reassembleSnapshots,
  type Snapshot,
  SnapshotSchema,
  snapshotView,
} from "@popeye/protocol";
import { Cause, Chunk, Data, Effect, Exit, Logger, Option, Schema } from "effect";

import type { DriverSnapshot, TurnResult } from "../compose.js";

export type SnapshotAuditFields = Required<Pick<Snapshot, "capabilityGrants" | "loadedGeneration">>;

export const protocolSnapshot = (
  snapshot: DriverSnapshot,
  snapshotAudit: SnapshotAuditFields | undefined,
) => {
  const paginated = snapshotView.paginateSnapshot({
    ...(snapshotAudit?.capabilityGrants === undefined
      ? {}
      : { capabilityGrants: snapshotAudit.capabilityGrants }),
    entries: snapshot.entries,
    leafEntryId: snapshot.leaf.id,
    ...(snapshotAudit?.loadedGeneration === undefined
      ? {}
      : { loadedGeneration: snapshotAudit.loadedGeneration }),
    ...(snapshot.model === undefined ? {} : { model: snapshot.model }),
    ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
    phase: snapshot.phase as Snapshot["phase"],
    revision: snapshot.revision,
    sessionId: snapshot.sessionId,
    ...(snapshot.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: snapshot.thinkingLevel as Snapshot["thinkingLevel"] }),
  });
  // Emit warning diagnostic via log when over 256 KiB but not paginated - visible in spans
  if (paginated.warning && !paginated.isPaginated) {
    Effect.runSync(Effect.logInfo(`snapshot warning - ${paginated.encodedBytes} bytes > 262144`));
  }
  if (paginated.isPaginated) {
    Effect.runSync(
      Effect.logInfo(
        `snapshot paginated - ${paginated.encodedBytes} bytes, ${paginated.snapshot.entries.length}/${snapshot.entries.length} entries, range ${JSON.stringify(paginated.snapshot.entryRange)}`,
      ),
    );
  }
  return paginated.snapshot;
};

/**
 * 0: done or truncated; 1: provider-settled error; 2: aborted; 3: unresolved tool calls;
 * 4: a typed turn failure, defect, interruption, or other Head boundary failure. CLI entry also
 * uses 2 for invalid arguments and missing configuration. Scripts must read stderr to distinguish
 * those CLI failures from an aborted turn.
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

export const reassembleFullSnapshot = (windows: ReadonlyArray<Snapshot>): Snapshot =>
  reassembleSnapshots(windows);

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

// ---------------------------------------------------------------------------
// Wire encoding — consolidates SnapshotView pagination + Schema validation
// so json.ts / rpc heads no longer re-derive it per Head.
// ---------------------------------------------------------------------------

export const encodeProgressLine = (progress: unknown): Effect.Effect<string, unknown> =>
  Schema.decodeUnknown(ProgressSchema, { onExcessProperty: "error" })(progress).pipe(
    Effect.flatMap(Schema.encode(ProgressSchema)),
    Effect.map((encoded) => `${JSON.stringify(encoded)}\n`),
  );

export const encodeSnapshotLine = (
  snapshot: DriverSnapshot,
  snapshotAudit: SnapshotAuditFields | undefined,
): Effect.Effect<string, unknown> =>
  Schema.decodeUnknown(SnapshotSchema, { onExcessProperty: "error" })(
    protocolSnapshot(snapshot, snapshotAudit),
  ).pipe(
    Effect.flatMap(Schema.encode(SnapshotSchema)),
    Effect.map((encoded) => `${JSON.stringify(encoded)}\n`),
  );

// Test helper — wire contract proved via FakeHeadWire over fixture Snapshots without a Head.
export const makeHeadWireForTest = () => ({
  encodeProgressLine,
  encodeSnapshotLine,
  exitCodeForStopReason,
  finalAssistantText,
  headErrorEnvelope,
  protocolSnapshot,
  reassembleFullSnapshot,
});
