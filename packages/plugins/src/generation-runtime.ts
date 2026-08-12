/**
 * Owns GenerationRuntime single owner for checkout/drain/busy/view/close/reload.
 * It exists because D-003 needs one Ref counting the lease; CLI and future TUI reuse without copy.
 * Why this module: makePluginRuntime was the single owner but CLI duplicated routing (pendingOlds, isReloading).
 * This module owns the ONE routing Ref<{inFlight,drain}> and ONE isReloading flag; CLI becomes DiscoveryAdapter -> config only.
 * It consumes PluginDiscovery (discovery.ts) as its private seam for phase1/2 source enumeration
 * and digest verification: GenerationRuntime calls phase1Sources for trust prompts and phase2Sources
 * for execution, and loader + registry are its other private seams for import and priority. Callers
 * depend on GenerationRuntime's checkout/use/reload; they do not reach through to discovery,
 * loader, or registry directly, so checkout counting and drain timing are localized to the one Ref.
 * Not responsible for source enumeration shape (sources owns file walks) or digest hash limits
 * (trust-digest owns bounds) or module import caveats (loader owns ESM cacheKey tradeoffs) or
 * Turn orchestration (TurnOrchestrator owns retry/batch/compaction/steering).
 */

import { randomUUID } from "node:crypto";

import { Clock, Context, Data, Deferred, Effect, Exit, Layer, Ref, Scope } from "effect";

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

export class GenerationBusyError extends Data.TaggedError("GenerationBusyError")<{
  readonly message: string;
}> {}

export class GenerationDrainTimeoutError extends Data.TaggedError("GenerationDrainTimeoutError")<{
  readonly drainTimeoutMillis: number;
  readonly holders: ReadonlyArray<string>;
  readonly leaseCount: number;
  readonly message: string;
  readonly newGenerationId: string;
  readonly oldGenerationId: string;
}> {}

