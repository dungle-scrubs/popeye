/**
 * Owns Contribution storage, typed lookup, and the shared priority conflict rule.
 * It exists so every Contribution kind has one atomic registration policy and one diagnostic
 * shape. M18 can use removePlugin and atomic replacement, or swap a whole registry Layer for each
 * Plugin generation.
 */
import { Context, Effect, Layer, ParseResult, Ref, Schema } from "effect";

import { type CapabilityGrants, CapabilityNameSchema, missingCapabilities } from "./capability.js";
import type {
  AnyToolDeclaration,
  CommandDeclaration,
  Contribution,
  ContributionKey,
  HookMergeClass,
  RegisteredContribution,
} from "./contribution.js";
import { contributionKey } from "./contribution.js";
import { ContributionRegistryError, type PluginLoadError } from "./errors.js";
import { HOOK_POINTS, type HookPointDefinition } from "./hook-points.js";
import { ContributionNameSchema, decodePluginManifest, type PluginManifest } from "./manifest.js";
import type { PluginSourceScope } from "./sources.js";

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
  readonly cause: "capability_ungranted";
  readonly key: ContributionKey;
  readonly kind: string;
  readonly missingCapabilities: ReadonlyArray<string>;
  readonly plugin: string;
  readonly type: "contribution_unavailable";
}

export interface KindRegistrationConflictDiagnostic {
  readonly kind: string;
  readonly type: "kind_registration_conflict";
}

export type RegistryDiagnostic =
  | ContributionConflictDiagnostic
  | ContributionUnavailableDiagnostic
  | KindRegistrationConflictDiagnostic;

export interface ContributionRegistryOptions {
  readonly diagnosticSink?: (diagnostic: RegistryDiagnostic) => Effect.Effect<void>;
}

export interface ContributionKind<TKind extends string, TPayload, TEncoded = TPayload> {
  readonly kind: TKind;
  readonly payloadSchema: Schema.Schema<TPayload, TEncoded>;
  readonly requiredCapabilities: (payload: TPayload) => ReadonlyArray<string>;
}

const noRequiredCapabilities = (): ReadonlyArray<string> => [];

export const defineContributionKind = <const TKind extends string, TPayload, TEncoded = TPayload>(
  kind: TKind,
  payloadSchema: Schema.Schema<TPayload, TEncoded>,
  options: {
    readonly requiredCapabilities?: (payload: TPayload) => ReadonlyArray<string>;
  } = {},
): ContributionKind<TKind, TPayload, TEncoded> => ({
  kind,
  payloadSchema,
  requiredCapabilities: options.requiredCapabilities ?? noRequiredCapabilities,
});

type AnyCommandDeclaration = CommandDeclaration<never, unknown, unknown, never, unknown>;
interface AnyHookDeclaration {
  readonly mergeClass: HookMergeClass;
  readonly name: string;
  readonly point: string;
  readonly run: (input: unknown) => Effect.Effect<unknown, unknown>;
}

const isRecord = (input: unknown): input is Readonly<Record<string, unknown>> =>
  typeof input === "object" && input !== null;

const CommandDeclarationSchema = Schema.declare<AnyCommandDeclaration>(
  (input): input is AnyCommandDeclaration =>
    isRecord(input) &&
    Schema.isSchema(input.arguments) &&
    typeof input.description === "string" &&
    typeof input.execute === "function" &&
    typeof input.name === "string",
  { identifier: "CommandDeclaration" },
);

const HookDeclarationSchema = Schema.declare<AnyHookDeclaration>(
  (input): input is AnyHookDeclaration =>
    isRecord(input) &&
    ["Accumulate", "Chain", "FirstWins", "Tap"].includes(String(input.mergeClass)) &&
    typeof input.name === "string" &&
    typeof input.point === "string" &&
    typeof input.run === "function",
  { identifier: "HookDeclaration" },
);

const InstructionFragmentDeclarationSchema = Schema.Struct({
  content: Schema.String,
  id: Schema.String,
  trigger: Schema.Literal("explicit"),
});

