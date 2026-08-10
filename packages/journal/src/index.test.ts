import { expect, test } from "vitest";

import { journalPackage } from "./index.js";

test("exports the journal package marker", () => {
  expect(journalPackage).toBe("@peye/journal");
});
