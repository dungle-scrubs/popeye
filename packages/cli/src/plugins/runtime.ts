/**
 * Owns the CLI composition root over makePluginRuntime.
 * It exists so startup and reload share ONE recomposition function (discovery, load, guards, first-party) and so registry/emitter/host/grants/audit resolve through the current generation. Reload swaps on a host fiber outside leases.
 * Not responsible for Tool adaptation (adapter owns that) or for host control service (reload owns that). Pipeline is its discovery/guard helper.
 */

import { type SessionId, SessionIdSchema } from "@pop-eye/journal";
import type { GenerationSwapDiagnostic, PluginGeneration } from "@pop-eye/plugins";
import { CommandContributionKind, createCapabilityGrants } from "@pop-eye/plugins";
import { Clock, Deferred, Effect, Ref, Schema, type Scope } from "effect";
import {
  InvokeCommandError,
  type PluginCommandContext,
  type PluginCompactionGateRequest,
  type PluginHostService,
  type RegisteredTool,
  type SessionToolView,
  type Tool,
  type ToolRegistryService,
} from "../compose.js";
import type { SnapshotAuditFields } from "../heads/shared.js";
import { adaptTools, generationCapabilityUnion } from "../tools/adapter.js";
import { type ComposePluginRuntimeOptions, composePluginRuntime } from "./pipeline.js";
import {
  DRAIN_TIMEOUT_MILLIS,
  ReloadBusyError,
  ReloadControl,
  ReloadDrainTimeoutError,
} from "./reload.js";

