/**
 * Owns GenerationRuntime single owner for checkout/drain/busy/view/close/reload.
 * It exists because D-003 needs one Ref counting the lease; CLI and future TUI reuse without copy.
 * Tool calls lease the Generation that provided their Tool through checkoutGeneration. A reload prepares the fresh generation (prepareSwap), publishes it in one synchronous step, and hands the old generation to a closer fiber that alone closes it after its drain; the caller waits for that closer for at most drainTimeoutMillis, then returns GenerationDrainTimeoutError (#93).
 * Why this module: the former makePluginRuntime was the single owner but CLI duplicated routing (pendingOlds, isReloading).
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

import {
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  MutableRef,
  Option,
  Ref,
  Scope,
} from "effect";

import { type CapabilityGrants, createCapabilityGrants } from "./capability.js";
import type { PluginDiscoveryConfig } from "./discovery.js";
import { phase1Sources, phase2Sources } from "./discovery.js";
import type { HookDiagnostic, HookEmitError, HookEmitterService } from "./emitter.js";
import { HookEmitter, HookEmitterLive } from "./emitter.js";
import type { ContributionRegistryError, PluginLoadError } from "./errors.js";
import { TrustResolverTimeoutError } from "./errors.js";
import { DEFAULT_IMPORT_TIMEOUT_MILLIS } from "./loader.js";
import type { PluginManifest } from "./manifest.js";
import { registerPluginSources } from "./plugin-pipeline.js";
import type { ContributionRegistryService, RegistryDiagnostic } from "./registry.js";
import { ContributionRegistry, ContributionRegistryLive } from "./registry.js";
import type { PluginDiscoveryError, PluginSourceScope } from "./sources.js";
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

export const DEFAULT_DRAIN_TIMEOUT_MILLIS = 5_000;

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
  readonly holder: string;
}

export interface GenerationRuntimeOptions<E = GenerationLoadError> {
  /** How long a reload waits for the old generation's leases. Default DEFAULT_DRAIN_TIMEOUT_MILLIS. */
  readonly drainTimeoutMillis?: number;
  /**
   * Runs once after a generation's Scope closes: a replaced generation after its drain, a fresh
   * generation discarded before it was published, and the current generation in close.
   */
  readonly onGenerationClosed?: (generation: PluginGeneration) => Effect.Effect<void>;
  /**
   * Runs after a reload loads `fresh` and before routing changes; `fresh` is not observable
   * until it returns. A failure, defect, or interruption here closes `fresh` and ends the
   * reload; the current generation keeps serving.
   */
  readonly prepareSwap?: (fresh: PluginGeneration) => Effect.Effect<void, E>;
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
  /**
   * Leases the generation with this id for the enclosing Scope while it admits leases: the
   * current generation, or a replaced one whose leases are still running. None when it is
   * unknown, draining to zero, finalizing, closing with the runtime, or closed.
   */
  readonly checkoutGeneration: (
    generationId: string,
    holder: string,
  ) => Effect.Effect<Option.Option<GenerationLease>, never, Scope.Scope>;
  /**
   * The current generation, read synchronously for plain-TypeScript readers. It changes in the
   * same step as `currentGeneration`.
   */
  readonly unsafeCurrentGeneration: () => PluginGeneration;
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
  /** False once the generation stops admitting id-specific leases (drained to zero, or closing). */
  readonly admitting: boolean;
  readonly drain: Deferred.Deferred<void> | null;
  /** One label per lease; holders.length === inFlight. */
  readonly holders: ReadonlyArray<string>;
  readonly inFlight: number;
}
const initialRoutingState: GenerationRoutingState = {
  admitting: true,
  drain: null,
  holders: [],
  inFlight: 0,
};

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

/**
 * Private seam of PluginPipeline (C3 architecture review): GenerationRuntime no longer owns
 * ESM import + manifest validation + registry priority directly; it delegates to
 * PluginPipeline.register which hides cacheKey and loader caveats behind one seam.
 * Not responsible for source enumeration (discovery owns that) or for generation
 * lifetime (this module owns checkout/drain).
 */
