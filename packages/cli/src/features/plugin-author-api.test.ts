import { readFile } from "node:fs/promises";

import { expect, test } from "vitest";

test("plugin-author public surface is documented from the first-party Plugins", async () => {
  const [featureGuide, authorGuide] = await Promise.all([
    readFile(new URL("./README.md", import.meta.url), "utf8"),
    readFile(new URL("../../../../docs/plugin-authoring.md", import.meta.url), "utf8"),
  ]);

  expect(featureGuide).toContain("Plugin manifest");
  expect(featureGuide).toContain("Command Contribution");
  expect(featureGuide).toContain("compaction-gate");
  expect(featureGuide).toContain("FirstWins");
  expect(featureGuide).toContain("Capabilities");
  expect(featureGuide).toContain("CommandExecutionContext");
  expect(featureGuide).toContain("compactNow");
  expect(featureGuide).toContain("setSessionName");
  expect(featureGuide).toContain('action: "compact"');
  expect(featureGuide).toContain('action: "skip"');
  expect(featureGuide).toContain("overflow-triggered");
  expect(featureGuide).not.toContain("veto or replace");

  for (const contributionKind of [
    "### Tools",
    "### Commands",
    "### Hooks",
    "### Instruction fragments",
  ]) {
    expect(authorGuide).toContain(contributionKind);
  }
  expect(authorGuide).toContain("Capability grants belong to one Session");
  expect(authorGuide).toContain("Trust decides if project-local code runs");
  expect(authorGuide).toContain("TypeScript `enum` or `namespace`");
  expect(authorGuide).toContain("generation drain");
  expect(authorGuide).toContain("package roots only");
});
