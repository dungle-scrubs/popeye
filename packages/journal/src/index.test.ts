import { expect, test } from "vitest";
import * as conformance from "./conformance/index.js";
import * as journal from "./index.js";

import {
  createMemoryJournalBacking,
  EntrySchema,
  Journal,
  JournalMemory,
  JournalNotFound,
  journalPackage,
  RecordSchema,
} from "./index.js";

test("exports the journal package marker", () => {
  expect(journalPackage).toBe("@popeye/journal");
});

test("exports the Journal seam and memory adapter", () => {
  expect(createMemoryJournalBacking).toBeTypeOf("function");
  expect(EntrySchema).toBeDefined();
  expect(Journal).toBeDefined();
  expect(JournalMemory).toBeTypeOf("function");
  expect(JournalNotFound).toBeDefined();
  expect(RecordSchema).toBeDefined();
  expect(journal).not.toHaveProperty("createJsonlJournalHarness");
});

test("exports the parameterized Journal conformance suite from its subpath source", () => {
  expect(conformance.describeJournalContract).toBeTypeOf("function");
});
