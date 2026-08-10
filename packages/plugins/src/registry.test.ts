import { SessionIdSchema } from "@peye/journal";
import { Effect, Schema } from "effect";
import { expect, test } from "vitest";

import { createCapabilityGrants } from "./capability.js";
import { contributionKey } from "./contribution.js";
import { createContributionRegistry, type RegistryDiagnostic } from "./registry.js";

test("Duplicate key resolves by declared priority with a diagnostic naming both plugins", async () => {
  const diagnostics: Array<RegistryDiagnostic> = [];
  const registry = createContributionRegistry({
    diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
  });
  registry.registerKind("command");
  const key = contributionKey("repo-tools", "scan");
  const lowerPriority = { key, kind: "command", payload: "first", priority: 1 };
  const higherPriority = { key, kind: "command", payload: "second", priority: 10 };
  const manifest = { capabilities: [], name: "repo-tools", version: "1.0.0" } as const;
  const sessionId = Schema.decodeSync(SessionIdSchema)("priority-session");
  const grants = createCapabilityGrants(sessionId);

  await Effect.runPromise(registry.registerPlugin(manifest, [lowerPriority], grants));
  await Effect.runPromise(registry.registerPlugin(manifest, [higherPriority], grants));

  const tied = { key, kind: "command", payload: "third", priority: 10 };
  const tieError = await Effect.runPromise(
    Effect.flip(registry.registerPlugin(manifest, [tied], grants)),
  );

  expect(await Effect.runPromise(registry.lookup("command", key, grants))).toBe(higherPriority);
  expect(tieError).toMatchObject({
    _tag: "ContributionRegistryError",
    key,
    reason: "priority_tie",
  });
  expect(diagnostics).toEqual([
    expect.objectContaining({
      existingPlugin: "repo-tools",
      existingPriority: 1,
      incomingPlugin: "repo-tools",
      incomingPriority: 10,
      key,
      kind: "command",
      selectedPlugin: "repo-tools",
      type: "contribution_conflict",
    }),
    expect.objectContaining({
      existingPlugin: "repo-tools",
      incomingPlugin: "repo-tools",
      key,
      kind: "command",
      selectedPlugin: null,
      type: "contribution_conflict",
    }),
  ]);
});

test("A tool requiring an ungranted capability is unavailable (not listed to the model) with a diagnostic", async () => {
  const diagnostics: Array<RegistryDiagnostic> = [];
  const registry = createContributionRegistry({
    diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
  });
  const tool = {
    key: contributionKey("repo-tools", "write-file"),
    kind: "tool",
    payload: {
      description: "Writes a file.",
      execute: () => Effect.succeed({ content: "written" }),
      name: "write-file",
      parameters: Schema.Struct({ path: Schema.String }),
      replay: "never" as const,
      requiredCapabilities: ["filesystem-write"],
    },
    priority: 0,
  };
  const sessionId = Schema.decodeSync(SessionIdSchema)("session-a");
  const ungranted = createCapabilityGrants(sessionId);
  const manifest = { capabilities: [], name: "repo-tools", version: "1.0.0" } as const;
  await Effect.runPromise(registry.registerPlugin(manifest, [tool], ungranted));

  expect(await Effect.runPromise(registry.lookup("tool", tool.key, ungranted))).toBeUndefined();
  expect(await Effect.runPromise(registry.list("tool", ungranted))).toEqual([]);
  expect(diagnostics).toContainEqual({
    key: tool.key,
    kind: "tool",
    missingCapabilities: ["filesystem-write"],
    plugin: "repo-tools",
    type: "contribution_unavailable",
  });

  const granted = createCapabilityGrants(sessionId, ["filesystem-write"]);
  expect(await Effect.runPromise(registry.lookup("tool", tool.key, granted))).toBe(tool);
  expect(await Effect.runPromise(registry.list("tool", granted))).toEqual([tool]);
});

test("A manifest-required ungranted capability fails the plugin load with a message naming the capability", async () => {
  const registry = createContributionRegistry();
  const sessionId = Schema.decodeSync(SessionIdSchema)("session-required");
  const grants = createCapabilityGrants(sessionId);
  const manifest = {
    capabilities: [{ name: "shell", required: true }],
    name: "repo-tools",
    version: "1.0.0",
  } as const;

  const error = await Effect.runPromise(Effect.flip(registry.registerPlugin(manifest, [], grants)));

  expect(error).toMatchObject({
    _tag: "PluginLoadError",
    cause: "capability_ungranted",
    plugin: "repo-tools",
  });
  expect(error.message).toContain("shell");
});

test("Registering an unknown contribution kind fails typed until that kind is registered", async () => {
  const registry = createContributionRegistry();
  const sessionId = Schema.decodeSync(SessionIdSchema)("session-new-kind");
  const grants = createCapabilityGrants(sessionId);
  const manifest = { capabilities: [], name: "repo-tools", version: "1.0.0" } as const;
  const contribution = {
    key: contributionKey("repo-tools", "status-panel"),
    kind: "renderer",
    payload: { target: "status" },
  };

  const error = await Effect.runPromise(
    Effect.flip(registry.registerPlugin(manifest, [contribution], grants)),
  );

  expect(error).toMatchObject({
    _tag: "ContributionRegistryError",
    kind: "renderer",
    reason: "unknown_kind",
  });

  registry.registerKind("renderer");
  await Effect.runPromise(registry.registerPlugin(manifest, [contribution], grants));
  expect(await Effect.runPromise(registry.lookup("renderer", contribution.key, grants))).toBe(
    contribution,
  );
});
