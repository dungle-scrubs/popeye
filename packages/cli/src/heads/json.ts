/**
 * Owns the in-process Head that writes protocol Progress and Snapshot lines.
 * It exists for structured pipes; it trusts Snapshots, renders Progress, and never folds Progress
 * into state. Thin adapter over Head Session Loop: it only decides how to render Progress and
 * Snapshot (via wire Schemas), while the loop owns Session lifecycle, Progress subscription,
 * and exit-code mapping. A boundary failure ends the stream with a headError envelope. The
 * v1 Head intentionally has no separate per-turn deadline because the Provider seam owns idle
 * timeout enforcement.
 */

import { type SessionId, SessionIdSchema } from "@popeye/journal";
import { Effect, Schema } from "effect";

import type { DriverSnapshot } from "../compose.js";
import {
  encodeProgressLine,
  encodeSnapshotLine,
  exitCodeForStopReason,
  type HeadWriter,
  runHeadBoundary,
  type SnapshotAuditFields,
  stdoutHeadWriter,
} from "./head-wire.js";
import { runSessionLoop } from "./session-loop.js";

export interface JsonHeadOptions {
  readonly prompts: ReadonlyArray<string>;
  readonly sessionId?: SessionId;
  readonly snapshotAudit?: SnapshotAuditFields;
  readonly writer?: HeadWriter;
}

const encodeSnapshotLineForHead = (
  snapshot: DriverSnapshot,
  snapshotAudit: SnapshotAuditFields | undefined,
) => encodeSnapshotLine(snapshot, snapshotAudit);

export const SessionIdLineSchema = Schema.Struct({
  _tag: Schema.Literal("sessionId"),
  sessionId: SessionIdSchema,
});

/**
 * RFC-02 P1 item 1: the json head emits a session-id line on stdout before
 * any Progress line, so out-of-process mappers can bind the stream without
 * parsing the STARTUP stderr line.
 */
export const sessionIdLine = (sessionId: SessionId): string =>
  `${JSON.stringify(Schema.encodeSync(SessionIdLineSchema)({ _tag: "sessionId", sessionId }))}\n`;

export const runJsonHead = (options: JsonHeadOptions) =>
  runHeadBoundary(
    Effect.gen(function* () {
      const writer = options.writer ?? stdoutHeadWriter;
      return yield* runSessionLoop({
        onProgress: (progress) => encodeProgressLine(progress).pipe(Effect.flatMap(writer.write)),
        onSession: (sessionId) => writer.write(sessionIdLine(sessionId)),
        onTurnSettled: (turn) =>
          encodeSnapshotLineForHead(turn.snapshot, options.snapshotAudit).pipe(
            Effect.flatMap(writer.write),
            Effect.as(exitCodeForStopReason(turn.stopReason)),
          ),
        prompts: options.prompts,
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      });
    }),
    options.writer ?? stdoutHeadWriter,
  );
