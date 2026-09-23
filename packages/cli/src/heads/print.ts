/**
 * Owns the quiet in-process Head that prints settled assistant text.
 * It exists for pipes that need final text without Progress; it trusts Snapshots and never folds
 * Progress into state. Thin adapter over Head Session Loop: it only decides how to render
 * the Snapshot (finalAssistantText) and the exit policy, while the loop owns Session lifecycle,
 * prompt sequencing, and per-turn entry counts. The v1 Head intentionally has no separate
 * per-turn deadline because the Provider seam owns idle timeout enforcement.
 */

import type { SessionId } from "@popeye/journal";
import { Effect } from "effect";
import {
  exitCodeForStopReason,
  finalAssistantText,
  type HeadWriter,
  runHeadBoundary,
  stderrHeadWriter,
  stdoutHeadWriter,
} from "./head-wire.js";
import { runSessionLoop } from "./session-loop.js";

export interface PrintHeadOptions {
  readonly errorWriter?: HeadWriter;
  readonly prompts: ReadonlyArray<string>;
  readonly sessionId?: SessionId;
  readonly writer?: HeadWriter;
}

export const runPrintHead = (options: PrintHeadOptions) =>
  runHeadBoundary(
    Effect.gen(function* () {
      const writer = options.writer ?? stdoutHeadWriter;
      return yield* runSessionLoop({
        onTurnSettled: (turn) =>
          writer
            .write(`${finalAssistantText(turn.snapshot)}\n`)
            .pipe(Effect.as(exitCodeForStopReason(turn.stopReason))),
        prompts: options.prompts,
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      });
    }),
    options.errorWriter ?? stderrHeadWriter,
  );
