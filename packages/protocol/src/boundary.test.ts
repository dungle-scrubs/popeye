import { glob, readFile } from "node:fs/promises";

import { expect, test } from "vitest";

test("The protocol package has zero kernel imports (package graph verified)", async () => {
  const manifest = JSON.parse(await readFile("packages/protocol/package.json", "utf8")) as Record<
    string,
    unknown
  >;
  const dependencies = manifest.dependencies as Record<string, unknown>;
  const imports = manifest.imports as Record<string, unknown>;
  const tsconfig = JSON.parse(await readFile("packages/protocol/tsconfig.json", "utf8")) as {
    readonly references: ReadonlyArray<{ readonly path: string }>;
  };
  const sources: Array<string> = [];
  for await (const file of glob("packages/protocol/src/*.ts", {
    exclude: ["**/*.test.ts"],
  })) {
    sources.push(await readFile(file, "utf8"));
  }

  expect(dependencies).toHaveProperty("@dungle-scrubs/popeye-journal", "workspace:*");
  expect(dependencies).not.toHaveProperty("@dungle-scrubs/popeye-kernel");
  expect(Object.values(imports)).not.toContain("@dungle-scrubs/popeye-kernel");
  expect(tsconfig.references).toEqual([{ path: "../journal" }]);
  expect(sources.join("\n")).not.toContain('from "@dungle-scrubs/popeye-kernel"');
});
