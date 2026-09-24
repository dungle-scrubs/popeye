import { SessionIdSchema } from "@dungle-scrubs/popeye-journal";
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
import {
  CommandContributionKind,
  ContributionRegistry,
  ContributionRegistryLive,
  HookContributionKind,
  InstructionFragmentContributionKind,
  ToolContributionKind,
} from "./registry.js";

test("Contribution keys are namespaced plugin-name/thing", () => {
  expect(contributionKey("repo-tools", "search-files")).toBe("repo-tools/search-files");
});

test("All four v1 Contribution kinds register with typed payloads", async () => {
  const tool = defineToolContribution({
    description: "Searches repository files.",
    execute: () => Effect.succeed({ content: "matches" }),
    name: "search-files",
    parameters: Schema.Struct({ query: Schema.String }),
    replay: "safe",
    requiredCapabilities: ["filesystem-read"],
  });
  const command = defineCommandContribution({
    arguments: Schema.Struct({ path: Schema.optional(Schema.String) }),
    description: "Runs a repository scan.",
    execute: () => Effect.succeed("started"),
    name: "scan",
  });
  const hook = defineHookContribution({
    mergeClass: "Tap",
    name: "observe-turn",
    point: "turn-lifecycle",
    run: () => Effect.void,
  });
  const instructionFragment = defineInstructionFragmentContribution({
    content: "Inspect repository instructions before editing.",
    id: "repository-instructions",
    trigger: "explicit",
  });
  const manifest = { capabilities: [], name: "repo-tools", version: "1.0.0" } as const;
  const sessionId = Schema.decodeSync(SessionIdSchema)("session-kinds");
  const grants = createCapabilityGrants(sessionId, ["filesystem-read"]);

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest, [tool, command, hook, instructionFragment]);
      return {
        commands: yield* registry.list(CommandContributionKind, grants),
        hooks: yield* registry.list(HookContributionKind, grants),
        instructions: yield* registry.list(InstructionFragmentContributionKind, grants),
        tools: yield* registry.list(ToolContributionKind, grants),
      };
    }).pipe(Effect.provide(ContributionRegistryLive())),
  );

  expect(result.tools[0]?.payload).toBe(tool.payload);
  expect(result.commands[0]?.payload).toBe(command.payload);
  expect(result.hooks[0]?.payload).toBe(hook.payload);
  expect(result.instructions[0]?.payload).toEqual(instructionFragment.payload);
  expect(
    [...result.tools, ...result.commands, ...result.hooks, ...result.instructions].map(
      ({ key, priority }) => [key, priority],
    ),
  ).toEqual([
    ["repo-tools/search-files", 0],
    ["repo-tools/scan", 0],
    ["repo-tools/observe-turn", 0],
    ["repo-tools/repository-instructions", 0],
  ]);
});

test("The registry derives the namespace and ignores a supplied key", async () => {
  const manifest = { capabilities: [], name: "attacker", version: "1.0.0" } as const;
  const sessionId = Schema.decodeSync(SessionIdSchema)("session-namespace");
  const grants = createCapabilityGrants(sessionId);
  const squattingAttempt = {
    key: contributionKey("victim", "scan"),
    kind: "instruction-fragment",
    name: "scan",
    payload: { content: "content", id: "scan", trigger: "explicit" },
  } as const;

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest, [squattingAttempt]);
      return {
        attacker: yield* registry.lookup(
          InstructionFragmentContributionKind,
          contributionKey("attacker", "scan"),
          grants,
        ),
        victim: yield* registry.lookup(
          InstructionFragmentContributionKind,
          contributionKey("victim", "scan"),
          grants,
        ),
      };
    }).pipe(Effect.provide(ContributionRegistryLive())),
  );

  expect(result.attacker?.key).toBe("attacker/scan");
  expect(result.victim).toBeUndefined();
});

test("Adversarial Contribution name segments are rejected", () => {
  expect(() => contributionKey("a/b", "x")).toThrow("name must use kebab-case");
  expect(() => contributionKey("a", "b/x")).toThrow("contribution name must use kebab-case");
  expect(() => contributionKey("", "x")).toThrow("name must be non-empty and trimmed");
  expect(() => contributionKey("a", "x".repeat(65))).toThrow(
    "contribution name must be at most 64 characters",
  );
});
