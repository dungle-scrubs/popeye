/**
 * Owns the in-process Head that writes protocol Progress and Snapshot lines.
 * It exists for structured pipes; it trusts Snapshots, renders Progress, and never folds Progress
 * into state. Thin adapter over Head Session Loop: it only decides how to render Progress and
 * Snapshot (via wire Schemas), while the loop owns Session lifecycle, Progress subscription,
 * and exit-code mapping. A boundary failure ends the stream with a headError envelope. The
 * v1 Head intentionally has no separate per-turn deadline because the Provider seam owns idle
 * timeout enforcement.
 */

import type { SessionId } from "@popeye/journal";
import { Effect } from "effect";

import type { DriverSnapshot } from "../compose.js";
import {
  encodeProgressLine,
  encodeSnapshotLine,
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

export const runJsonHead = (options: JsonHeadOptions) =>
  runHeadBoundary(
    Effect.gen(function* () {
      const writer = options.writer ?? stdoutHeadWriter;
      return yield* runSessionLoop({
        onProgress: (progress) => encodeProgressLine(progress).pipe(Effect.flatMap(writer.write)),
        onSnapshot: (snapshot) =>
          encodeSnapshotLineForHead(snapshot, options.snapshotAudit).pipe(
            Effect.flatMap(writer.write),
          ),
        prompts: options.prompts,
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      });
    }),
    options.writer ?? stdoutHeadWriter,
  );
