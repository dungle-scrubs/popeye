import { expect, test } from "vitest";

import { pluginsPackage } from "./index.js";

test("exports the plugins package marker", () => {
  expect(pluginsPackage).toBe("@peye/plugins");
});
