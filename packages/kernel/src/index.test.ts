import { expect, test } from "vitest";

import { kernelPackage } from "./index.js";

test("exports the kernel package marker", () => {
  expect(kernelPackage).toBe("@peye/kernel");
});
