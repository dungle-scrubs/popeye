/**
 * Owns Plugin generation construction and hot-reload lifetime routing.
 * It exists because D-027 needs two-phase native loading and A-003 requires each generation to
 * own an Effect Scope that can drain before reload closes its resources.
 */
import { randomUUID } from "node:crypto";

import { Clock, Context, Deferred, Effect, Exit, Layer, Ref, Scope } from "effect";

import type { CapabilityGrants } from "./capability.js";
import type { PluginDiscoveryConfig } from "./discovery.js";
import { phase1Sources, phase2Sources } from "./discovery.js";
import type { HookDiagnostic, HookEmitError, HookEmitterService } from "./emitter.js";
import { HookEmitter, HookEmitterLive } from "./emitter.js";
import type { ContributionRegistryError, PluginLoadError } from "./errors.js";
import { loadPluginModule } from "./loader.js";
import type { ContributionRegistryService, RegistryDiagnostic } from "./registry.js";
import { ContributionRegistry, ContributionRegistryLive } from "./registry.js";
import type { PluginDiscoveryError, PluginSource, PluginSourceScope } from "./sources.js";
import type {
  TrustCheckResult,
  TrustDecision,
  TrustDiagnostic,
  TrustStore,
  TrustStoreError,
} from "./trust.js";
import { checkTrust, recordDecision } from "./trust.js";
import type { PluginDigestError } from "./trust-digest.js";

export type GenerationLoadError =
  | ContributionRegistryError
  | HookEmitError<"trust">
  | PluginDigestError
  | PluginDiscoveryError
  | PluginLoadError
  | TrustStoreError;

export interface GenerationPlugin {
  readonly name: string;
  readonly path: string;
  readonly scope: PluginSourceScope;
  readonly version: string;
}

export interface PluginGeneration {
  readonly close: Effect.Effect<void>;
  readonly closedResources: Effect.Effect<number>;
  readonly emitter: HookEmitterService;
  readonly id: string;
  readonly plugins: ReadonlyArray<GenerationPlugin>;
  readonly registry: ContributionRegistryService;
}

export interface GenerationSwapDiagnostic {
  readonly closedResources: number;
  readonly drainDurationMillis: number;
  readonly newGenerationId: string;
  readonly oldGenerationId: string;
  readonly pluginsAdded: ReadonlyArray<string>;
  readonly pluginsRemoved: ReadonlyArray<string>;
  readonly pluginsReplaced: ReadonlyArray<string>;
  readonly type: "generation_swap";
}

export interface PluginRuntimeDebugInfo {
  readonly currentGenerationId: string;
  readonly inFlight: number;
  readonly plugins: ReadonlyArray<string>;
}

export interface PluginRuntime {
  readonly close: Effect.Effect<void>;
  readonly debugInfo: Effect.Effect<PluginRuntimeDebugInfo>;
  readonly reload: Effect.Effect<GenerationSwapDiagnostic, GenerationLoadError, TrustStore>;
  readonly use: <TOutput, TError, TRequirements>(
    run: (generation: PluginGeneration) => Effect.Effect<TOutput, TError, TRequirements>,
  ) => Effect.Effect<TOutput, TError, TRequirements>;
  readonly useSerialized: <TOutput, TError, TRequirements>(
    run: (generation: PluginGeneration) => Effect.Effect<TOutput, TError, TRequirements>,
  ) => Effect.Effect<TOutput, TError, TRequirements>;
}

export type TrustResolutionRequest = Extract<
  TrustCheckResult,
  { readonly kind: "prompt_required" | "reprompt_required" }
>;

export type TrustResolver = (request: TrustResolutionRequest) => Effect.Effect<TrustDecision>;

export interface LoadGenerationOptions {
  readonly config: PluginDiscoveryConfig;
  readonly generationDiagnosticSink?: (diagnostic: GenerationSwapDiagnostic) => Effect.Effect<void>;
  readonly grants?: CapabilityGrants;
  readonly hookDiagnosticSink?: (diagnostic: HookDiagnostic) => Effect.Effect<void>;
  readonly registryDiagnosticSink?: (diagnostic: RegistryDiagnostic) => Effect.Effect<void>;
  readonly trust: TrustDecision | TrustResolver;
  readonly trustDiagnosticSink?: (diagnostic: TrustDiagnostic) => Effect.Effect<void>;
}

interface GenerationRuntime extends PluginGeneration {
  readonly scope: Scope.CloseableScope;
}

interface RoutableGeneration extends GenerationRuntime {
  readonly drained: Deferred.Deferred<void>;
  readonly inFlight: Ref.Ref<number>;
}

