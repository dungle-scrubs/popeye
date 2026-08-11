/**
 * Owns the quiet in-process Head that prints settled assistant text.
 * It exists for pipes that need final text without Progress; it trusts Snapshots and never folds
 * Progress into state. Prompts run sequentially and stop at the first non-zero exit code. The v1
 * Head intentionally has no separate per-turn deadline because the Provider seam owns idle timeout
 * enforcement.
 */

import type { SessionId } from "@peye/journal";
import { Effect } from "effect";

import { Driver } from "../compose.js";
import {
  exitCodeForStopReason,
  finalAssistantText,
  type HeadExitCode,
  type HeadWriter,
  runHeadBoundary,
  stderrHeadWriter,
  stdoutHeadWriter,
} from "./shared.js";

export interface PrintHeadOptions {
  readonly errorWriter?: HeadWriter;
  readonly prompts: ReadonlyArray<string>;
  readonly sessionId?: SessionId;
  readonly writer?: HeadWriter;
}

export const runPrintHead = (options: PrintHeadOptions) =>
  runHeadBoundary(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* options.sessionId === undefined
        ? driver.createSession()
        : driver.resumeSession(options.sessionId);
      const writer = options.writer ?? stdoutHeadWriter;

      for (const prompt of options.prompts) {
        const result = yield* driver.prompt(session.id, prompt);
        const snapshot = yield* driver.getSnapshot(session.id);
        yield* writer.write(`${finalAssistantText(snapshot)}\n`);
        const exitCode = exitCodeForStopReason(result.stopReason);
        if (exitCode !== 0) {
          return exitCode;
        }
      }

      return 0 satisfies HeadExitCode;
    }),
    options.errorWriter ?? stderrHeadWriter,
  );
