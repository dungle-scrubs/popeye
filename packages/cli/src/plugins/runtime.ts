/**
 * DiscoveryAdapter over GenerationRuntime (D-003).
 * Owns the CLI composition root as pure adapter: discovery config via pipeline, Tool adaptation via adapter, host wiring via compose.
 * It exists so startup and reload share ONE recomposition function and GenerationRuntime owns the ONE Ref<{inFlight,drain}> and ONE isReloading flag; no pendingOlds duplication.
 * Tool views vary per Session: the registry applies the process filter and the Session's own filters from SessionToolGrants (RFC-04 §5).
 * Tool execution resolves through the process-wide Tool surface below, which reads the Tools adapted for the
 * published Generation. Each call leases the Generation that provided its Tool, so a reload waits
 * (up to its drain timeout) for running calls; a Turn holds no lease (#89). A reload adapts the
 * fresh Generation's Tools before it publishes the Generation, so a reader that sees the new
 * Generation also resolves its Tools (#93).
 * Not responsible for generation lifetime (GenerationRuntime owns that), Tool adaptation (adapter owns that) or Turn orchestration.
 */

import { type SessionId, SessionIdSchema } from "@dungle-scrubs/popeye-journal";
import type { GenerationSwapDiagnostic, PluginGeneration } from "@dungle-scrubs/popeye-plugins";
import {
  ContributionRegistryError,
  createCapabilityGrants,
  GenerationBusyError,
  GenerationDrainTimeoutError,
  makeGenerationRuntimeWithLoader,
} from "@dungle-scrubs/popeye-plugins";
import { Effect, Option, type Scope } from "effect";
import {
  InvokeCommandError,
  makePluginHostService,
  type PluginHostService,
  type RegisteredTool,
  type SessionToolView,
  type Tool,
  type ToolRegistryService,
} from "../compose.js";
import type { SnapshotAuditFields } from "../heads/head-wire.js";
import { adaptTools, generationCapabilityUnion, type ToolLease } from "../tools/adapter.js";
import type { ToolGrantFilter } from "../tools/grants.js";
import {
  filterGrantedTools,
  filterSessionGrantedTools,
  isToolGrantedToSession,
} from "../tools/grants.js";
import { makeSessionToolGrants, type SessionToolGrantsService } from "../tools/session-grants.js";
import { forgetToolSessionMemoryForGeneration } from "../tools/tool-session-memory.js";
import { type ComposePluginRuntimeOptions, composePluginRuntime } from "./pipeline.js";
import { DRAIN_TIMEOUT_MILLIS, ReloadBusyError, ReloadDrainTimeoutError } from "./reload.js";

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
  readonly processToolView: Effect.Effect<SessionToolView>;
  readonly reload: Effect.Effect<GenerationSwapDiagnostic, unknown>;
  readonly sessionToolGrants: SessionToolGrantsService;
  readonly snapshotAudit: Effect.Effect<SnapshotAuditFields>;
  readonly toolRegistry: ToolRegistryService;
  readonly use: <A, E, R>(
    f: (g: PluginGeneration) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly useSerialized: <A, E, R>(
    f: (g: PluginGeneration) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export interface CliRuntimeOptions {
  /** How long a reload waits for running Tool calls before it fails with ReloadDrainTimeoutError. Default DRAIN_TIMEOUT_MILLIS. */
  readonly drainTimeoutMillis?: number;
}

export const makeCliRuntime = (
  options: ComposePluginRuntimeOptions,
  runtimeOptions: CliRuntimeOptions = {},
): Effect.Effect<CliRuntime, unknown> =>
  Effect.gen(function* () {
    const grants: ToolGrantFilter | undefined = options.toolGrants;
    const sessionToolGrants = yield* makeSessionToolGrants;
    // The process Tool surface, keyed by Generation id. Written by prepareSwap before a Generation
    // is published and at startup; an entry is removed when its Generation closes, except the
    // current one (#93). Wrappers carry a pseudo grants id; the gate restamps the caller's id per
    // call.
    const toolsByGeneration = new Map<string, ReadonlyArray<Tool.Any>>();
    const toolLease =
      (generation: PluginGeneration): ToolLease =>
      (holder) =>
        generationRuntime.checkoutGeneration(generation.id, holder).pipe(Effect.map(Option.isSome));
    const adaptForCache = (generation: PluginGeneration, pseudoId: string) =>
      adaptTools(
        generation,
        createCapabilityGrants(
          SessionIdSchema.make(pseudoId),
          generationCapabilityUnion(generation),
        ),
        {
          lease: toolLease(generation),
        },
      ).pipe(
        Effect.map((tools) => (grants === undefined ? tools : filterGrantedTools(tools, grants))),
      );
    const prepareSwap = (fresh: PluginGeneration) =>
      adaptForCache(fresh, "reload-tools").pipe(
        Effect.mapError(
          (cause) =>
            new ContributionRegistryError({
              ...cause,
              message: `Tool adaptation failed for generation ${fresh.id}: ${cause.message}`,
            }),
        ),
        Effect.flatMap((tools) =>
          Effect.sync(() => {
            toolsByGeneration.set(fresh.id, tools);
          }),
        ),
      );
    const onGenerationClosed = (generation: PluginGeneration) =>
      Effect.sync(() => {
        if (generation.id !== generationRuntime.unsafeCurrentGeneration().id) {
          toolsByGeneration.delete(generation.id);
        }
      }).pipe(Effect.zipRight(forgetToolSessionMemoryForGeneration(generation.id)));
    const generationRuntime = yield* makeGenerationRuntimeWithLoader(
      () => composePluginRuntime(options),
      undefined,
      {
        drainTimeoutMillis: runtimeOptions.drainTimeoutMillis ?? DRAIN_TIMEOUT_MILLIS,
        onGenerationClosed,
        prepareSwap,
      },
    );

    // checkout/drain/busy/view via one Ref<{inFlight,drain}> in GenerationRuntime; isReloading single flag; no pendingOlds
    const checkout: CliRuntime["checkout"] =
      generationRuntime.checkout as unknown as CliRuntime["checkout"];
    const close: CliRuntime["close"] = generationRuntime.close;
    const debugInfo: CliRuntime["debugInfo"] = generationRuntime.debugInfo;
    const currentGeneration: CliRuntime["currentGeneration"] = generationRuntime.currentGeneration;
    const use: CliRuntime["use"] = generationRuntime.use as CliRuntime["use"];
    const useSerialized: CliRuntime["useSerialized"] =
      generationRuntime.useSerialized as CliRuntime["useSerialized"];

    const initial = yield* generationRuntime.currentGeneration;
    toolsByGeneration.set(
      initial.id,
      yield* adaptForCache(initial, "init-tools").pipe(Effect.orElseSucceed(() => [])),
    );
    const currentTools = (): ReadonlyArray<Tool.Any> =>
      toolsByGeneration.get(generationRuntime.unsafeCurrentGeneration().id) ?? [];

    const snapshotAudit: CliRuntime["snapshotAudit"] = Effect.gen(function* () {
      const gen = yield* generationRuntime.currentGeneration;
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

    const buildView = (
      sessionId: SessionId,
      sessionFilters: ReadonlyArray<ToolGrantFilter>,
    ): Effect.Effect<SessionToolView> =>
      Effect.gen(function* () {
        const gen = yield* generationRuntime.view(sessionId as unknown as string);
        const grantsForAdapt = createCapabilityGrants(sessionId, generationCapabilityUnion(gen));
        const tools = yield* adaptTools(gen as PluginGeneration, grantsForAdapt, {
          lease: toolLease(gen),
        }).pipe(Effect.catchAll(() => Effect.succeed([] as unknown as ReadonlyArray<Tool.Any>)));
        // HCN grant filter, then the Session's own filters (RFC-04 §5): both run after
        // plugin trust, before model visibility. Capabilities stay as the author declared them.
        const granted = filterSessionGrantedTools(tools, grants, sessionFilters);
        const map = new Map(granted.map((t) => [t.name, t as unknown as RegisteredTool]));
        return {
          admits: (name: string) => isToolGrantedToSession(name, grants, sessionFilters),
          get: (name: string) => map.get(name),
          list: () => granted as unknown as ReadonlyArray<RegisteredTool>,
        } satisfies SessionToolView;
      });

    const processToolView = buildView(SessionIdSchema.make("process-tool-view"), []);
    const toolRegistry: ToolRegistryService = {
      view: (sessionId) =>
        sessionToolGrants
          .filtersFor(sessionId)
          .pipe(Effect.flatMap((sessionFilters) => buildView(sessionId, sessionFilters))),
      get: (name: string) =>
        currentTools().find((tool) => tool.name === name) as RegisteredTool | undefined,
      list: () => currentTools() as unknown as ReadonlyArray<RegisteredTool>,
    };

    const reload: CliRuntime["reload"] = generationRuntime.reload.pipe(
      Effect.mapError((cause) => {
        if (cause instanceof ContributionRegistryError) {
          return new InvokeCommandError({
            cause,
            commandName: "reload",
            message: cause.message,
            reason: "command_failed",
          });
        }
        if (cause instanceof GenerationBusyError) {
          return new ReloadBusyError({ message: cause.message });
        }
        if (cause instanceof GenerationDrainTimeoutError) {
          return new ReloadDrainTimeoutError({
            drainTimeoutMillis: cause.drainTimeoutMillis,
            holders: cause.holders,
            leaseCount: cause.leaseCount,
            message: cause.message,
            newGenerationId: cause.newGenerationId,
            oldGenerationId: cause.oldGenerationId,
          });
        }
        return cause;
      }),
    );
    const pluginHost = makePluginHostService({
      currentGeneration: generationRuntime.currentGeneration,
      reloadControl: { reload },
    });

    return {
      checkout,
      close,
      currentGeneration,
      debugInfo,
      pluginHost,
      processToolView,
      reload,
      sessionToolGrants,
      snapshotAudit,
      toolRegistry,
      use,
      useSerialized,
    };
  });

export const recomposeCliGeneration = (options: ComposePluginRuntimeOptions) =>
  composePluginRuntime(options);
