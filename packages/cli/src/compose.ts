/**
 * Owns the sole in-process composition boundary between the CLI and kernel.
 * It exists so wire heads remain protocol-only while local hosting has one explicit exception.
 */
import {
  type AssistantDiagnostic,
  AssistantDiagnosticSchema,
  type AssistantItem,
  AssistantStopReasonSchema,
  Driver,
  DriverDefault,
  type DriverDefaultOptions,
  type DriverService,
  type DriverSnapshot,
  defineTool,
  InvokeCommandError,
  kernelPackage,
  PiAiProviderLive,
  type PluginCommandContext,
  type PluginCompactionGateRequest,
  type PluginCompactionGateResult,
  PluginHost,
  type PluginHostService,
  type Progress,
  Provider,
  ProviderError,
  type ProviderService,
  type RegisteredTool,
  type SessionToolView,
  type Tool,
  ToolError,
  ToolRegistry,
  ToolRegistryLive,
  type ToolRegistryService,
  type TurnOptions,
  type TurnResult,
} from "@dungle-scrubs/popeye-kernel";
import {
  type CapabilityGrants,
  CommandContributionKind,
  type CommandExecutionContext,
  createCapabilityGrants,
  type HookEmitterService,
  type PluginGeneration,
} from "@dungle-scrubs/popeye-plugins";
import { Effect, Layer, Logger, Schema } from "effect";

import { composePluginRuntime, type FirstPartyPlugin } from "./plugins/pipeline.js";

export type {
  AssistantDiagnostic,
  AssistantItem,
  DriverService,
  DriverSnapshot,
  PluginCommandContext,
  PluginCompactionGateRequest,
  PluginCompactionGateResult,
  PluginHostService,
  Progress,
  ProviderService,
  RegisteredTool,
  SessionToolView,
  Tool,
  ToolRegistryService,
  TurnOptions,
  TurnResult,
};
export {
  AssistantDiagnosticSchema,
  AssistantStopReasonSchema,
  Driver,
  defineTool,
  InvokeCommandError,
  PiAiProviderLive,
  PluginHost,
  Provider,
  ProviderError,
  ToolError,
  ToolRegistry,
  ToolRegistryLive,
};

export const inProcessKernelPackage = kernelPackage;

export interface FirstPartyPluginHostOptions {
  readonly plugins?: ReadonlyArray<FirstPartyPlugin>;
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

const pluginHostService = (generation: PluginGeneration): PluginHostService => {
  const { emitter, registry } = generation;
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
};

export const GenerationPluginHostLive = (generation: PluginGeneration): Layer.Layer<PluginHost> =>
  Layer.succeed(PluginHost, pluginHostService(generation));

export const GenerationDriverDefault = (
  generation: PluginGeneration,
  options: DriverDefaultOptions = {},
) => DriverDefault(options, GenerationPluginHostLive(generation));

export const FirstPartyPluginHostLive = (
  options: FirstPartyPluginHostOptions = {},
): Layer.Layer<PluginHost> =>
  Layer.scoped(
    PluginHost,
    Effect.acquireRelease(
      composePluginRuntime({
        ...(options.plugins === undefined ? {} : { firstPartyPlugins: options.plugins }),
        noProjectPlugins: true,
        pluginPaths: [],
        projectPath: process.cwd(),
      }).pipe(
        Effect.provide(
          Logger.replace(Logger.defaultLogger, Logger.withConsoleError(Logger.logfmtLogger)),
        ),
        Effect.orDie,
      ),
      (generation) => generation.close,
    ).pipe(Effect.map(pluginHostService)),
  );

export const FirstPartyDriverDefault = (
  options: DriverDefaultOptions = {},
  hostOptions: FirstPartyPluginHostOptions = {},
) => DriverDefault(options, FirstPartyPluginHostLive(hostOptions));
