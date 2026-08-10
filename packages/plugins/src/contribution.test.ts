import { SessionIdSchema } from "@peye/journal";
import { Effect, Schema } from "effect";
import { expect, test } from "vitest";

import { createCapabilityGrants } from "./capability.js";
import {
  contributionKey,
  defineCommandContribution,
  defineHookContribution,
  defineInstructionFragmentContribution,
  defineToolContribution,
} from "./contribution.js";
import { createContributionRegistry } from "./registry.js";

test("Contribution keys are namespaced plugin-name/thing", () => {
  expect(contributionKey("repo-tools", "search-files")).toBe("repo-tools/search-files");
});

test("All four v1 contribution kinds register (tools, commands, hooks, instruction fragments)", async () => {
  const tool = defineToolContribution("repo-tools", {
    description: "Searches repository files.",
    execute: () => Effect.succeed({ content: "matches" }),
    name: "search-files",
    parameters: Schema.Struct({ query: Schema.String }),
    replay: "safe",
    requiredCapabilities: ["filesystem-read"],
  });
  const command = defineCommandContribution("repo-tools", {
    description: "Runs a repository scan.",
    execute: () => Effect.succeed("started"),
    handler: { arguments: [{ name: "path", required: false }] },
    name: "scan",
  });
  const hook = defineHookContribution("repo-tools", {
    handler: { execute: () => Effect.void, mergeClass: "Tap" },
    name: "observe-turn",
    point: "turn-lifecycle",
  });
  const instructionFragment = defineInstructionFragmentContribution("repo-tools", {
    content: "Inspect repository instructions before editing.",
    id: "repository-instructions",
    trigger: "explicit",
  });
  const contributions = [tool, command, hook, instructionFragment];
  const registry = createContributionRegistry();
  const sessionId = Schema.decodeSync(SessionIdSchema)("session-kinds");
  const grants = createCapabilityGrants(sessionId, ["filesystem-read"]);
  const manifest = { capabilities: [], name: "repo-tools", version: "1.0.0" } as const;

  await Effect.runPromise(registry.registerPlugin(manifest, contributions, grants));

  expect(await Effect.runPromise(registry.list("tool", grants))).toEqual([tool]);
  expect(await Effect.runPromise(registry.list("command", grants))).toEqual([command]);
  expect(await Effect.runPromise(registry.list("hook", grants))).toEqual([hook]);
  expect(await Effect.runPromise(registry.list("instruction-fragment", grants))).toEqual([
    instructionFragment,
  ]);
  expect(contributions.map(({ key, priority }) => [key, priority])).toEqual([
    ["repo-tools/search-files", 0],
    ["repo-tools/scan", 0],
    ["repo-tools/observe-turn", 0],
    ["repo-tools/repository-instructions", 0],
  ]);
});