const ToolDeclarationSchema = Schema.declare<AnyToolDeclaration>(
  (input): input is AnyToolDeclaration =>
    isRecord(input) &&
    typeof input.description === "string" &&
    typeof input.execute === "function" &&
    typeof input.name === "string" &&
    Schema.isSchema(input.parameters) &&
    (input.requiredCapabilities === undefined || Array.isArray(input.requiredCapabilities)),
  { identifier: "ToolDeclaration" },
);

export const CommandContributionKind = defineContributionKind("command", CommandDeclarationSchema);
export const HookContributionKind = defineContributionKind("hook", HookDeclarationSchema);
export const InstructionFragmentContributionKind = defineContributionKind(
  "instruction-fragment",
  InstructionFragmentDeclarationSchema,
);
export const ToolContributionKind = defineContributionKind("tool", ToolDeclarationSchema, {
  requiredCapabilities: (tool) => tool.requiredCapabilities ?? [],
});

interface DecodedPayload {
  readonly requiredCapabilities: ReadonlyArray<string>;
  readonly value: unknown;
}

interface StoredKind {
  readonly decode: (input: unknown) => Effect.Effect<DecodedPayload, ParseResult.ParseError>;
  readonly kind: string;
  readonly payloadSchema: object;
  readonly requiredCapabilities: object;
}

interface StoredEntry {
  readonly key: ContributionKey;
  readonly kind: string;
  readonly name: string;
  readonly payload: unknown;
  readonly pluginName: string;
  readonly pluginScope: PluginSourceScope;
  readonly priority: number;
  readonly registrationRevision: number;
  readonly requiredCapabilities: ReadonlyArray<string>;
}

interface RegistryState {
  readonly diagnosedExclusions: ReadonlySet<string>;
  readonly entries: ReadonlyMap<string, ReadonlyMap<ContributionKey, StoredEntry>>;
  readonly hookPoints: ReadonlyMap<string, HookPointDefinition>;
  readonly kinds: ReadonlyMap<string, StoredKind>;
  readonly plugins: ReadonlyMap<string, PluginManifest>;
  readonly revision: number;
}

interface StagedPlugin {
  readonly diagnostics: ReadonlyArray<ContributionConflictDiagnostic>;
  readonly state: RegistryState;
}

export interface ContributionRegistryService {
  readonly getHookPoint: (
    name: string,
  ) => Effect.Effect<HookPointDefinition, ContributionRegistryError>;
  readonly list: <TKind extends string, TPayload, TEncoded>(
    kind: ContributionKind<TKind, TPayload, TEncoded>,
    grants: CapabilityGrants,
    options?: { readonly pluginScope?: PluginSourceScope },
  ) => Effect.Effect<
    ReadonlyArray<RegisteredContribution<TKind, TPayload>>,
    ContributionRegistryError
  >;
  readonly listAll: <TKind extends string, TPayload, TEncoded>(
    kind: ContributionKind<TKind, TPayload, TEncoded>,
  ) => Effect.Effect<
    ReadonlyArray<RegisteredContribution<TKind, TPayload>>,
    ContributionRegistryError
  >;
  readonly lookup: <TKind extends string, TPayload, TEncoded>(
    kind: ContributionKind<TKind, TPayload, TEncoded>,
    key: ContributionKey,
    grants: CapabilityGrants,
  ) => Effect.Effect<
    RegisteredContribution<TKind, TPayload> | undefined,
    ContributionRegistryError
  >;
  readonly registerKind: <TKind extends string, TPayload, TEncoded>(
    kind: ContributionKind<TKind, TPayload, TEncoded>,
  ) => Effect.Effect<void, ContributionRegistryError>;
  readonly registerHookPoint: (
    definition: HookPointDefinition,
  ) => Effect.Effect<void, ContributionRegistryError>;
  readonly registerPlugin: (
    manifest: PluginManifest,
    contributions: ReadonlyArray<Contribution>,
    pluginScope?: PluginSourceScope,
  ) => Effect.Effect<void, ContributionRegistryError | PluginLoadError>;
  readonly removePlugin: (name: string) => Effect.Effect<boolean, ContributionRegistryError>;
  readonly revision: Effect.Effect<number>;
}

export class ContributionRegistry extends Context.Tag("@peye/plugins/ContributionRegistry")<
  ContributionRegistry,
  ContributionRegistryService