const resolvedTrust = (
  options: LoadGenerationOptions,
  result: TrustCheckResult,
): Effect.Effect<TrustCheckResult, PluginDigestError | TrustStoreError, TrustStore> => {
  if (result.kind === "trusted" || result.kind === "untrusted") {
    return Effect.succeed(result);
  }
  const resolution =
    typeof options.trust === "function" ? options.trust(result) : Effect.succeed(options.trust);
  return resolution.pipe(
    Effect.flatMap((decision) =>
      recordDecision(options.config, decision, result.currentDigest, "user").pipe(
        Effect.as(
          decision === "trusted"
            ? ({
                decidedBy: "user",
                kind: "trusted",
                trustedDigest: result.currentDigest,
              } as const)
            : ({ decidedBy: "user", kind: "untrusted" } as const),
        ),
      ),
    ),
  );
};

const registerSources = (
  generationId: string,
  registry: ContributionRegistryService,
  sources: ReadonlyArray<PluginSource>,
): Effect.Effect<ReadonlyArray<GenerationPlugin>, ContributionRegistryError | PluginLoadError> =>
  Effect.forEach(sources, (source) =>
    loadPluginModule(source.path, { cacheKey: generationId }).pipe(
      Effect.tap((plugin) =>
        registry.registerPlugin(plugin.manifest, plugin.contributions, source.scope),
      ),
      Effect.map((plugin) => ({
        name: plugin.manifest.name,
        path: source.path,
        scope: source.scope,
        version: plugin.manifest.version,
      })),
    ),
  );

const loadGenerationRuntime = (
  options: LoadGenerationOptions,
): Effect.Effect<GenerationRuntime, GenerationLoadError, TrustStore> =>
  Effect.gen(function* () {
    const generationId = randomUUID();
    const scope = yield* Scope.make();
    const closedResources = yield* Ref.make(0);
    const registryLayer = ContributionRegistryLive(
      options.registryDiagnosticSink === undefined
        ? {}
        : { diagnosticSink: options.registryDiagnosticSink },
    );
    const emitterLayer = HookEmitterLive(
      options.hookDiagnosticSink === undefined
        ? {}
        : { diagnosticSink: options.hookDiagnosticSink },
    ).pipe(Layer.provide(registryLayer));
    const lifetimeLayer = Layer.scopedDiscard(
      Effect.addFinalizer(() => Ref.update(closedResources, (count) => count + 1)),
    );
    const context = yield* Layer.buildWithScope(
      Layer.mergeAll(registryLayer, emitterLayer, lifetimeLayer),
      scope,
    );
    const registry = Context.get(context, ContributionRegistry);
    const emitter = Context.get(context, HookEmitter);
    return yield* Effect.gen(function* () {
      const externalSources = yield* phase1Sources(options.config);
      const externalPlugins = yield* registerSources(generationId, registry, externalSources);
      const trustOptions = {
        ...(options.grants === undefined ? {} : { grants: options.grants }),
        hookEmitter: emitter,
        ...(options.trustDiagnosticSink === undefined
          ? {}
          : { diagnosticSink: options.trustDiagnosticSink }),
      };
      const checked = yield* checkTrust(options.config, trustOptions);
      const decision = yield* resolvedTrust(options, checked);
      const projectSources = yield* phase2Sources(options.config, decision);
      const projectPlugins = yield* registerSources(generationId, registry, projectSources);
      return {
        close: Scope.close(scope, Exit.succeed(undefined)),
        closedResources: Ref.get(closedResources),
        emitter,
        id: generationId,
        plugins: [...externalPlugins, ...projectPlugins],
        registry,
        scope,
      };
    }).pipe(
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
    );
  });

export const loadGeneration = (
  options: LoadGenerationOptions,
): Effect.Effect<PluginGeneration, GenerationLoadError, TrustStore> =>
  loadGenerationRuntime(options);

const makeRoutable = (generation: GenerationRuntime): Effect.Effect<RoutableGeneration> =>
  Effect.gen(function* () {
    return {
      ...generation,
      drained: yield* Deferred.make<void>(),
      inFlight: yield* Ref.make(0),
    };
  });

const settle = (generation: RoutableGeneration): Effect.Effect<void> =>
  Ref.modify(generation.inFlight, (count) => {
    const remaining = count - 1;
    return [remaining, remaining] as const;
  }).pipe(
    Effect.flatMap((remaining) =>
      remaining === 0 ? Deferred.succeed(generation.drained, undefined) : Effect.void,
    ),
    Effect.asVoid,
  );

