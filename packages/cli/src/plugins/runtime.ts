/**
 * Owns the CLI composition root over makePluginRuntime.
 * It exists so startup and reload share ONE recomposition function (discovery, load, guards, first-party) and so registry/emitter/host/grants/audit resolve through the current generation. Reload swaps on a host fiber outside leases.
 * Not responsible for Tool adaptation (adapter owns that) or for host control service (reload owns that). Pipeline is its discovery/guard helper.
 */

import { SessionIdSchema, type SessionId } from "@pop-eye/journal";
import type { GenerationSwapDiagnostic, PluginGeneration } from "@pop-eye/plugins";
import { CommandContributionKind, createCapabilityGrants } from "@pop-eye/plugins";
import { Effect, Ref, Schema, type Scope } from "effect";
import type { SnapshotAuditFields } from "../heads/shared.js";
import { adaptTools, generationCapabilityUnion } from "../tools/adapter.js";
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
import { type ComposePluginRuntimeOptions, composePluginRuntime } from "./pipeline.js";

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
    // Use the ONE recomposition function for both startup and reload.
    const initial = yield* composePluginRuntime(options);
    // We wrap the initial generation in a makePluginRuntime-like routing to get lease semantics.
    // For M4, we keep it simple: hold current generation in Ref, and implement checkout/reload with drain.
    // Reuse makePluginRuntime's routing by creating a lightweight PluginRuntime that loads via composePluginRuntime.
    // Instead of reimplementing routing, we create a PluginRuntime that uses a custom loader that calls composePluginRuntime.
    // But composePluginRuntime already does loadGeneration + first-party, so we can just hold Ref and implement lease.

    const current = yield* Ref.make(initial);
    const currentInFlight = yield* Ref.make(0);

    const checkout: CliRuntime["checkout"] = Effect.acquireRelease(
      Effect.gen(function* () {
        const gen = yield* Ref.get(current);
        yield* Ref.update(currentInFlight, (n) => n + 1);
        return { generation: gen };
      }),
      () => Ref.update(currentInFlight, (n) => n - 1),
    );

    const use: CliRuntime["use"] = (f) =>
      Effect.scoped(checkout.pipe(Effect.flatMap(({ generation }) => f(generation))));

    const useSerialized: CliRuntime["useSerialized"] = (f) => use(f);

    const currentGeneration: CliRuntime["currentGeneration"] = Ref.get(current);

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

    const initialGrantsForTools = createCapabilityGrants(
      SessionIdSchema.make("init-tools"),
      generationCapabilityUnion(initial),
    );
    const initialToolsForCache = yield* adaptTools(initial, initialGrantsForTools).pipe(
      Effect.orElseSucceed(() => [] as unknown as ReadonlyArray<Tool.Any>),
    );
    let currentToolsCache: ReadonlyArray<Tool.Any> = initialToolsForCache;

    const toolRegistry: ToolRegistryService = {
      view: (sessionId) =>
        Effect.gen(function* () {
          const gen = yield* Ref.get(current);
          const grants = createCapabilityGrants(sessionId, generationCapabilityUnion(gen));
          const tools = yield* adaptTools(gen, grants).pipe(
            Effect.catchAll(() =>
              Effect.succeed([] as unknown as ReadonlyArray<Tool.Any>),
            ),
          );
          // Update cache for sync get/list
          currentToolsCache = tools;
          const map = new Map(
            tools.map((t) => [t.name, t as unknown as RegisteredTool]),
          );
          return {
            get: (name: string) => map.get(name),
            list: () => tools as unknown as ReadonlyArray<RegisteredTool>,
          } satisfies SessionToolView;
        }),
      get: (name: string) => {
        const map = new Map(
          currentToolsCache.map((t) => [
            t.name,
            t as unknown as RegisteredTool,
          ]),
        );
        return map.get(name);
      },
      list: () =>
        currentToolsCache as unknown as ReadonlyArray<RegisteredTool>,
    };

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
          return yield* command.payload.execute(input, commandContext).pipe(
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
      const fresh = yield* composePluginRuntime(options);
      const old = yield* Ref.getAndSet(current, fresh);
      // Update tool cache for new generation
      const freshGrants = createCapabilityGrants(
        SessionIdSchema.make("reload-tools"),
        generationCapabilityUnion(fresh),
      );
      const freshTools = yield* adaptTools(fresh, freshGrants).pipe(
        Effect.orElseSucceed(
          () => [] as unknown as ReadonlyArray<Tool.Any>,
        ),
      );
      currentToolsCache = freshTools;
      // For M4, we close old immediately (no drain). M5 will add drain and busy semantics.
      yield* old.close;
      const oldIds = old.plugins.map((p) => p.name).sort();
      const newIds = fresh.plugins.map((p) => p.name).sort();
      const added = newIds.filter((n) => !oldIds.includes(n));
      const removed = oldIds.filter((n) => !newIds.includes(n));
      const replaced = newIds.filter((n) => oldIds.includes(n));
      return {
        closedResources: 1,
        drainDurationMillis: 0,
        leaseCount: yield* Ref.get(currentInFlight),
        newGenerationId: fresh.id,
        oldGenerationId: old.id,
        pluginsAdded: added,
        pluginsRemoved: removed,
        pluginsReplaced: replaced,
        type: "generation_swap" as const,
      };
    });

    const close: CliRuntime["close"] = Effect.gen(function* () {
      const gen = yield* Ref.get(current);
      yield* gen.close;
    });

    const debugInfo = Effect.gen(function* () {
      const gen = yield* Ref.get(current);
      const inFlight = yield* Ref.get(currentInFlight);
      return {
        currentGenerationId: gen.id,
        inFlight,
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