>() {}

const storedKind = <TKind extends string, TPayload, TEncoded>(
  definition: ContributionKind<TKind, TPayload, TEncoded>,
): StoredKind => ({
  decode: (input) =>
    Schema.decodeUnknown(definition.payloadSchema)(input).pipe(
      Effect.map((value) => ({
        requiredCapabilities: definition.requiredCapabilities(value),
        value,
      })),
    ),
  kind: definition.kind,
  payloadSchema: definition.payloadSchema,
  requiredCapabilities: definition.requiredCapabilities,
});

const initialState = (): RegistryState => {
  const kinds = new Map<string, StoredKind>();
  kinds.set(CommandContributionKind.kind, storedKind(CommandContributionKind));
  kinds.set(HookContributionKind.kind, storedKind(HookContributionKind));
  kinds.set(
    InstructionFragmentContributionKind.kind,
    storedKind(InstructionFragmentContributionKind),
  );
  kinds.set(ToolContributionKind.kind, storedKind(ToolContributionKind));
  return {
    diagnosedExclusions: new Set<string>(),
    entries: new Map([...kinds.keys()].map((kind) => [kind, new Map()])),
    hookPoints: new Map(Object.entries(HOOK_POINTS)),
    kinds,
    plugins: new Map(),
    revision: 0,
  };
};

const registryError = (
  kind: string,
  reason: ContributionRegistryError["reason"],
  message: string,
  key: ContributionKey | null = null,
  schemaCause?: unknown,
): ContributionRegistryError =>
  new ContributionRegistryError({
    key,
    kind,
    message,
    reason,
    ...(schemaCause === undefined ? {} : { schemaCause }),
  });

const conflictDiagnostic = (
  existing: StoredEntry,
  incoming: StoredEntry,
  selectedPlugin: string | null,
): ContributionConflictDiagnostic => ({
  existingPlugin: existing.pluginName,
  existingPriority: existing.priority,
  incomingPlugin: incoming.pluginName,
  incomingPriority: incoming.priority,
  key: incoming.key,
  kind: incoming.kind,
  selectedPlugin,
  type: "contribution_conflict",
});

const removePluginFromState = (state: RegistryState, pluginName: string): RegistryState => ({
  diagnosedExclusions: new Set(),
  entries: new Map(
    [...state.entries].map(([kind, entries]) => [
      kind,
      new Map([...entries].filter(([, entry]) => entry.pluginName !== pluginName)),
    ]),
  ),
  kinds: state.kinds,
  hookPoints: state.hookPoints,
  plugins: new Map([...state.plugins].filter(([name]) => name !== pluginName)),
  revision: state.revision,
});

const requiredManifestCapabilities = (manifest: PluginManifest): ReadonlyArray<string> =>
  manifest.capabilities
    .filter((capability) => capability.required === true)
    .map((capability) => capability.name);