export interface GenerationRuntime<E = GenerationLoadError, R = TrustStore> {
  readonly busy: Effect.Effect<boolean>;
  readonly checkout: Effect.Effect<GenerationLease, never, Scope.Scope>;
  readonly close: Effect.Effect<void>;
  readonly currentGeneration: Effect.Effect<PluginGeneration>;
  readonly debugInfo: Effect.Effect<PluginRuntimeDebugInfo>;
  readonly reload: Effect.Effect<
    GenerationSwapDiagnostic,
    E | GenerationBusyError | GenerationDrainTimeoutError,
    R
  >;
  readonly use: <TOutput, TError, TRequirements>(
    run: (generation: PluginGeneration) => Effect.Effect<TOutput, TError, TRequirements>,
  ) => Effect.Effect<TOutput, TError, TRequirements>;
  readonly useSerialized: <TOutput, TError, TRequirements>(
    run: (generation: PluginGeneration) => Effect.Effect<TOutput, TError, TRequirements>,
  ) => Effect.Effect<TOutput, TError, TRequirements>;
  readonly view: (sessionId: unknown) => Effect.Effect<PluginGeneration>;
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

interface GenerationRuntimeInternal extends PluginGeneration {
  readonly scope: Scope.CloseableScope;
}

interface GenerationRoutingState {
  readonly drain: Deferred.Deferred<void> | null;
  readonly inFlight: number;
}

interface RoutableGeneration extends GenerationRuntimeInternal {
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

const loadGenerationRuntimeInternal = (
  options: LoadGenerationOptions,
): Effect.Effect<GenerationRuntimeInternal, GenerationLoadError, TrustStore> =>
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

const makeRoutable = (generation: GenerationRuntimeInternal): Effect.Effect<RoutableGeneration> =>
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

const makeRuntimeInternal = <E, R>(
  load: () => Effect.Effect<RoutableGeneration, E, R>,
  diagnosticSink: ((d: GenerationSwapDiagnostic) => Effect.Effect<void>) | undefined,
): Effect.Effect<GenerationRuntime<E, R>, E, R> =>
  Effect.gen(function* () {
    const initial = yield* load();
    const current = yield* Ref.make(initial);
    const isReloading = yield* Ref.make(false);
    const reloadMutex = yield* Effect.makeSemaphore(1);
    const routeMutex = yield* Effect.makeSemaphore(1);
    const generationDiagnosticSink =
      diagnosticSink ?? ((d: GenerationSwapDiagnostic) => Effect.logInfo(JSON.stringify(d)));

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

    const checkout: GenerationRuntime<E, R>["checkout"] = Effect.acquireRelease(
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

    const use: GenerationRuntime<E, R>["use"] = (run) =>
      Effect.scoped(checkout.pipe(Effect.flatMap((lease) => run(lease.generation))));

    const useSerialized: GenerationRuntime<E, R>["useSerialized"] = (run) =>
      reloadMutex.withPermits(1)(use(run));

    const busy: GenerationRuntime<E, R>["busy"] = Ref.get(isReloading);

    const currentGeneration: GenerationRuntime<E, R>["currentGeneration"] = Ref.get(current).pipe(
      Effect.map((g) => g as PluginGeneration),
    );

    const view: GenerationRuntime<E, R>["view"] = (_sessionId: unknown) =>
      Ref.get(current).pipe(Effect.map((g) => g as PluginGeneration));

    const innerDrainReload = Effect.gen(function* () {
      const fresh = yield* load();
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
      const closed = yield* old.closedResources;
      const deltas = pluginChanges(old, fresh);
      const diagnostic: GenerationSwapDiagnostic = {
        closedResources: closed,
        drainDurationMillis: drainFinishedAt - drainStartedAt,
        leaseCount: inFlight,
        newGenerationId: fresh.id,
        oldGenerationId: old.id,
        pluginsAdded: deltas.pluginsAdded,
        pluginsRemoved: deltas.pluginsRemoved,
        pluginsReplaced: deltas.pluginsReplaced,
        type: "generation_swap",
      };
      return diagnostic;
    }).pipe(
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
      Effect.tap((diagnostic) =>
        Effect.logInfo(JSON.stringify({ diagnosticFamily: "generation", ...diagnostic })).pipe(
          Effect.annotateLogs({
            diagnostic: "generation_swap",
            newGenerationId: diagnostic.newGenerationId,
            oldGenerationId: diagnostic.oldGenerationId,
          }),
        ),
      ),
    );

    const reloadWrapped: GenerationRuntime<E, R>["reload"] = Effect.gen(function* () {
      const acquired = yield* Ref.modify(isReloading, (busyFlag) =>
        busyFlag ? ([false, true] as const) : ([true, true] as const),
      );
      if (!acquired) {
        yield* Effect.logWarning(
          JSON.stringify({ diagnostic: "reload_busy", reason: "A reload is already in progress." }),
        ).pipe(Effect.annotateLogs({ diagnostic: "reload_busy" }));
        return yield* new GenerationBusyError({ message: "Reload is already in progress." });
      }
      return yield* reloadMutex
        .withPermits(1)(innerDrainReload)
        .pipe(Effect.ensuring(Ref.set(isReloading, false)));
    }) as unknown as GenerationRuntime<E, R>["reload"];

    const close: GenerationRuntime<E, R>["close"] = reloadMutex.withPermits(1)(
      Effect.gen(function* () {
        const acquired = yield* Ref.modify(isReloading, (busyFlag) =>
          busyFlag ? ([false, true] as const) : ([true, true] as const),
        );
        if (!acquired) {
          yield* Effect.logWarning(
            "Close called while reload is busy; closing current generation without drain wait.",
          );
        }
        try {
          const gen = yield* Ref.get(current);
          const state = yield* Ref.get(gen.routing);
          if (state.inFlight === 0) {
            if (state.drain !== null) {
              yield* Deferred.await(state.drain);
            }
            yield* gen.close;
          } else {
            const drain = state.drain ?? (yield* Deferred.make<void>());
            if (state.drain === null) {
              yield* Ref.set(gen.routing, { ...state, drain });
            }
            yield* Deferred.await(drain);
            yield* gen.close;
          }
        } finally {
          yield* Ref.set(isReloading, false);
        }
      }),
    );

    const debugInfo: GenerationRuntime<E, R>["debugInfo"] = Ref.get(current).pipe(
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

    return {
      busy,
      checkout,
      close,
      currentGeneration,
      debugInfo,
      reload: reloadWrapped,
      use,
      useSerialized,
      view,
    } as GenerationRuntime<E, R>;
  });

export const makeGenerationRuntime = (
  options: LoadGenerationOptions,
): Effect.Effect<
  GenerationRuntime<GenerationLoadError, TrustStore>,
  GenerationLoadError,
  TrustStore
> =>
  makeRuntimeInternal<GenerationLoadError, TrustStore>(
    () => loadGenerationRuntimeInternal(options).pipe(Effect.flatMap(makeRoutable)),
    options.generationDiagnosticSink,
  );

export const makeGenerationRuntimeWithLoader = <E, R>(
  load: () => Effect.Effect<PluginGeneration, E, R>,
  diagnosticSink: ((d: GenerationSwapDiagnostic) => Effect.Effect<void>) | undefined = undefined,
): Effect.Effect<GenerationRuntime<E, R>, E, R> =>
  Effect.gen(function* () {
    const loadRoutable = (): Effect.Effect<RoutableGeneration, E, R> =>
      load().pipe(
        Effect.flatMap((gen) => {
          // Wrap raw PluginGeneration into Routable if not already
          const maybeRoutable = gen as unknown as RoutableGeneration;
          if (maybeRoutable.routing !== undefined) {
            return Effect.succeed(maybeRoutable);
          }
          // Need to create routing for generation that came from composePluginRuntime
          // compose returns PluginGeneration with scope not exposed; we adapt
          return Effect.gen(function* () {
            const routing = yield* Ref.make<GenerationRoutingState>({ drain: null, inFlight: 0 });
            const closedResources =
              (gen as unknown as { closedResources?: Effect.Effect<number> }).closedResources ??
              Effect.succeed(0);
            const internal: GenerationRuntimeInternal = {
              close: gen.close,
              closedResources:
                typeof closedResources === "number"
                  ? Effect.succeed(closedResources)
                  : closedResources,
              emitter: gen.emitter,
              id: gen.id,
              plugins: gen.plugins,
              registry: gen.registry,
              scope: {
                close: (_exit: Exit.Exit<void, unknown>) => gen.close.pipe(Effect.asVoid),
              } as unknown as Scope.CloseableScope,
            };
            return {
              ...internal,
              close: gen.close,
              closedResources:
                (gen as unknown as { closedResources: Effect.Effect<number> }).closedResources ??
                Effect.succeed(0),
              emitter: gen.emitter,
              id: gen.id,
              plugins: gen.plugins,
              registry: gen.registry,
              routing,
              scope: internal.scope,
            } as RoutableGeneration;
          });
        }),
      );
    return yield* makeRuntimeInternal<E, R>(loadRoutable, diagnosticSink);
  });

export const loadGeneration = (
  options: LoadGenerationOptions,
): Effect.Effect<PluginGeneration, GenerationLoadError, TrustStore> =>
  loadGenerationRuntimeInternal(options);
