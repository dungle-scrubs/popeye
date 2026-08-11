/**
 * Owns unqualified Tool-name collision resolution while adapting Plugin Contributions to kernel
 * Tools. Capability filtering remains owned by the grant-aware Plugin registry.
 */

import {
  type AnyToolDeclaration,
  type CapabilityGrants,
  type ContributionRegistryError,
  type GenerationPlugin,
  type PluginGeneration,
  type RegisteredContribution,
  ToolContributionKind,
} from "@pop-eye/plugins";
import { Effect } from "effect";

import type { Tool } from "../compose.js";
import { ToolError } from "../compose.js";

type RegisteredToolContribution = RegisteredContribution<"tool", AnyToolDeclaration>;

interface ToolCandidate {
  readonly contribution: RegisteredToolContribution;
  readonly plugin: GenerationPlugin;
}

type PluginIndex = ReadonlyMap<string, GenerationPlugin>;

export const generationCapabilityUnion = (generation: PluginGeneration): ReadonlyArray<string> =>
  [
    ...new Set(
      generation.plugins.flatMap((plugin) =>
        plugin.manifest.capabilities.map((capability) => capability.name),
      ),
    ),
  ].sort();

const adaptTool = (contribution: RegisteredToolContribution): Tool.Any => {
  const tool = contribution.payload;
  return {
    description: tool.description,
    execute: (arguments_, context) =>
      tool.execute(arguments_, context).pipe(
        Effect.map((result) => ({ ...result })),
        Effect.mapError(
          (error) =>
            new ToolError({
              message: error.message,
              toolCallId: error.toolCallId,
              toolName: error.toolName,
            }),
        ),
      ),
    ...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
    name: tool.name,
    parameters: tool.parameters,
    ...(tool.replay === undefined ? {} : { replay: tool.replay }),
    ...(tool.requiredCapabilities === undefined
      ? {}
      : { requiredCapabilities: tool.requiredCapabilities }),
  };
};

const pluginNameOf = (contribution: RegisteredToolContribution): string =>
  contribution.key.slice(0, contribution.key.indexOf("/"));

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const scopePriority = (plugin: GenerationPlugin): number => {
  if ("origin" in plugin && plugin.origin === "first-party") {
    return 0;
  }
  return plugin.scope === "project-local" ? 2 : 1;
};

const compareCandidates = (left: ToolCandidate, right: ToolCandidate): number =>
  scopePriority(right.plugin) - scopePriority(left.plugin) ||
  right.contribution.priority - left.contribution.priority ||
  compareText(left.plugin.name, right.plugin.name);

const resolveShadowing = (
  contributions: ReadonlyArray<RegisteredToolContribution>,
  plugins: PluginIndex,
): Effect.Effect<ReadonlyArray<RegisteredToolContribution>> =>
  Effect.gen(function* () {
    const byToolName = new Map<string, Array<ToolCandidate>>();
    for (const contribution of contributions) {
      const plugin = plugins.get(pluginNameOf(contribution));
      if (plugin === undefined) {
        continue;
      }
      const candidates = byToolName.get(contribution.payload.name) ?? [];
      candidates.push({ contribution, plugin });
      byToolName.set(contribution.payload.name, candidates);
    }

    const selected: Array<RegisteredToolContribution> = [];
    for (const candidates of byToolName.values()) {
      candidates.sort(compareCandidates);
      const survivor = candidates[0];
      if (survivor === undefined) {
        continue;
      }
      selected.push(survivor.contribution);
      for (const loser of candidates.slice(1)) {
        yield* Effect.logWarning(
          JSON.stringify({
            plugins: [survivor.plugin.name, loser.plugin.name],
            survivor: survivor.plugin.name,
            tool: survivor.contribution.payload.name,
            type: "tool_shadowed",
          }),
        );
      }
    }
    return selected;
  });

const undeclaredCapabilities = (
  contribution: RegisteredToolContribution,
  plugins: PluginIndex,
): ReadonlyArray<string> => {
  const pluginName = pluginNameOf(contribution);
  const declared = new Set(
    plugins.get(pluginName)?.manifest.capabilities.map((capability) => capability.name) ?? [],
  );
  return [...new Set(contribution.payload.requiredCapabilities ?? [])]
    .filter((capability) => !declared.has(capability))
    .sort();
};

export const adaptTools = (
  generation: PluginGeneration,
  grants: CapabilityGrants,
): Effect.Effect<ReadonlyArray<Tool.Any>, ContributionRegistryError> =>
  Effect.gen(function* () {
    const plugins = new Map(generation.plugins.map((plugin) => [plugin.name, plugin]));
    const allContributions = yield* generation.registry.listAll(ToolContributionKind);
    const invalidKeys = new Set<string>();
    for (const contribution of allContributions) {
      const missingCapabilities = undeclaredCapabilities(contribution, plugins);
      if (missingCapabilities.length === 0) {
        continue;
      }
      invalidKeys.add(contribution.key);
      yield* Effect.logWarning(
        JSON.stringify({
          missingCapabilities,
          plugin: pluginNameOf(contribution),
          type: "tool_capability_undeclared",
        }),
      );
    }
    const availableContributions = yield* generation.registry.list(ToolContributionKind, grants);
    const declaredContributions = availableContributions.filter(
      (contribution) => !invalidKeys.has(contribution.key),
    );
    const selectedContributions = yield* resolveShadowing(declaredContributions, plugins);
    return selectedContributions.map(adaptTool);
  });
