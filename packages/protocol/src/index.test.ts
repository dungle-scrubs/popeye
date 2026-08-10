import { expect, test } from "vitest";

import { protocolPackage } from "./index.js";

test("exports the protocol package marker", () => {
  expect(protocolPackage).toBe("@peye/protocol");
});