const registerSources = registerPluginSources;

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
      routing: yield* Ref.make<GenerationRoutingState>(initialRoutingState),
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
  options: GenerationRuntimeOptions<E> = {},
): Effect.Effect<GenerationRuntime<E, R>, E, R> =>
  Effect.gen(function* () {
    const initial = yield* load();
    const drainTimeoutMillis = options.drainTimeoutMillis ?? DEFAULT_DRAIN_TIMEOUT_MILLIS;
    const prepareSwap = options.prepareSwap ?? (() => Effect.void);
    const onGenerationClosed = options.onGenerationClosed ?? (() => Effect.void);
    const current = MutableRef.make(initial);
    const readCurrent: Effect.Effect<RoutableGeneration> = Effect.sync(() =>
      MutableRef.get(current),
    );
    const open = yield* Ref.make<ReadonlyMap<string, RoutableGeneration>>(
      new Map([[initial.id, initial]]),
    );
    const closers = yield* Ref.make<
      ReadonlyMap<string, Fiber.RuntimeFiber<GenerationSwapDiagnostic>>
    >(new Map());
    const withEntry =
      <V>(key: string, value: V) =>
      (map: ReadonlyMap<string, V>): ReadonlyMap<string, V> =>
        new Map([...map, [key, value]]);
    const withoutKey =
      <V>(key: string) =>
      (map: ReadonlyMap<string, V>): ReadonlyMap<string, V> => {
        const next = new Map(map);
        next.delete(key);
        return next;
      };
    const isReloading = yield* Ref.make(false);
    const reloadMutex = yield* Effect.makeSemaphore(1);
    const routeMutex = yield* Effect.makeSemaphore(1);
    const generationDiagnosticSink =
      diagnosticSink ?? ((d: GenerationSwapDiagnostic) => Effect.logInfo(JSON.stringify(d)));

    const acquire = (generation: RoutableGeneration, holder: string) =>
      Ref.update(generation.routing, (state) => ({
        ...state,
        holders: [...state.holders, holder],
        inFlight: state.inFlight + 1,
      }));

    const settle = (generation: RoutableGeneration, holder: string): Effect.Effect<void> =>
      routeMutex.withPermits(1)(
        Ref.modify(generation.routing, (state) => {
          const remaining = state.inFlight - 1;
          const index = state.holders.indexOf(holder);
          const holders = state.holders.filter((_, i) => i !== index);
          const drained = remaining === 0 && state.drain !== null;
          return [
            drained ? state.drain : null,
            {
              ...state,
              admitting: drained ? false : state.admitting,
              holders,
              inFlight: remaining,
            },
          ] as const;
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
          const selected = yield* readCurrent;
          yield* acquire(selected, "checkout");
          return { generation: selected, holder: "checkout" };
        }),
      ),
      (lease) => settle(lease.generation, lease.holder),
    );

    const checkoutGeneration: GenerationRuntime<E, R>["checkoutGeneration"] = (
      generationId,
      holder,
    ) =>
      Effect.acquireRelease(
        routeMutex.withPermits(1)(
          Effect.gen(function* () {
            const generation = (yield* Ref.get(open)).get(generationId);
            if (generation === undefined || !(yield* Ref.get(generation.routing)).admitting) {
              return Option.none();
            }
            yield* acquire(generation, holder);
            return Option.some({ generation, holder });
          }),
        ),
        (lease) =>
          Option.isSome(lease)
            ? settle(lease.value.generation as RoutableGeneration, holder)
            : Effect.void,
      );

    const use: GenerationRuntime<E, R>["use"] = (run) =>
      Effect.scoped(checkout.pipe(Effect.flatMap((lease) => run(lease.generation))));

    const useSerialized: GenerationRuntime<E, R>["useSerialized"] = (run) =>
      reloadMutex.withPermits(1)(use(run));

    const busy: GenerationRuntime<E, R>["busy"] = Ref.get(isReloading);

    const currentGeneration: GenerationRuntime<E, R>["currentGeneration"] = readCurrent.pipe(
      Effect.map((g) => g as PluginGeneration),
    );

    const view: GenerationRuntime<E, R>["view"] = (_sessionId: unknown) =>
      readCurrent.pipe(Effect.map((g) => g as PluginGeneration));

    const unsafeCurrentGeneration = (): PluginGeneration => MutableRef.get(current);

    const emitSwapDiagnostic = (diagnostic: GenerationSwapDiagnostic) =>
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
        Effect.zipRight(
          Effect.logInfo(JSON.stringify({ diagnosticFamily: "generation", ...diagnostic })).pipe(
            Effect.annotateLogs({
              diagnostic: "generation_swap",
              newGenerationId: diagnostic.newGenerationId,
              oldGenerationId: diagnostic.oldGenerationId,
            }),
          ),
        ),
      );

    const discard = (generation: RoutableGeneration) =>
      Ref.update(open, withoutKey(generation.id)).pipe(
        Effect.zipRight(generation.close),
        Effect.zipRight(onGenerationClosed(generation)),
      );

    const closeReplaced = ({
      drain,
      drainStartedAt,
      fresh,
      leaseCount,
      old,
    }: {
      readonly drain: Deferred.Deferred<void>;
      readonly drainStartedAt: number;
      readonly fresh: RoutableGeneration;
      readonly leaseCount: number;
      readonly old: RoutableGeneration;
    }) =>
      Effect.gen(function* () {
        yield* Deferred.await(drain);
        yield* discard(old);
        const finishedAt = yield* Clock.currentTimeMillis;
        const closedResources = yield* old.closedResources;
        const diagnostic: GenerationSwapDiagnostic = {
          closedResources,
          drainDurationMillis: finishedAt - drainStartedAt,
          leaseCount,
          newGenerationId: fresh.id,
          oldGenerationId: old.id,
          ...pluginChanges(old, fresh),
          type: "generation_swap",
        };
        yield* emitSwapDiagnostic(diagnostic);
        return diagnostic;
      }).pipe(Effect.ensuring(Ref.update(closers, withoutKey(old.id))));

    const innerDrainReload = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const fresh = yield* restore(load());
        yield* restore(prepareSwap(fresh)).pipe(Effect.onError(() => discard(fresh)));
        const swap = yield* routeMutex.withPermits(1)(
          Effect.gen(function* () {
            const old = yield* readCurrent;
            const state = yield* Ref.get(old.routing);
            const drain = yield* Deferred.make<void>();
            yield* Ref.set(old.routing, { ...state, admitting: state.inFlight > 0, drain });
            yield* Ref.update(open, withEntry(fresh.id, fresh));
            yield* Effect.sync(() => MutableRef.set(current, fresh));
            if (state.inFlight === 0) {
              yield* Deferred.succeed(drain, undefined);
            }
            const drainStartedAt = yield* Clock.currentTimeMillis;
            const registered = yield* Deferred.make<void>();
            const closer = yield* Effect.forkDaemon(
              Deferred.await(registered).pipe(
                Effect.zipRight(
                  closeReplaced({
                    drain,
                    drainStartedAt,
                    fresh,
                    leaseCount: state.inFlight,
                    old,
                  }),
                ),
              ),
            );
            yield* Ref.update(closers, withEntry(old.id, closer));
            yield* Deferred.succeed(registered, undefined);
            return { closer, old };
          }),
        );
        const drained = yield* Effect.interruptible(Fiber.join(swap.closer)).pipe(
          Effect.timeoutOption(Duration.millis(drainTimeoutMillis)),
        );
        if (Option.isSome(drained)) {
          return drained.value;
        }
        const completed = yield* Fiber.poll(swap.closer);
        if (Option.isSome(completed)) {
          return yield* completed.value;
        }
        const old = swap.old;
        const holders = [...(yield* Ref.get(old.routing)).holders].sort();
        yield* Effect.logWarning(
          JSON.stringify({
            diagnostic: "generation_drain_timeout",
            drainTimeoutMillis,
            holders,
            newGenerationId: fresh.id,
            oldGenerationId: old.id,
          }),
        ).pipe(Effect.annotateLogs({ diagnostic: "generation_drain_timeout" }));
        return yield* new GenerationDrainTimeoutError({
          drainTimeoutMillis,
          holders,
          leaseCount: holders.length,
          message:
            holders.length === 0
              ? `Reload swapped to generation ${fresh.id}, but generation ${old.id} was still closing after ${drainTimeoutMillis} ms.`
              : `Reload swapped to generation ${fresh.id}, but generation ${old.id} still has ${holders.length} running lease(s) after ${drainTimeoutMillis} ms (${holders.join(", ")}); it closes when they settle.`,
          newGenerationId: fresh.id,
          oldGenerationId: old.id,
        });
      }),
    ).pipe(Effect.withSpan("plugins.reload"));

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
          const { generation, drain } = yield* routeMutex.withPermits(1)(
            Effect.gen(function* () {
              const generation = yield* readCurrent;
              const state = yield* Ref.get(generation.routing);
              const drain = state.drain ?? (yield* Deferred.make<void>());
              yield* Ref.set(generation.routing, { ...state, admitting: false, drain });
              if (state.inFlight === 0) {
                yield* Deferred.succeed(drain, undefined);
              }
              return { generation, drain };
            }),
          );
          yield* Deferred.await(drain);
          yield* Effect.forEach([...(yield* Ref.get(closers)).values()], Fiber.await, {
            discard: true,
          });
          yield* discard(generation);
        } finally {
          yield* Ref.set(isReloading, false);
        }
      }),
    );

    const debugInfo: GenerationRuntime<E, R>["debugInfo"] = readCurrent.pipe(
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
      checkoutGeneration,
      close,
      currentGeneration,
      debugInfo,
      reload: reloadWrapped,
      use,
      useSerialized,
      unsafeCurrentGeneration,
      view,
    } as GenerationRuntime<E, R>;
  });

export const makeGenerationRuntime = (
  options: LoadGenerationOptions,
  runtimeOptions: GenerationRuntimeOptions = {},
): Effect.Effect<
  GenerationRuntime<GenerationLoadError, TrustStore>,
  GenerationLoadError,
  TrustStore
> =>
  makeRuntimeInternal<GenerationLoadError, TrustStore>(
    () => loadGenerationRuntimeInternal(options).pipe(Effect.flatMap(makeRoutable)),
    options.generationDiagnosticSink,
    runtimeOptions,
  );

export const makeGenerationRuntimeWithLoader = <E, R>(
  load: () => Effect.Effect<PluginGeneration, E, R>,
  diagnosticSink: ((d: GenerationSwapDiagnostic) => Effect.Effect<void>) | undefined = undefined,
  runtimeOptions: GenerationRuntimeOptions<E> = {},
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
            const routing = yield* Ref.make<GenerationRoutingState>(initialRoutingState);
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
    return yield* makeRuntimeInternal<E, R>(loadRoutable, diagnosticSink, runtimeOptions);
  });

export const loadGeneration = (
  options: LoadGenerationOptions,
): Effect.Effect<PluginGeneration, GenerationLoadError, TrustStore> =>
  loadGenerationRuntimeInternal(options);
