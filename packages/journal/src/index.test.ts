import { expect, test } from "vitest";
import * as journal from "./index.js";

import {
  createJournalMemoryStore,
  EntrySchema,
  Journal,
  JournalMemory,
  JournalNotFound,
  journalPackage,
  RecordSchema,
} from "./index.js";

test("exports the journal package marker", () => {
  expect(journalPackage).toBe("@peye/journal");
});

test("exports the Journal seam and memory adapter without exporting its contract helper", () => {
  expect(createJournalMemoryStore).toBeTypeOf("function");
  expect(EntrySchema).toBeDefined();
  expect(Journal).toBeDefined();
  expect(JournalMemory).toBeTypeOf("function");
  expect(JournalNotFound).toBeDefined();
  expect(RecordSchema).toBeDefined();
  expect(journal).not.toHaveProperty("describeJournalContract");
});
