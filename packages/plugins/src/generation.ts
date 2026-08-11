/**
 * Owns Plugin generation construction and hot-reload lifetime routing.
 * It exists because D-027 needs two-phase native loading and A-003 requires each generation to
 * own an Effect Scope that can drain before reload closes its resources.
 *
 * Lease contract (D-005): a Turn checks out a generation at Turn open and holds the lease
 * until the Turn settles. The generation's resources stay open while any lease Scope is open;
 * reload drains leases before closing the old generation. checkout is the primitive; use and
 * useSerialized are re-expressed over it.
 * Import timeout (RFC Design 4, 03/D-010) bounds composition latency only: native ESM imports are
 * not cancellable, a timed-out import's side effects may still run later, and repeated reload
 * attempts with cache-busted specifiers accumulate registry entries.
 * Not responsible for Session-scoped Tool views (kernel owns that) or reload orchestration (CLI host owns that).
 */
import { randomUUID } from "node:crypto";

import { Clock, Context, Deferred, Effect, Exit, Layer, Ref, Scope } from "effect";

import { type CapabilityGrants, createCapabilityGrants } from "./capability.js";
import type { PluginDiscoveryConfig } from "./discovery.js";
import { phase1Sources, phase2Sources } from "./discovery.js";
import type { HookDiagnostic, HookEmitError, HookEmitterService } from "./emitter.js";
import { HookEmitter, HookEmitterLive } from "./emitter.js";
import type { ContributionRegistryError, PluginLoadError } from "./errors.js";
import { TrustResolverTimeoutError } from "./errors.js";
import { DEFAULT_IMPORT_TIMEOUT_MILLIS, loadPluginModule } from "./loader.js";
import type { PluginManifest } from "./manifest.js";
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
  | TrustResolverTimeoutError
  | TrustStoreError;

export const DEFAULT_TRUST_RESOLVER_TIMEOUT_MILLIS = 300_000;

export { DEFAULT_IMPORT_TIMEOUT_MILLIS };

