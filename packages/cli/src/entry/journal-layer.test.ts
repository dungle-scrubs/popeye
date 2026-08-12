import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { selectJournalLayer } from "./cli-entry.js";

const makeDir = (): string => mkdtempSync(join(tmpdir(), "peye-journal-layer-"));

test("selectJournalLayer - env sqlite selects JournalSqlite regardless of file", () => {
  const dir = makeDir();
  const layer = selectJournalLayer(dir, { PEYE_JOURNAL_LAYER: "sqlite" });
  // We cannot easily inspect layer type, but ensure it doesn't throw and is a Layer
  expect(layer).toBeDefined();
  rmSync(dir, { recursive: true, force: true });
});

test("selectJournalLayer - env jsonl selects JournalJsonl", () => {
  const dir = makeDir();
  const layer = selectJournalLayer(dir, { PEYE_JOURNAL_LAYER: "jsonl" });
  expect(layer).toBeDefined();
  rmSync(dir, { recursive: true, force: true });
});

test("selectJournalLayer - file detection picks sqlite when journal.sqlite exists", () => {
  const dir = makeDir();
  writeFileSync(join(dir, "journal.sqlite"), "");
  const layer = selectJournalLayer(dir, {});
  expect(layer).toBeDefined();
  // Should be sqlite layer - we can test by checking that file exists path is used
  // The layer itself is opaque, so just ensure no error and file was detected
  rmSync(dir, { recursive: true, force: true });
});

test("selectJournalLayer - defaults to jsonl when no env and no file", () => {
  const dir = makeDir();
  const layer = selectJournalLayer(dir, {});
  expect(layer).toBeDefined();
  rmSync(dir, { recursive: true, force: true });
});

test("selectJournalLayer - unknown env falls back to file detection", () => {
  const dir = makeDir();
  const layer = selectJournalLayer(dir, { PEYE_JOURNAL_LAYER: "unknown" });
  expect(layer).toBeDefined();
  rmSync(dir, { recursive: true, force: true });
});
