/**
 * Owns the sole in-process composition boundary between the CLI and kernel.
 * It exists so wire heads remain protocol-only while local hosting has one explicit exception.
 */
import {
  Driver,
  DriverDefault,
  type DriverDefaultOptions,
  type DriverSnapshot,
  defineTool,
  InvokeCommandError,
  kernelPackage,
  type PluginCommandContext,
  type PluginCompactionGateRequest,
  type PluginCompactionGateResult,
  PluginHost,
  type PluginHostService,
  Provider,
  type ProviderService,
  type Tool,
  ToolRegistryLive,
  type TurnResult,
} from "@peye/kernel";
import {
  type CapabilityGrants,
  CommandContributionKind,
  type CommandExecutionContext,
  type Contribution,
  ContributionRegistry,
  ContributionRegistryLive,
  createCapabilityGrants,
  HookEmitter,
  HookEmitterLive,
  type HookEmitterService,
  type PluginManifest,
} from "@peye/plugins";
import { Context, Effect, Layer, Schema } from "effect";

import { compactPlugin } from "./features/compact.js";
import { sessionNamePlugin } from "./features/session-name.js";

export type { DriverSnapshot, ProviderService, Tool, TurnResult };
export { Driver, defineTool, Provider, ToolRegistryLive };

export const inProcessKernelPackage = kernelPackage;

interface StaticPlugin {
  readonly contributions: ReadonlyArray<Contribution>;
  readonly manifest: PluginManifest;
}

export interface FirstPartyPluginHostOptions {
  readonly plugins?: ReadonlyArray<StaticPlugin>;
}

const invokeCommandError = (
  commandName: string,
  reason: InvokeCommandError["reason"],
  message: string,
  cause?: unknown,
): InvokeCommandError =>
  new InvokeCommandError({
    ...(cause === undefined ? {} : { cause }),
    commandName,
    message,
    reason,
  });

const emitCompactionGate = (
  emitter: HookEmitterService,
  grants: CapabilityGrants,
  request: PluginCompactionGateRequest,
): Effect.Effect<PluginCompactionGateResult, unknown> =>
  emitter.emit("compaction-gate", request, grants).pipe(
    Effect.as<PluginCompactionGateResult>({ action: "compact" }),
    Effect.catchTag("GateRejected", (error) =>
      error.rejection === "block"
        ? Effect.succeed<PluginCompactionGateResult>({
            action: "skip",
            reason: error.reason,
          })
        : Effect.fail(error),
    ),
  );

const commandExecutionContext = (
  commandName: string,
  context: PluginCommandContext,
  emitter: HookEmitterService,
  grants: CapabilityGrants,
): CommandExecutionContext => ({
  compactNow: (expectedRevision) =>
    Effect.gen(function* () {
      const decision = yield* emitCompactionGate(emitter, grants, {
        reason: "manual",
        tokenCount: 0,
      });
      if (decision.action === "skip") {
        return yield* invokeCommandError(commandName, "command_vetoed", decision.reason);
      }
      return yield* context.compactNow(expectedRevision);
    }),
  sessionId: context.sessionId,
  setSessionName: context.setSessionName,
});

export const FirstPartyPluginHostLive = (
  options: FirstPartyPluginHostOptions = {},
): Layer.Layer<PluginHost> =>
  Layer.scoped(
    PluginHost,
    Effect.gen(function* () {
      const registryLayer = ContributionRegistryLive();
      const services = yield* Layer.build(
        Layer.merge(registryLayer, HookEmitterLive().pipe(Layer.provide(registryLayer))),
      );
      const emitter = Context.get(services, HookEmitter);
      const registry = Context.get(services, ContributionRegistry);
      const plugins = options.plugins ?? [compactPlugin, sessionNamePlugin];
      yield* Effect.forEach(
        plugins,
        (plugin) => registry.registerPlugin(plugin.manifest, plugin.contributions),
        { discard: true },
      ).pipe(Effect.orDie);

      const compactionGate: PluginHostService["compactionGate"] = (sessionId, request) => {
        const grants = createCapabilityGrants(sessionId);
        return emitCompactionGate(emitter, grants, request).pipe(
          Effect.catchAll((error) =>
            Effect.succeed({
              action: "skip" as const,
              reason: `Compaction gate failed closed: ${String(error)}`,
            }),
          ),
        );
      };

      const invokeCommand: PluginHostService["invokeCommand"] = (name, args, context) =>
        Effect.gen(function* () {
          const grants = createCapabilityGrants(context.sessionId);
          const commands = yield* registry
            .list(CommandContributionKind, grants)
            .pipe(
              Effect.mapError((cause) =>
                invokeCommandError(
                  name,
                  "command_failed",
                  `Command ${name} could not be resolved: ${cause.message}`,
                  cause,
                ),
              ),
            );
          const matches = commands.filter((command) => command.name === name);
          if (matches.length === 0) {
            return yield* invokeCommandError(
              name,
              "command_not_found",
              `Command ${name} was not found.`,
            );
          }
          if (matches.length > 1) {
            return yield* Effect.fail(
              invokeCommandError(
                name,
                "command_ambiguous",
                `Command ${name} has multiple Contributions.`,
              ),
            );
          }
          const command = matches[0];
          if (command === undefined) {
            return yield* Effect.die("Command resolution lost its selected Contribution.");
          }
          const input = yield* Schema.decodeUnknown(command.payload.arguments, {
            onExcessProperty: "error",
          })(args).pipe(
            Effect.mapError((cause) =>
              invokeCommandError(
                name,
                "arguments_invalid",
                `Command ${name} arguments are invalid.`,
                cause,
              ),
            ),
          );
          const commandContext = commandExecutionContext(name, context, emitter, grants);
          return yield* command.payload
            .execute(input, commandContext)
            .pipe(
              Effect.mapError((cause) =>
                cause instanceof InvokeCommandError
                  ? cause
                  : invokeCommandError(name, "command_failed", `Command ${name} failed.`, cause),
              ),
            );
        });

      return { compactionGate, invokeCommand };
    }),
  );

export const FirstPartyDriverDefault = (
  options: DriverDefaultOptions = {},
  hostOptions: FirstPartyPluginHostOptions = {},
) => DriverDefault(options, FirstPartyPluginHostLive(hostOptions));