export interface GenerationPlugin {
  readonly manifest: PluginManifest;
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
  readonly leaseCount: number;
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

export interface GenerationLease {
  readonly generation: PluginGeneration;
}

export interface PluginRuntime {
  readonly checkout: Effect.Effect<GenerationLease, never, Scope.Scope>;
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
  readonly generationFinalizerSink?: (generationId: string) => Effect.Effect<void>;
  readonly grants?: CapabilityGrants;
  readonly hookDiagnosticSink?: (diagnostic: HookDiagnostic) => Effect.Effect<void>;
  readonly importTimeoutMillis?: number;
  readonly registryDiagnosticSink?: (diagnostic: RegistryDiagnostic) => Effect.Effect<void>;
  readonly trust: TrustDecision | TrustResolver;
  readonly trustDiagnosticSink?: (diagnostic: TrustDiagnostic) => Effect.Effect<void>;
  readonly trustResolverTimeoutMillis?: number;
}

interface GenerationRuntime extends PluginGeneration {
  readonly scope: Scope.CloseableScope;
}

interface GenerationRoutingState {
  readonly drain: Deferred.Deferred<void> | null;
  readonly inFlight: number;
}

interface RoutableGeneration extends GenerationRuntime {
  readonly routing: Ref.Ref<GenerationRoutingState>;
}

const resolvedTrust = (
  options: LoadGenerationOptions,
  result: TrustCheckResult,
): Effect.Effect<
  TrustCheckResult,
  PluginDigestError | TrustResolverTimeoutError | TrustStoreError,
  TrustStore
> => {
  if (result.kind === "trusted" || result.kind === "untrusted") {
    return Effect.succeed(result);
  }
  const resolution =
    typeof options.trust === "function"
      ? options.trust(result).pipe(
          Effect.timeoutFail({
            duration: options.trustResolverTimeoutMillis ?? DEFAULT_TRUST_RESOLVER_TIMEOUT_MILLIS,
            onTimeout: () =>
              new TrustResolverTimeoutError({
                projectPath: options.config.projectPath,
                timeoutMillis:
                  options.trustResolverTimeoutMillis ?? DEFAULT_TRUST_RESOLVER_TIMEOUT_MILLIS,
              }),
          }),
        )
      : Effect.succeed(options.trust);
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
  importTimeoutMillis?: number,
): Effect.Effect<ReadonlyArray<GenerationPlugin>, ContributionRegistryError | PluginLoadError> =>
  Effect.forEach(sources, (source) =>
    loadPluginModule(source.path, {
      cacheKey: generationId,
      ...(importTimeoutMillis === undefined ? {} : { importTimeoutMillis }),
    }).pipe(
      Effect.tap((plugin) =>
        registry.registerPlugin(plugin.manifest, plugin.contributions, source.scope),
      ),
      Effect.map((plugin) => ({
        manifest: plugin.manifest,
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
    const generationFinalizerSink = options.generationFinalizerSink ?? (() => Effect.void);
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
      Effect.addFinalizer(() =>
        Ref.update(closedResources, (count) => count + 1).pipe(
          Effect.zipRight(generationFinalizerSink(generationId)),
        ),
      ),
    );
    const context = yield* Layer.buildWithScope(
      Layer.mergeAll(registryLayer, emitterLayer, lifetimeLayer),
      scope,
    );
    const registry = Context.get(context, ContributionRegistry);
    const emitter = Context.get(context, HookEmitter);
    return yield* Effect.gen(function* () {
      const externalSources = yield* phase1Sources(options.config);
      const externalPlugins = yield* registerSources(
        generationId,
        registry,
        externalSources,
        options.importTimeoutMillis,
      );
      // Trust Hook needs capability grants to gate the opt-in trust-gate plugin.
      // When the caller (pipeline) does not supply grants, derive them from the
      // external Plugin manifests already registered, so the trust gate can answer
      // via PluginInteractions (null layer at startup, live layer on reload).
      const externalCapabilities = externalPlugins.flatMap((plugin) =>
        plugin.manifest.capabilities.map((capability) => capability.name),
      );
      const trustGrants =
        options.grants ??
        createCapabilityGrants(
          "trust-check" as unknown as CapabilityGrants["sessionId"],
          externalCapabilities,
        );
      const trustOptions = {
        grants: trustGrants,
        hookEmitter: emitter,
        ...(options.trustDiagnosticSink === undefined
          ? {}
          : { diagnosticSink: options.trustDiagnosticSink }),
      };
      const checked = yield* checkTrust(options.config, trustOptions);
      const decision = yield* resolvedTrust(options, checked);
      const projectSources = yield* phase2Sources(options.config, decision);
      const projectPlugins = yield* registerSources(
        generationId,
        registry,
        projectSources,
        options.importTimeoutMillis,
      );
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
      routing: yield* Ref.make<GenerationRoutingState>({ drain: null, inFlight: 0 }),
    };
  });

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

    const settle = (generation: RoutableGeneration): Effect.Effect<void> =>
      routeMutex.withPermits(1)(
        Ref.modify(generation.routing, (state) => {
          const remaining = state.inFlight - 1;
          return [remaining === 0 ? state.drain : null, { ...state, inFlight: remaining }] as const;
        }).pipe(
          Effect.flatMap((drain) =>
            drain === null ? Effect.void : Deferred.succeed(drain, undefined),
          ),
          Effect.asVoid,
        ),
      );

    const checkout: PluginRuntime["checkout"] = Effect.acquireRelease(
      routeMutex.withPermits(1)(
        Effect.gen(function* () {
          const selected = yield* Ref.get(current);
          yield* Ref.update(selected.routing, (state) => ({
            ...state,
            inFlight: state.inFlight + 1,
          }));
          return { generation: selected } satisfies GenerationLease;
        }),
      ),
      (lease) => settle(lease.generation as RoutableGeneration),
    );

    const use: PluginRuntime["use"] = (run) =>
      Effect.scoped(checkout.pipe(Effect.flatMap((lease) => run(lease.generation))));

    const useSerialized: PluginRuntime["useSerialized"] = (run) =>
      reloadMutex.withPermits(1)(use(run));

    const reload = reloadMutex
      .withPermits(1)(
        Effect.gen(function* () {
          const fresh = yield* loadGenerationRuntime(options).pipe(Effect.flatMap(makeRoutable));
          const drain = yield* Deferred.make<void>();
          const { inFlight, old } = yield* routeMutex.withPermits(1)(
            Effect.gen(function* () {
              const selected = yield* Ref.get(current);
              const state = yield* Ref.get(selected.routing);
              yield* Ref.set(selected.routing, { ...state, drain });
              yield* Ref.set(current, fresh);
              return { inFlight: state.inFlight, old: selected };
            }),
          );
          if (inFlight === 0) {
            yield* Deferred.succeed(drain, undefined);
          }
          const drainStartedAt = yield* Clock.currentTimeMillis;
          yield* Deferred.await(drain);
          yield* old.close;
          const drainFinishedAt = yield* Clock.currentTimeMillis;
          return {
            closedResources: yield* old.closedResources,
            drainDurationMillis: drainFinishedAt - drainStartedAt,
            leaseCount: inFlight,
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
                leaseCount: diagnostic.leaseCount,
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
        const drain = yield* Deferred.make<void>();
        const { generation, inFlight } = yield* routeMutex.withPermits(1)(
          Effect.gen(function* () {
            const selected = yield* Ref.get(current);
            const state = yield* Ref.get(selected.routing);
            yield* Ref.set(selected.routing, { ...state, drain });
            return { generation: selected, inFlight: state.inFlight };
          }),
        );
        if (inFlight === 0) {
          yield* Deferred.succeed(drain, undefined);
        }
        yield* Deferred.await(drain);
        yield* generation.close;
      }),
    );

    const debugInfo = Ref.get(current).pipe(
      Effect.flatMap((generation) =>
        Ref.get(generation.routing).pipe(
          Effect.map((routing) => ({
            currentGenerationId: generation.id,
            inFlight: routing.inFlight,
            plugins: generation.plugins.map((plugin) => plugin.name),
          })),
        ),
      ),
    );

    return { checkout, close, debugInfo, reload, use, useSerialized };
  });
