import type { CommandExecutionContext } from "@dungle-scrubs/popeye-plugins";
import { Effect, Schema } from "effect";
import { expect, test } from "vitest";

import { compactPlugin } from "./compact.js";

test("compact command ships as a Plugin using only the public command context", async () => {
  const compact = compactPlugin.contributions.find(
    (contribution) => contribution.kind === "command" && contribution.name === "compact",
  );
  if (compact?.kind !== "command") {
    throw new Error("Expected the compact Command Contribution.");
  }
  let calls = 0;
  const context: CommandExecutionContext = {
    compactNow: () =>
      Effect.sync(() => {
        calls += 1;
        return {
          compactionEntryId: "compaction-entry",
          entriesCovered: 1,
          sliceCount: 1,
          summaryLength: 7,
        };
      }),
    sessionId: Schema.decodeSync(Schema.String.pipe(Schema.brand("SessionId")))("session-1"),
    setSessionName: () => Effect.void,
  };

  const result = await Effect.runPromise(compact.payload.execute({}, context));

  expect(compactPlugin.manifest).toMatchObject({ name: "compact", version: "1.0.0" });
  expect(result).toMatchObject({ entriesCovered: 1, summaryLength: 7 });
  expect(calls).toBe(1);
});
