import { expect, test } from "vitest";

import {
  createPiAiSeamContractHarness,
  describeAiSeamContract,
  interleavedFixture,
} from "./index.js";

test("exports the parameterized ai seam conformance suite and recorded fixtures", () => {
  expect(createPiAiSeamContractHarness).toBeTypeOf("function");
  expect(describeAiSeamContract).toBeTypeOf("function");
  expect(interleavedFixture).toBeTypeOf("function");
});

await describeAiSeamContract(createPiAiSeamContractHarness);