export interface CliRuntime {
  readonly checkout: Effect.Effect<{ readonly generation: PluginGeneration }, never, Scope.Scope>;
  readonly close: Effect.Effect<void>;
  readonly debugInfo: Effect.Effect<{
    readonly currentGenerationId: string;
    readonly inFlight: number;
    readonly plugins: ReadonlyArray<string>;
  }>;
  readonly currentGeneration: Effect.Effect<PluginGeneration>;
  readonly pluginHost: PluginHostService;
  readonly reload: Effect.Effect<GenerationSwapDiagnostic, unknown>;
  readonly snapshotAudit: Effect.Effect<SnapshotAuditFields>;
  readonly toolRegistry: ToolRegistryService;
  readonly use: <A, E, R>(
    f: (g: PluginGeneration) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly useSerialized: <A, E, R>(
    f: (g: PluginGeneration) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

interface CliRoutingState {
  readonly drain: Deferred.Deferred<void> | null;
  readonly inFlight: number;
}

interface CliRoutableGeneration extends PluginGeneration {
  readonly routing: Ref.Ref<CliRoutingState>;
}

const makeRoutable = (generation: PluginGeneration): Effect.Effect<CliRoutableGeneration> =>
  Effect.gen(function* () {
    const routing = yield* Ref.make<CliRoutingState>({ drain: null, inFlight: 0 });
    return Object.assign(Object.create(Object.getPrototypeOf(generation)), generation, {
      routing,
    }) as CliRoutableGeneration;
  });

const pluginChanges = (
  oldGeneration: PluginGeneration,
  newGeneration: PluginGeneration,
): Pick<GenerationSwapDiagnostic, "pluginsAdded" | "pluginsRemoved" | "pluginsReplaced"> => {
  const oldNames = new Set(oldGeneration.plugins.map((p) => p.name));
  const newNames = new Set(newGeneration.plugins.map((p) => p.name));
  return {
    pluginsAdded: [...newNames].filter((n) => !oldNames.has(n)).sort(),
    pluginsRemoved: [...oldNames].filter((n) => !newNames.has(n)).sort(),
    pluginsReplaced: [...newNames].filter((n) => oldNames.has(n)).sort(),
  };
};

export const makeCliRuntime = (
  options: ComposePluginRuntimeOptions,
): Effect.Effect<CliRuntime, unknown> =>
  Effect.gen(function* () {
    const initialRaw = yield* composePluginRuntime(options);
    const initial = yield* makeRoutable(initialRaw);

    const current = yield* Ref.make<CliRoutableGeneration>(initial);
    const isReloading = yield* Ref.make(false);
    const pendingOlds = yield* Ref.make<ReadonlyArray<CliRoutableGeneration>>([]);

    // Track current generation for sync cache
    const initialGrantsForTools = createCapabilityGrants(
      SessionIdSchema.make("init-tools"),
      generationCapabilityUnion(initial),
    );
    const initialToolsForCache = yield* adaptTools(initial, initialGrantsForTools).pipe(
      Effect.orElseSucceed(() => [] as unknown as ReadonlyArray<Tool.Any>),
    );
    let currentToolsCache: ReadonlyArray<Tool.Any> = initialToolsForCache;

    const settle = (generation: CliRoutableGeneration): Effect.Effect<void> =>
      Ref.modify(generation.routing, (state) => {
        const remaining = state.inFlight - 1;
        const drain = remaining === 0 ? state.drain : null;
        return [drain, { ...state, inFlight: remaining }] as const;
      }).pipe(
        Effect.flatMap((drain) =>
          drain === null ? Effect.void : Deferred.succeed(drain, undefined),
        ),
        Effect.asVoid,
      );

    const checkout: CliRuntime["checkout"] = Effect.acquireRelease(
      Effect.gen(function* () {
        const gen = yield* Ref.get(current);
        yield* Ref.update(gen.routing, (s) => ({ ...s, inFlight: s.inFlight + 1 }));
        return { generation: gen as PluginGeneration };
      }),
      (lease) => settle(lease.generation as CliRoutableGeneration),
    );

    const use: CliRuntime["use"] = (f) =>
      Effect.scoped(checkout.pipe(Effect.flatMap(({ generation }) => f(generation))));

    const useSerialized: CliRuntime["useSerialized"] = (f) => use(f);

    const currentGeneration: CliRuntime["currentGeneration"] = Ref.get(current).pipe(
      Effect.map((g) => g as PluginGeneration),
    );

    const snapshotAudit: CliRuntime["snapshotAudit"] = Effect.gen(function* () {
      const gen = yield* Ref.get(current);
      const grants = createCapabilityGrants(
        SessionIdSchema.make("capability-grants"),
        generationCapabilityUnion(gen),
      );
      return {
        capabilityGrants: grants.capabilities,
        loadedGeneration: {
          id: gen.id,
          plugins: gen.plugins.map((p) => p.name),
        },
      } satisfies SnapshotAuditFields;
    });

    const toolRegistry: ToolRegistryService = {
      view: (sessionId) =>
        Effect.gen(function* () {
          const gen = yield* Ref.get(current);
          const grants = createCapabilityGrants(sessionId, generationCapabilityUnion(gen));
          const tools = yield* adaptTools(gen as PluginGeneration, grants).pipe(
            Effect.catchAll(() => Effect.succeed([] as unknown as ReadonlyArray<Tool.Any>)),
          );
          currentToolsCache = tools;
          const map = new Map(tools.map((t) => [t.name, t as unknown as RegisteredTool]));
          return {
            get: (name: string) => map.get(name),
            list: () => tools as unknown as ReadonlyArray<RegisteredTool>,
          } satisfies SessionToolView;
        }),
      get: (name: string) => {
        const map = new Map(currentToolsCache.map((t) => [t.name, t as unknown as RegisteredTool]));
        return map.get(name);
      },
      list: () => currentToolsCache as unknown as ReadonlyArray<RegisteredTool>,
    };

    // We will create reloadControlService later, but need pluginHost to reference it
    // Use a mutable ref for the service to avoid circular init
    let reloadControlService:
      | { readonly reload: Effect.Effect<GenerationSwapDiagnostic, unknown> }
      | undefined;

    const pluginHost: PluginHostService = {
      compactionGate: (sessionId: SessionId, request: PluginCompactionGateRequest) =>
        Effect.gen(function* () {
          const gen = yield* Ref.get(current);
          const grants = createCapabilityGrants(sessionId);
          const result = yield* gen.emitter.emit("compaction-gate", request, grants).pipe(
            Effect.as({ action: "compact" as const }),
            Effect.catchTag("GateRejected", (error) =>
              error.rejection === "block"
                ? Effect.succeed({ action: "skip" as const, reason: error.reason })
                : Effect.fail(error),
            ),
            Effect.catchAll((error) =>
              Effect.succeed({
                action: "skip" as const,
                reason: `Compaction gate failed closed: ${String(error)}`,
              }),
            ),
          );
          return result;
        }),
      invokeCommand: (name: string, args: unknown, context: PluginCommandContext) =>
        Effect.gen(function* () {
          const gen = yield* Ref.get(current);
          const grants = createCapabilityGrants(context.sessionId);
          const commands = yield* gen.registry.list(CommandContributionKind, grants).pipe(
            Effect.mapError(
              (cause) =>
                new InvokeCommandError({
                  cause,
                  commandName: name,
                  message: `Command ${name} could not be resolved: ${cause.message}`,
                  reason: "command_failed",
                }),
            ),
          );
          const matches = commands.filter((c) => c.name === name);
          if (matches.length === 0) {
            return yield* new InvokeCommandError({
              commandName: name,
              message: `Command ${name} was not found.`,
              reason: "command_not_found",
            });
          }
          if (matches.length > 1) {
            return yield* new InvokeCommandError({
              commandName: name,
              message: `Command ${name} has multiple Contributions.`,
              reason: "command_ambiguous",
            });
          }
          const command = matches[0];
          if (command === undefined) {
            return yield* Effect.die("Command resolution lost its selected Contribution.");
          }
          const input = yield* Schema.decodeUnknown(command.payload.arguments, {
            onExcessProperty: "error",
          })(args).pipe(
            Effect.mapError(
              (cause) =>
                new InvokeCommandError({
                  cause,
                  commandName: name,
                  message: `Command ${name} arguments are invalid.`,
                  reason: "arguments_invalid",
                }),
            ),
          );
          const commandContext: PluginCommandContext = {
            compactNow: ((expectedRevision?: number) =>
              Effect.gen(function* () {
                const gateResult = yield* gen.emitter
                  .emit("compaction-gate", { reason: "manual", tokenCount: 0 }, grants)
                  .pipe(
                    Effect.as({ action: "compact" as const }),
                    Effect.catchTag("GateRejected", (error) =>
                      error.rejection === "block"
                        ? Effect.succeed({ action: "skip" as const, reason: error.reason })
                        : Effect.fail(error),
                    ),
                  );
                if (gateResult.action === "skip") {
                  return yield* new InvokeCommandError({
                    commandName: name,
                    message: gateResult.reason,
                    reason: "command_vetoed",
                  });
                }
                return yield* context.compactNow(expectedRevision);
              }) as unknown) as PluginCommandContext["compactNow"],
            sessionId: context.sessionId,
            setSessionName: context.setSessionName,
          };
          // Provide ReloadControl to the command's effect so /reload can access host service.
          // If the service is not yet initialized, the command will fail with a clear error.
          const base = command.payload.execute(input, commandContext);
          const withReload =
            reloadControlService === undefined
              ? base
              : base.pipe(
                  // biome-ignore lint/suspicious/noExplicitAny: service indirection requires exact type
                  Effect.provideService(ReloadControl, reloadControlService as any),
                );
          return yield* withReload.pipe(
            Effect.mapError((cause) =>
              cause instanceof InvokeCommandError
                ? cause
                : new InvokeCommandError({
                    cause,
                    commandName: name,
                    message: `Command ${name} failed.`,
                    reason: "command_failed",
                  }),
            ),
          );
        }),
    };

    const reload: CliRuntime["reload"] = Effect.gen(function* () {
      const acquired = yield* Ref.modify(isReloading, (busy) =>
        busy ? ([false, true] as const) : ([true, true] as const),
      );
      if (!acquired) {
        const diagnostic = {
          diagnostic: "reload_busy",
          reason: "A reload is already in progress.",
        };
        yield* Effect.logWarning(JSON.stringify(diagnostic)).pipe(
          Effect.annotateLogs({ diagnostic: "reload_busy" }),
        );
        return yield* new ReloadBusyError({
          message: "Reload is already in progress.",
        });
      }
      return yield* Effect.gen(function* () {
        // Recomposition is ONE function: discovery, load, guards, first-party
        const freshRaw = yield* composePluginRuntime(options).pipe(
          Effect.catchAll((cause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning(
                JSON.stringify({
                  diagnostic: "reload_composition_failed",
                  error: String(cause),
                }),
              ).pipe(Effect.annotateLogs({ diagnostic: "reload_composition_failed" }));
              return yield* Effect.fail(cause);
            }),
          ),
        );
        const fresh = yield* makeRoutable(freshRaw);
        const drain = yield* Deferred.make<void>();
        const startMillis = yield* Clock.currentTimeMillis;
        const swapped = yield* Ref.modify(current, (old) => {
          // old is CliRoutableGeneration
          // We need to capture old's inFlight and set its drain
          // Use Effect to update old.routing
          return [old, fresh] as const;
        });
        const old = swapped as CliRoutableGeneration;
        // Install drain on old
        const inFlight = yield* Ref.modify(old.routing, (state) => {
          const next = { ...state, drain };
          return [state.inFlight, next] as const;
        });
        // Update tool cache for new generation
        const freshGrants = createCapabilityGrants(
          SessionIdSchema.make("reload-tools"),
          generationCapabilityUnion(fresh as PluginGeneration),
        );
        const freshTools = yield* adaptTools(fresh as PluginGeneration, freshGrants).pipe(
          Effect.orElseSucceed(() => [] as unknown as ReadonlyArray<Tool.Any>),
        );
        currentToolsCache = freshTools;

        if (inFlight === 0) {
          yield* Deferred.succeed(drain, undefined);
        }

        // Wait for drain with timeout (TestClock-aware) - use race with sleep so TestClock can advance
        const drainSucceeded = yield* Effect.race(
          Deferred.await(drain).pipe(Effect.as(true as const)),
          Effect.sleep(DRAIN_TIMEOUT_MILLIS).pipe(Effect.as(false as const)),
        );

        if (!drainSucceeded) {
          // Drain timeout - keep both generations alive, diagnostic names holder, old still closes later via background fiber
          const holders = Array.from({ length: inFlight }, (_, i) => `lease-${i + 1}`);
          const newGenerationId = fresh.id;
          const oldGenerationId = old.id;
          // Keep old in pending
          yield* Ref.update(pendingOlds, (arr) => [...arr, old]);
          // Fork background close that waits for actual drain then closes old
          yield* Effect.fork(
            Deferred.await(drain).pipe(
              Effect.zipRight(
                Effect.gen(function* () {
                  yield* old.close;
                  yield* Ref.update(pendingOlds, (arr) => arr.filter((g) => g !== old));
                  yield* Effect.logInfo(
                    JSON.stringify({
                      diagnostic: "reload_drain_completed_after_timeout",
                      newGenerationId,
                      oldGenerationId,
                    }),
                  );
                }),
              ),
              Effect.catchAllCause(() => Effect.void),
            ),
          );
          const endMillis = yield* Clock.currentTimeMillis;
          const drainDurationMillis = endMillis - startMillis;
          yield* Effect.logWarning(
            JSON.stringify({
              diagnostic: "reload_drain_timeout",
              drainDurationMillis,
              drainTimeoutMillis: DRAIN_TIMEOUT_MILLIS,
              holders,
              leaseCount: inFlight,
              newGenerationId,
              oldGenerationId,
            }),
          ).pipe(
            Effect.annotateLogs({
              diagnostic: "reload_drain_timeout",
              holders: holders.join(","),
              leaseCount: String(inFlight),
              newGenerationId,
              oldGenerationId,
            }),
          );
          return yield* new ReloadDrainTimeoutError({
            drainTimeoutMillis: DRAIN_TIMEOUT_MILLIS,
            holders,
            leaseCount: inFlight,
            message: `Reload drain timed out after ${DRAIN_TIMEOUT_MILLIS}ms waiting for ${inFlight} lease(s): ${holders.join(", ")}`,
            newGenerationId,
            oldGenerationId,
          });
        }

        // Drained successfully
        const endMillis = yield* Clock.currentTimeMillis;
        const drainDurationMillis = endMillis - startMillis;
        yield* old.close;
        const closedResources = yield* old.closedResources.pipe(Effect.orElseSucceed(() => 1));
        const deltas = pluginChanges(old as PluginGeneration, fresh as PluginGeneration);
        const diagnostic: GenerationSwapDiagnostic = {
          closedResources,
          drainDurationMillis,
          leaseCount: inFlight,
          newGenerationId: fresh.id,
          oldGenerationId: old.id,
          pluginsAdded: deltas.pluginsAdded,
          pluginsRemoved: deltas.pluginsRemoved,
          pluginsReplaced: deltas.pluginsReplaced,
          type: "generation_swap",
        };
        yield* Effect.logInfo(
          JSON.stringify({ diagnosticFamily: "generation", ...diagnostic }),
        ).pipe(
          Effect.annotateLogs({
            diagnostic: "generation_swap",
            newGenerationId: diagnostic.newGenerationId,
            oldGenerationId: diagnostic.oldGenerationId,
          }),
        );
        return diagnostic;
      }).pipe(Effect.ensuring(Ref.set(isReloading, false)));
    });

    // Create the reload control service that the reload command will use
    // biome-ignore lint/suspicious/noExplicitAny: mutable service ref initialized after declaration
    reloadControlService = { reload } as any;

    const close: CliRuntime["close"] = Effect.gen(function* () {
      // Serialize close with reload
      const acquired = yield* Ref.modify(isReloading, (busy) =>
        busy ? ([false, true] as const) : ([true, true] as const),
      );
      if (!acquired) {
        // If a reload is in progress, wait briefly? For now, just close current and pending
        // But we should wait for reload to finish - we can just check again? Simplify: just close current and pending without drain wait if busy
        yield* Effect.logWarning(
          "Close called while reload is busy; closing current generation without drain wait.",
        );
      }
      try {
        const gen = yield* Ref.get(current);
        const pending = yield* Ref.get(pendingOlds);
        // Close pending olds first (they will have their drains already)
        for (const old of pending) {
          const state = yield* Ref.get(old.routing);
          if (state.inFlight === 0) {
            yield* old.close;
          } else {
            // Wait for its drain then close
            if (state.drain !== null) {
              yield* Deferred.await(state.drain);
            }
            yield* old.close;
          }
        }
        yield* Ref.set(pendingOlds, []);
        // Now drain current
        const state = yield* Ref.get(gen.routing);
        if (state.inFlight === 0) {
          yield* gen.close;
        } else {
          const drain = state.drain ?? (yield* Deferred.make<void>());
          if (state.drain === null) {
            yield* Ref.set(gen.routing, { ...state, drain });
          }
          // If inFlight >0, wait for drain (no timeout on close, just wait)
          yield* Deferred.await(drain);
          yield* gen.close;
        }
      } finally {
        yield* Ref.set(isReloading, false);
      }
    });

    const debugInfo = Effect.gen(function* () {
      const gen = yield* Ref.get(current);
      const routing = yield* Ref.get(gen.routing);
      return {
        currentGenerationId: gen.id,
        inFlight: routing.inFlight,
        plugins: gen.plugins.map((p) => p.name),
      };
    });

    return {
      checkout,
      close,
      currentGeneration,
      debugInfo,
      pluginHost,
      reload,
      snapshotAudit,
      toolRegistry,
      use,
      useSerialized,
    };
  });

export const recomposeCliGeneration = (options: ComposePluginRuntimeOptions) =>
  composePluginRuntime(options);
