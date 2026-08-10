import { expect, test } from "vitest";

import { cliPackage } from "./index.js";

test("exports the cli package marker", () => {
  expect(cliPackage).toBe("@peye/cli");
});
