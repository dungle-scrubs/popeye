/**
 * Owns the quiet in-process Head that prints settled assistant text.
 * It exists for pipes that need final text without Progress; it trusts Snapshots and never folds
 * Progress into state.
 */
import { Effect } from "effect";

import { Driver } from "../compose.js";
import {
  exitCodeForStopReason,
  finalAssistantText,
  type HeadExitCode,
  type HeadWriter,
  stdoutHeadWriter,
} from "./shared.js";

export interface PrintHeadOptions {
  readonly prompts: ReadonlyArray<string>;
  readonly writer?: HeadWriter;
}

export const runPrintHead = (options: PrintHeadOptions) =>
  Effect.gen(function* () {
    const driver = yield* Driver;
    const session = yield* driver.createSession();
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
  });
