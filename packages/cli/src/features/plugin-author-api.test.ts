import { readFile } from "node:fs/promises";

import { expect, test } from "vitest";

test("plugin-author public surface is documented from the first-party Plugins", async () => {
  const guide = await readFile(new URL("./README.md", import.meta.url), "utf8");

  expect(guide).toContain("Plugin manifest");
  expect(guide).toContain("Command Contribution");
  expect(guide).toContain("compaction-gate");
  expect(guide).toContain("FirstWins");
  expect(guide).toContain("Capabilities");
  expect(guide).toContain("CommandExecutionContext");
  expect(guide).toContain("compactNow");
  expect(guide).toContain("setSessionName");
});
