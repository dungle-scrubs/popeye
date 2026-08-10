import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { BOUNDARY_CODES, checkBoundaries } from "../scripts/boundary-core.mjs";

const checker = resolve("scripts/check-boundaries.mjs");
const fixtures = resolve("scripts/boundary-fixtures");

const expectedViolations = [
  {
    code: BOUNDARY_CODES.CLI_KERNEL_IMPORT,
    file: "packages/cli/src/invalid-dynamic-kernel-import.ts",
  },
  {
    code: BOUNDARY_CODES.CLI_KERNEL_IMPORT,
    file: "packages/cli/src/invalid-kernel-import.ts",
  },
  {
    code: BOUNDARY_CODES.PI_AI_SEAM_IMPORT,
    file: "packages/kernel/src/not-ai/invalid-pi-ai-import.mts",
  },
  {
    code: BOUNDARY_CODES.PI_AI_SEAM_IMPORT,
    file: "packages/kernel/src/not-ai/invalid-pi-ai-import.ts",
  },
  {
    code: BOUNDARY_CODES.PROTOCOL_PEYE_IMPORT,
    file: "packages/protocol/src/invalid-peye-import.ts",
  },
  {
    code: BOUNDARY_CODES.FEATURE_KERNEL_INTERNAL_IMPORT,
    file: "packages/plugins/src/features/invalid-kernel-internal-import.ts",
  },
] as const;
const commentOnlyFixture = "packages/kernel/src/comment-mentions-pi-ai.ts";

function runBoundaryCheck(root: string) {
  return spawnSync(process.execPath, [checker, "--root", root], {
    encoding: "utf8",
  });
}

describe("import boundaries", () => {
  test("real package sources pass", async () => {
    const violations = await checkBoundaries(process.cwd());

    expect(violations).toEqual([]);
  });

  test("fixtures report exactly the expected violations", async () => {
    const violations = await checkBoundaries(fixtures);

    expect(violations).toHaveLength(expectedViolations.length);
    expect(violations.map(({ code, file }) => ({ code, file }))).toEqual(
      expect.arrayContaining([...expectedViolations]),
    );
    expect(violations).not.toContainEqual(expect.objectContaining({ file: commentOnlyFixture }));
  });

  test("CLI reports fixture violations", () => {
    const result = runBoundaryCheck(fixtures);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    for (const { code } of expectedViolations) {
      expect(output).toContain(code);
    }
  });
});
