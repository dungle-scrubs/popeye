/**
 * Owns Contribution storage, lookup, and the shared priority conflict rule.
 * It exists so every Contribution kind has one registration policy and one diagnostic shape.
 * Kinds are open strings registered through registerKind, so a new kind needs no registry change.
 */
import { Effect } from "effect";

import { type CapabilityGrants, missingCapabilities } from "./capability.js";
import type { Contribution, ContributionKey } from "./contribution.js";
import { ContributionRegistryError, PluginLoadError } from "./errors.js";
import type { PluginManifest } from "./manifest.js";

export interface ContributionConflictDiagnostic {
  readonly existingPlugin: string;
  readonly existingPriority: number;
  readonly incomingPlugin: string;
  readonly incomingPriority: number;
  readonly key: ContributionKey;
  readonly kind: string;
  readonly selectedPlugin: string | null;
  readonly type: "contribution_conflict";
}

export interface ContributionUnavailableDiagnostic {
  readonly key: ContributionKey;
  readonly kind: string;
  readonly missingCapabilities: ReadonlyArray<string>;
  readonly plugin: string;
  readonly type: "contribution_unavailable";
}

export type RegistryDiagnostic = ContributionConflictDiagnostic | ContributionUnavailableDiagnostic;

export interface ContributionRegistryOptions {
  readonly diagnosticSink?: (diagnostic: RegistryDiagnostic) => Effect.Effect<void>;
}

interface RegistryEntry {
  readonly contribution: Contribution;
  readonly pluginName: string;
  readonly priority: number;
}

export interface ContributionKindOptions {
  readonly requiredCapabilities?: (contribution: Contribution) => ReadonlyArray<string>;
}

interface ContributionKindDefinition {
  readonly kind: string;
  readonly options?: ContributionKindOptions;
}

const v1ContributionKinds: ReadonlyArray<ContributionKindDefinition> = [
  { kind: "command" },
  { kind: "hook" },
  { kind: "instruction-fragment" },
  {
    kind: "tool",
    options: {
      requiredCapabilities: (contribution) => {
        const payload = contribution.payload as {
          readonly requiredCapabilities?: ReadonlyArray<string>;
        };
        return payload.requiredCapabilities ?? [];
      },
    },
  },
];

export interface ContributionRegistry {
  readonly lookup: (
    kind: string,
    key: ContributionKey,
    grants: CapabilityGrants,
  ) => Effect.Effect<Contribution | undefined>;
  readonly list: (
    kind: string,
    grants: CapabilityGrants,
  ) => Effect.Effect<ReadonlyArray<Contribution>>;
  readonly registerKind: (kind: string, options?: ContributionKindOptions) => void;
  readonly registerPlugin: (
    manifest: PluginManifest,
    contributions: ReadonlyArray<Contribution>,
    grants: CapabilityGrants,
  ) => Effect.Effect<void, ContributionRegistryError | PluginLoadError>;
}

const conflictDiagnostic = (
  existing: RegistryEntry,
  incoming: RegistryEntry,
  selectedPlugin: string | null,
): ContributionConflictDiagnostic => ({
  existingPlugin: existing.pluginName,
  existingPriority: existing.priority,
  incomingPlugin: incoming.pluginName,
  incomingPriority: incoming.priority,
  key: incoming.contribution.key,
  kind: incoming.contribution.kind,
  selectedPlugin,
  type: "contribution_conflict",
});

export const createContributionRegistry = (
  options: ContributionRegistryOptions = {},
): ContributionRegistry => {
  const diagnosticSink = options.diagnosticSink ?? (() => Effect.void);
  const kinds = new Map<string, ContributionKindOptions>();
  const entries = new Map<string, Map<ContributionKey, RegistryEntry>>();

  const registerKind = (kind: string, kindOptions: ContributionKindOptions = {}): void => {
    if (!kinds.has(kind)) {
      kinds.set(kind, kindOptions);
    }
    if (!entries.has(kind)) {
      entries.set(kind, new Map());
    }
  };

  const registerPlugin = (
    manifest: PluginManifest,
    contributions: ReadonlyArray<Contribution>,
    grants: CapabilityGrants,
  ): Effect.Effect<void, ContributionRegistryError | PluginLoadError> =>
    Effect.gen(function* () {
      const missingRequired = missingCapabilities(
        grants,
        manifest.capabilities
          .filter((capability) => capability.required === true)
          .map((capability) => capability.name),
      );
      if (missingRequired.length > 0) {
        return yield* new PluginLoadError({
          cause: "capability_ungranted",
          message: `Plugin ${manifest.name} requires ungranted Capability ${missingRequired[0]}.`,
          plugin: manifest.name,
        });
      }

      for (const contribution of contributions) {
        const byKey = entries.get(contribution.kind);
        if (!kinds.has(contribution.kind) || byKey === undefined) {
          return yield* new ContributionRegistryError({
            key: contribution.key,
            kind: contribution.kind,
            message: `Unknown Contribution kind: ${contribution.kind}.`,
            reason: "unknown_kind",
          });
        }

        const incoming: RegistryEntry = {
          contribution,
          pluginName: manifest.name,
          priority: contribution.priority ?? 0,
        };
        const existing = byKey.get(contribution.key);
        if (existing === undefined) {
          byKey.set(contribution.key, incoming);
          continue;
        }

        if (existing.priority === incoming.priority) {
          yield* diagnosticSink(conflictDiagnostic(existing, incoming, null));
          return yield* new ContributionRegistryError({
            key: contribution.key,
            kind: contribution.kind,
            message: `Contribution ${contribution.key} has equal priority ${incoming.priority}.`,
            reason: "priority_tie",
          });
        }

        const selected = incoming.priority > existing.priority ? incoming : existing;
        yield* diagnosticSink(conflictDiagnostic(existing, incoming, selected.pluginName));
        byKey.set(contribution.key, selected);
      }
    });

  const missingCapabilitiesForEntry = (
    entry: RegistryEntry,
    grants: CapabilityGrants,
  ): ReadonlyArray<string> => {
    const required = kinds.get(entry.contribution.kind)?.requiredCapabilities?.(entry.contribution);
    return missingCapabilities(grants, required ?? []);
  };

  const availableContribution = (
    entry: RegistryEntry | undefined,
    grants: CapabilityGrants,
  ): Effect.Effect<Contribution | undefined> => {
    if (entry === undefined) {
      return Effect.succeed(undefined);
    }
    const missing = missingCapabilitiesForEntry(entry, grants);
    if (missing.length === 0) {
      return Effect.succeed(entry.contribution);
    }
    return diagnosticSink({
      key: entry.contribution.key,
      kind: entry.contribution.kind,
      missingCapabilities: missing,
      plugin: entry.pluginName,
      type: "contribution_unavailable",
    }).pipe(Effect.as(undefined));
  };

  for (const definition of v1ContributionKinds) {
    registerKind(definition.kind, definition.options);
  }

  return {
    list: (kind, grants) =>
      Effect.forEach(entries.get(kind)?.values() ?? [], (entry) =>
        availableContribution(entry, grants),
      ).pipe(Effect.map((contributions) => contributions.filter((item) => item !== undefined))),
    lookup: (kind, key, grants) => availableContribution(entries.get(kind)?.get(key), grants),
    registerKind,
    registerPlugin,
  };
};