const pluginChanges = (
  oldGeneration: RoutableGeneration,
  newGeneration: RoutableGeneration,
): Pick<GenerationSwapDiagnostic, "pluginsAdded" | "pluginsRemoved" | "pluginsReplaced"> => {
  const oldNames = new Set(oldGeneration.plugins.map((plugin) => plugin.name));
  const newNames = new Set(newGeneration.plugins.map((plugin) => plugin.name));
  return {
    pluginsAdded: [...newNames].filter((name) => !oldNames.has(name)).sort(),
    pluginsRemoved: [...oldNames].filter((name) => !newNames.has(name)).sort(),
    pluginsReplaced: [...newNames].filter((name) => oldNames.has(name)).sort(),
  };
};

export const makePluginRuntime = (
  options: LoadGenerationOptions,
): Effect.Effect<PluginRuntime, GenerationLoadError, TrustStore> =>
  Effect.gen(function* () {
    const initial = yield* loadGenerationRuntime(options).pipe(Effect.flatMap(makeRoutable));
    const current = yield* Ref.make(initial);
    const routeMutex = yield* Effect.makeSemaphore(1);
    const reloadMutex = yield* Effect.makeSemaphore(1);
    const generationDiagnosticSink =
      options.generationDiagnosticSink ??
      ((diagnostic: GenerationSwapDiagnostic) => Effect.logInfo(JSON.stringify(diagnostic)));

    const use: PluginRuntime["use"] = (run) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const generation = yield* routeMutex.withPermits(1)(
            Effect.gen(function* () {
              const selected = yield* Ref.get(current);
              yield* Ref.update(selected.inFlight, (count) => count + 1);
              return selected;
            }),
          );
          return yield* restore(run(generation)).pipe(Effect.ensuring(settle(generation)));
        }),
      );

    const useSerialized: PluginRuntime["useSerialized"] = (run) =>
      reloadMutex.withPermits(1)(use(run));

    const reload = reloadMutex
      .withPermits(1)(
        Effect.gen(function* () {
          const fresh = yield* loadGenerationRuntime(options).pipe(Effect.flatMap(makeRoutable));
          const old = yield* routeMutex.withPermits(1)(
            Effect.gen(function* () {
              const selected = yield* Ref.get(current);
              yield* Ref.set(current, fresh);
              const count = yield* Ref.get(selected.inFlight);
              if (count === 0) {
                yield* Deferred.succeed(selected.drained, undefined);
              }
              return selected;
            }),
          );
          const drainStartedAt = yield* Clock.currentTimeMillis;
          yield* Deferred.await(old.drained);
          yield* old.close;
          const drainFinishedAt = yield* Clock.currentTimeMillis;
          return {
            closedResources: yield* old.closedResources,
            drainDurationMillis: drainFinishedAt - drainStartedAt,
            newGenerationId: fresh.id,
            oldGenerationId: old.id,
            ...pluginChanges(old, fresh),
            type: "generation_swap" as const,
          };
        }),
      )
      .pipe(
        Effect.tap((diagnostic) =>
          generationDiagnosticSink(diagnostic).pipe(
            Effect.zipRight(
              Effect.annotateCurrentSpan({
                closedResources: diagnostic.closedResources,
                drainDurationMillis: diagnostic.drainDurationMillis,
                newGenerationId: diagnostic.newGenerationId,
                oldGenerationId: diagnostic.oldGenerationId,
                pluginsAdded: JSON.stringify(diagnostic.pluginsAdded),
                pluginsRemoved: JSON.stringify(diagnostic.pluginsRemoved),
                pluginsReplaced: JSON.stringify(diagnostic.pluginsReplaced),
              }),
            ),
          ),
        ),
        Effect.withSpan("plugins.reload"),
      );

    const close = reloadMutex.withPermits(1)(
      Effect.gen(function* () {
        const generation = yield* Ref.get(current);
        const count = yield* Ref.get(generation.inFlight);
        if (count === 0) {
          yield* Deferred.succeed(generation.drained, undefined);
        }
        yield* Deferred.await(generation.drained);
        yield* generation.close;
      }),
    );

    const debugInfo = Ref.get(current).pipe(
      Effect.flatMap((generation) =>
        Ref.get(generation.inFlight).pipe(
          Effect.map((inFlight) => ({
            currentGenerationId: generation.id,
            inFlight,
            plugins: generation.plugins.map((plugin) => plugin.name),
          })),
        ),
      ),
    );

    return { close, debugInfo, reload, use, useSerialized };
  });