const stagePlugin = (
  state: RegistryState,
  manifestInput: PluginManifest,
  contributions: ReadonlyArray<Contribution>,
  pluginScope: PluginSourceScope,
  diagnosticSink: (diagnostic: RegistryDiagnostic) => Effect.Effect<void>,
): Effect.Effect<StagedPlugin, ContributionRegistryError | PluginLoadError> =>
  Effect.gen(function* () {
    const manifest = yield* decodePluginManifest(manifestInput);
    const base = removePluginFromState(state, manifest.name);
    const entries = new Map(
      [...base.entries].map(([kind, byKey]) => [kind, new Map(byKey)] as const),
    );
    const diagnostics: Array<ContributionConflictDiagnostic> = [];
    const manifestCapabilities = requiredManifestCapabilities(manifest);
    const registrationRevision = state.revision + 1;

    for (const contribution of contributions) {
      const name = yield* Schema.decodeUnknown(ContributionNameSchema)(contribution.name).pipe(
        Effect.mapError((schemaCause) =>
          registryError(
            contribution.kind,
            "invalid_name",
            `Invalid Contribution name: ${ParseResult.ArrayFormatter.formatErrorSync(schemaCause)[0]?.message ?? "name does not match the Schema"}.`,
            null,
            schemaCause,
          ),
        ),
      );
      const kind = state.kinds.get(contribution.kind);
      if (kind === undefined) {
        return yield* registryError(
          contribution.kind,
          "unknown_kind",
          `Unknown Contribution kind: ${contribution.kind}.`,
        );
      }
      const key = contributionKey(manifest.name, name);
      const decoded = yield* kind
        .decode(contribution.payload)
        .pipe(
          Effect.mapError((schemaCause) =>
            registryError(
              contribution.kind,
              "payload_invalid",
              `Invalid ${contribution.kind} payload for ${key}: ${ParseResult.ArrayFormatter.formatErrorSync(schemaCause)[0]?.message ?? "payload does not match the Schema"}.`,
              key,
              schemaCause,
            ),
          ),
        );
      const contributionCapabilities = yield* Effect.forEach(
        decoded.requiredCapabilities,
        (capability) =>
          Schema.decodeUnknown(CapabilityNameSchema)(capability).pipe(
            Effect.mapError((schemaCause) =>
              registryError(
                contribution.kind,
                "payload_invalid",
                `Invalid Capability name in ${key}: ${ParseResult.ArrayFormatter.formatErrorSync(schemaCause)[0]?.message ?? "name does not match the Schema"}.`,
                key,
                schemaCause,
              ),
            ),
          ),
      );
      if (contribution.kind === HookContributionKind.kind) {
        const hook = decoded.value as AnyHookDeclaration;
        const definition = state.hookPoints.get(hook.point);
        if (definition === undefined) {
          return yield* registryError(
            contribution.kind,
            "hook_point_unknown",
            `Unknown Hook point: ${hook.point}.`,
            key,
          );
        }
        if (hook.mergeClass !== definition.mergeClass) {
          return yield* registryError(
            contribution.kind,
            "hook_merge_class_mismatch",
            `Hook ${key} declares merge class ${hook.mergeClass}, but ${hook.point} requires ${definition.mergeClass}.`,
            key,
          );
        }
      }
      const incoming: StoredEntry = {
        key,
        kind: contribution.kind,
        name,
        payload: decoded.value,
        pluginName: manifest.name,
        pluginScope,
        priority: contribution.priority ?? 0,
        registrationRevision,
        requiredCapabilities: [
          ...new Set([...manifestCapabilities, ...contributionCapabilities]),
        ].sort(),
      };
      const byKey = entries.get(contribution.kind);
      if (byKey === undefined) {
        return yield* registryError(
          contribution.kind,
          "unknown_kind",
          `Unknown Contribution kind: ${contribution.kind}.`,
          key,
        );
      }
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, incoming);
        continue;
      }
      if (existing.priority === incoming.priority) {
        yield* diagnosticSink(conflictDiagnostic(existing, incoming, null));
        return yield* registryError(
          contribution.kind,
          "priority_tie",
          `Contribution ${key} has equal priority ${incoming.priority}.`,
          key,
        );
      }
      const selected = incoming.priority > existing.priority ? incoming : existing;
      diagnostics.push(conflictDiagnostic(existing, incoming, selected.pluginName));
      byKey.set(key, selected);
    }

    return {
      diagnostics,
      state: {
        diagnosedExclusions: new Set(),
        entries,
        hookPoints: state.hookPoints,
        kinds: state.kinds,
        plugins: new Map(base.plugins).set(manifest.name, manifest),
        revision: registrationRevision,
      },
    };
  });

const kindRegistrationError = (kind: string): ContributionRegistryError =>
  registryError(
    kind,
    "kind_conflict",
    `Contribution kind ${kind} is already registered with different options.`,
  );

const unknownKindError = (kind: string): ContributionRegistryError =>
  registryError(kind, "unknown_kind", `Unknown Contribution kind: ${kind}.`);

