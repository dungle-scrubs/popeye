/**
 * DiscoveryAdapter over GenerationRuntime (D-003).
 * Owns the CLI composition root as pure adapter: discovery config via pipeline, Tool adaptation via adapter, host wiring via compose.
 * It exists so startup and reload share ONE recomposition function and GenerationRuntime owns the ONE Ref<{inFlight,drain}> and ONE isReloading flag; no pendingOlds duplication.
 * Not responsible for generation lifetime (GenerationRuntime owns that), Tool adaptation (adapter owns that) or Turn orchestration.
 */

import { type SessionId, SessionIdSchema } from "@popeye/journal";
import type { GenerationSwapDiagnostic, PluginGeneration } from "@popeye/plugins";
import {
  CommandContributionKind,
  createCapabilityGrants,
  GenerationBusyError,
  makeGenerationRuntimeWithLoader,
} from "@popeye/plugins";
import { Effect, Schema, type Scope } from "effect";
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
import type { SnapshotAuditFields } from "../heads/head-wire.js";
import { adaptTools, generationCapabilityUnion } from "../tools/adapter.js";
import type { ToolGrantFilter } from "../tools/grants.js";
import { filterGrantedTools } from "../tools/grants.js";
import { clearToolSessionMemory } from "../tools/tool-session-memory.js";
import { type ComposePluginRuntimeOptions, composePluginRuntime } from "./pipeline.js";
import { ReloadBusyError, ReloadControl } from "./reload.js";

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

export const makeCliRuntime = (
  options: ComposePluginRuntimeOptions,
): Effect.Effect<CliRuntime, unknown> =>
  Effect.gen(function* () {
    const grants: ToolGrantFilter | undefined = options.toolGrants;
    const generationRuntime = yield* makeGenerationRuntimeWithLoader(() =>
      composePluginRuntime(options),
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

    // Sync cache for ToolRegistry.get/list (sync access)
    const initialGen = yield* generationRuntime.currentGeneration;
    const initialGrantsForTools = createCapabilityGrants(
      SessionIdSchema.make("init-tools"),
      generationCapabilityUnion(initialGen),
    );
    const initialToolsForCache = yield* adaptTools(initialGen, initialGrantsForTools).pipe(
      Effect.orElseSucceed(() => [] as unknown as ReadonlyArray<Tool.Any>),
    );
    let currentToolsCache: ReadonlyArray<Tool.Any> =
      grants === undefined
        ? initialToolsForCache
        : filterGrantedTools(initialToolsForCache, grants);

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

    const toolRegistry: ToolRegistryService = {
      view: (sessionId) =>
        Effect.gen(function* () {
          const gen = yield* generationRuntime.view(sessionId as unknown as string);
          const grantsForAdapt = createCapabilityGrants(sessionId, generationCapabilityUnion(gen));
          const tools = yield* adaptTools(gen as PluginGeneration, grantsForAdapt).pipe(
            Effect.catchAll(() => Effect.succeed([] as unknown as ReadonlyArray<Tool.Any>)),
          );
          // HCN grant filter runs after plugin trust, before model
          // visibility. Capabilities stay as the author declared them.
          const granted = grants === undefined ? tools : filterGrantedTools(tools, grants);
          currentToolsCache = granted;
          const map = new Map(granted.map((t) => [t.name, t as unknown as RegisteredTool]));
          return {
            get: (name: string) => map.get(name),
            list: () => granted as unknown as ReadonlyArray<RegisteredTool>,
          } satisfies SessionToolView;
        }),
      get: (name: string) => {
        const map = new Map(currentToolsCache.map((t) => [t.name, t as unknown as RegisteredTool]));
        return map.get(name);
      },
      list: () => currentToolsCache as unknown as ReadonlyArray<RegisteredTool>,
    };

    let reloadControlService:
      | { readonly reload: Effect.Effect<GenerationSwapDiagnostic, unknown> }
      | undefined;

    const pluginHost: PluginHostService = {
      compactionGate: (sessionId: SessionId, request: PluginCompactionGateRequest) =>
        Effect.gen(function* () {
          const gen = yield* generationRuntime.currentGeneration;
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
          const gen = yield* generationRuntime.currentGeneration;
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
      const diagnostic = yield* generationRuntime.reload.pipe(
        Effect.mapError((cause) => {
          if (cause instanceof GenerationBusyError) {
            return new ReloadBusyError({ message: cause.message });
          }
          return cause;
        }),
      );
      // GenerationSwap: clear Tool session memory (generation-scoped forget, fail-closed)
      yield* clearToolSessionMemory;
      // Refresh sync cache after successful swap
      const fresh = yield* generationRuntime.currentGeneration;
      const freshGrants = createCapabilityGrants(
        SessionIdSchema.make("reload-tools"),
        generationCapabilityUnion(fresh as PluginGeneration),
      );
      const freshTools = yield* adaptTools(fresh as PluginGeneration, freshGrants).pipe(
        Effect.orElseSucceed(() => [] as unknown as ReadonlyArray<Tool.Any>),
      );
      currentToolsCache =
        grants === undefined ? freshTools : filterGrantedTools(freshTools, grants);
      return diagnostic;
    });

    // biome-ignore lint/suspicious/noExplicitAny: mutable service ref initialized after declaration
    reloadControlService = { reload } as any;

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
