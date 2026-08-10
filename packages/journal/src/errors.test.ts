import { Effect } from "effect";
import { expect, test } from "vitest";

import { JournalError } from "./errors.js";

test("JournalError is recoverable by its typed Effect channel and preserves its fields", async () => {
  const error = new JournalError({
    corruptionClass: "schema_mismatch",
    file: "/tmp/session.jsonl",
    message: "The line does not match its schema.",
  });
  const result = await Effect.runPromise(
    Effect.fail(error).pipe(
      Effect.catchTag("JournalError", (caught) => Effect.succeed(caught.file)),
    ),
  );

  expect(result).toBe("/tmp/session.jsonl");
});
