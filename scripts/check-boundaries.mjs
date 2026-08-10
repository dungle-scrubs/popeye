import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { checkBoundaries } from "./boundary-core.mjs";

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      root: { type: "string" },
    },
  });
  const rootDirectory = resolve(values.root ?? process.cwd());
  const violations = await checkBoundaries(rootDirectory);

  if (violations.length === 0) {
    console.log("Boundary check passed: no violations found.");
    return;
  }

  for (const violation of violations) {
    console.error(
      `${violation.code}: ${violation.file} imports ${violation.specifier}. ${violation.message}`,
    );
  }

  process.exitCode = 1;
}

await main();
