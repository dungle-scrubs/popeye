import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

const checker = resolve("scripts/check-boundaries.mjs");
const fixtures = resolve("scripts/boundary-fixtures");

function runBoundaryCheck(root: string) {
  return spawnSync(process.execPath, [checker, "--root", root], {
    encoding: "utf8",
  });
}

describe("import boundaries", () => {
  test("real package sources pass", () => {
    const result = runBoundaryCheck(process.cwd());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Boundary check passed");
  });

  test("fixtures report every named violation", () => {
    const result = runBoundaryCheck(fixtures);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("CLI_KERNEL_IMPORT");
    expect(output).toContain("PI_AI_SEAM_IMPORT");
    expect(output).toContain("FEATURE_KERNEL_INTERNAL_IMPORT");
  });
});
