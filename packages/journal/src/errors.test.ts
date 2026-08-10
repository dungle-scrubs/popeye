import { expect, test } from "vitest";

import { JournalError } from "./errors.js";

test("JournalError constructs with its declared fields and round-trips them", () => {
  const error = new JournalError({
    corruptionClass: "schema_mismatch",
    file: "/tmp/session.jsonl",
    message: "The line does not match its schema.",
  });

  expect(error).toMatchObject({
    _tag: "JournalError",
    corruptionClass: "schema_mismatch",
    file: "/tmp/session.jsonl",
    message: "The line does not match its schema.",
  });
});