const makeContributionRegistry = (
  options: ContributionRegistryOptions,
): Effect.Effect<ContributionRegistryService> =>
  Effect.gen(function* () {
    const diagnosticSink = options.diagnosticSink ?? (() => Effect.void);
    const stateRef = yield* Ref.make(initialState());
    const mutationMutex = yield* Effect.makeSemaphore(1);

    const checkedKind = <TKind extends string, TPayload, TEncoded>(
      definition: ContributionKind<TKind, TPayload, TEncoded>,
      state: RegistryState,
    ): Effect.Effect<StoredKind, ContributionRegistryError> => {
      const registered = state.kinds.get(definition.kind);
      if (registered === undefined) {
        return Effect.fail(unknownKindError(definition.kind));
      }
      if (
        registered.payloadSchema !== definition.payloadSchema ||
        registered.requiredCapabilities !== definition.requiredCapabilities
      ) {
        return Effect.fail(kindRegistrationError(definition.kind));
      }
      return Effect.succeed(registered);
    };

    const emitUnavailableOnce = (
      entry: StoredEntry,
      grants: CapabilityGrants,
      missing: ReadonlyArray<string>,
    ): Effect.Effect<void> => {
      const token = `${grants.sessionId}\u0000${grants.capabilities.join("\u0000")}\u0000${entry.key}`;
      return Ref.modify(stateRef, (state) => {
        if (state.diagnosedExclusions.has(token)) {
          return [false, state] as const;
        }
        return [
          true,
          {
            ...state,
            diagnosedExclusions: new Set(state.diagnosedExclusions).add(token),
          },
        ] as const;
      }).pipe(
        Effect.flatMap((shouldEmit) =>
          shouldEmit
            ? diagnosticSink({
                cause: "capability_ungranted",
                key: entry.key,
                kind: entry.kind,
                missingCapabilities: missing,
                plugin: entry.pluginName,
                type: "contribution_unavailable",
              })
            : Effect.void,
        ),
      );
    };

    const availableEntry = (
      entry: StoredEntry | undefined,
      grants: CapabilityGrants,
    ): Effect.Effect<StoredEntry | undefined> => {
      if (entry === undefined) {
        return Effect.succeed(undefined);
      }
      const missing = missingCapabilities(grants, entry.requiredCapabilities);
      return missing.length === 0
        ? Effect.succeed(entry)
        : emitUnavailableOnce(entry, grants, missing).pipe(Effect.as(undefined));
    };

    const decodeRegistered = <TKind extends string, TPayload, TEncoded>(
      definition: ContributionKind<TKind, TPayload, TEncoded>,
      entry: StoredEntry,
    ): Effect.Effect<RegisteredContribution<TKind, TPayload>, ContributionRegistryError> =>
      Schema.validate(definition.payloadSchema)(entry.payload).pipe(
        Effect.map((payload) => ({
          key: entry.key,
          kind: definition.kind,
          name: entry.name,
          payload,
          priority: entry.priority,
          registrationRevision: entry.registrationRevision,
        })),
        Effect.mapError((schemaCause) =>
          registryError(
            definition.kind,
            "payload_invalid",
            `Stored ${definition.kind} payload for ${entry.key} no longer matches its Schema.`,
            entry.key,
            schemaCause,
          ),
        ),
      );

    const list: ContributionRegistryService["list"] = (definition, grants, options) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        yield* checkedKind(definition, state);
        const available = yield* Effect.forEach(
          [...(state.entries.get(definition.kind)?.values() ?? [])].filter(
            (entry) =>
              options?.pluginScope === undefined || entry.pluginScope === options.pluginScope,
          ),
          (entry) => availableEntry(entry, grants),
        );
        return yield* Effect.forEach(
          available.filter((entry) => entry !== undefined),
          (entry) => decodeRegistered(definition, entry),
        );
      });

    const listAll: ContributionRegistryService["listAll"] = (definition) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        yield* checkedKind(definition, state);
        return yield* Effect.forEach(state.entries.get(definition.kind)?.values() ?? [], (entry) =>
          decodeRegistered(definition, entry),
        );
      });

    const lookup: ContributionRegistryService["lookup"] = (definition, key, grants) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        yield* checkedKind(definition, state);
        const entry = yield* availableEntry(state.entries.get(definition.kind)?.get(key), grants);
        return entry === undefined ? undefined : yield* decodeRegistered(definition, entry);
      });

    const registerKind: ContributionRegistryService["registerKind"] = (definition) =>
      mutationMutex.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef);
          const existing = state.kinds.get(definition.kind);
          if (existing !== undefined) {
            if (
              existing.payloadSchema === definition.payloadSchema &&
              existing.requiredCapabilities === definition.requiredCapabilities
            ) {
              return;
            }
            yield* diagnosticSink({
              kind: definition.kind,
              type: "kind_registration_conflict",
            });
            return yield* kindRegistrationError(definition.kind);
          }
          const kinds = new Map(state.kinds).set(definition.kind, storedKind(definition));
          const entries = new Map(state.entries).set(definition.kind, new Map());
          yield* Ref.set(stateRef, {
            ...state,
            diagnosedExclusions: new Set<string>(),
            entries,
            kinds,
            revision: state.revision + 1,
          });
        }),
      );

    const registerHookPoint: ContributionRegistryService["registerHookPoint"] = (definition) =>
      mutationMutex.withPermits(1)(
        Effect.gen(function* () {
          const name = yield* Schema.decodeUnknown(ContributionNameSchema)(definition.name).pipe(
            Effect.mapError((schemaCause) =>
              registryError(
                "hook",
                "invalid_name",
                `Invalid Hook point name: ${ParseResult.ArrayFormatter.formatErrorSync(schemaCause)[0]?.message ?? "name does not match the Schema"}.`,
                null,
                schemaCause,
              ),
            ),
          );
          const state = yield* Ref.get(stateRef);
          const existing = state.hookPoints.get(name);
          if (existing === definition) {
            return;
          }
          if (existing !== undefined) {
            return yield* registryError(
              "hook",
              "hook_point_conflict",
              `Hook point ${name} is already registered with a different definition.`,
            );
          }
          yield* Ref.set(stateRef, {
            ...state,
            diagnosedExclusions: new Set<string>(),
            hookPoints: new Map(state.hookPoints).set(name, definition),
            revision: state.revision + 1,
          });
        }),
      );

    const registerPlugin: ContributionRegistryService["registerPlugin"] = (
      manifest,
      contributions,
      pluginScope = "project-local",
    ) =>
      mutationMutex.withPermits(1)(
        Effect.gen(function* () {
          const staged = yield* stagePlugin(
            yield* Ref.get(stateRef),
            manifest,
            contributions,
            pluginScope,
            diagnosticSink,
          );
          yield* Effect.forEach(staged.diagnostics, diagnosticSink, { discard: true });
          yield* Ref.set(stateRef, staged.state);
        }),
      );

    const removePlugin: ContributionRegistryService["removePlugin"] = (nameInput) =>
      mutationMutex.withPermits(1)(
        Effect.gen(function* () {
          const name = yield* Schema.decodeUnknown(ContributionNameSchema)(nameInput).pipe(
            Effect.mapError((schemaCause) =>
              registryError(
                "plugin",
                "invalid_name",
                `Invalid Plugin name: ${ParseResult.ArrayFormatter.formatErrorSync(schemaCause)[0]?.message ?? "name does not match the Schema"}.`,
                null,
                schemaCause,
              ),
            ),
          );
          const state = yield* Ref.get(stateRef);
          if (!state.plugins.has(name)) {
            return false;
          }
          yield* Ref.set(stateRef, {
            ...removePluginFromState(state, name),
            revision: state.revision + 1,
          });
          return true;
        }),
      );

    const getHookPoint: ContributionRegistryService["getHookPoint"] = (name) =>
      Ref.get(stateRef).pipe(
        Effect.flatMap((state) => {
          const definition = state.hookPoints.get(name);
          return definition === undefined
            ? Effect.fail(
                registryError("hook", "hook_point_unknown", `Unknown Hook point: ${name}.`),
              )
            : Effect.succeed(definition);
        }),
      );

    return {
      getHookPoint,
      list,
      listAll,
      lookup,
      registerHookPoint,
      registerKind,
      registerPlugin,
      removePlugin,
      revision: Ref.get(stateRef).pipe(Effect.map((state) => state.revision)),
    };
  });

export const ContributionRegistryLive = (
  options: ContributionRegistryOptions = {},
): Layer.Layer<ContributionRegistry> =>
  Layer.effect(ContributionRegistry, makeContributionRegistry(options));
