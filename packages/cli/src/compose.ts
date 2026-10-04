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
  type JournalSessions,
  kernelPackage,
  makeReflectionProducer,
  makeSessionLifecycle,
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
  type ReflectionProducer,
  type RegisteredTool,
  reflectionProducerFromEnv,
  SessionLifecycle,
  type SessionLifecycleService,
  type SessionLifecycleTap,
  type SessionToolView,
  type SessionTurnOptions,
  type ThinkingLevel,
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
import {
  ReloadBusyError,
  ReloadControl,
  type ReloadControlService,
  ReloadDrainTimeoutError,
  ReloadUnavailableError,
} from "./plugins/reload.js";

export type {
  AssistantDiagnostic,
  AssistantItem,
  DriverService,
  DriverSnapshot,
  JournalSessions,
  PluginCommandContext,
  PluginCompactionGateRequest,
  PluginCompactionGateResult,
  PluginHostService,
  Progress,
  ProviderService,
  ReflectionProducer,
  RegisteredTool,
  SessionLifecycleService,
  SessionLifecycleTap,
  SessionToolView,
  SessionTurnOptions,
  ThinkingLevel,
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
  makeReflectionProducer,
  makeSessionLifecycle,
  PiAiProviderLive,
  PluginHost,
  Provider,
  ProviderError,
  reflectionProducerFromEnv,
  SessionLifecycle,
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
  changeGoal: context.changeGoal,
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
  getGoal: context.getGoal,
  sessionId: context.sessionId,
  setSessionName: context.setSessionName,
});

const commandFailure = (name: string, cause: unknown): InvokeCommandError =>
  cause instanceof InvokeCommandError
    ? cause
    : cause instanceof ReloadBusyError ||
        cause instanceof ReloadDrainTimeoutError ||
        cause instanceof ReloadUnavailableError
      ? invokeCommandError(name, "command_failed", cause.message, cause)
      : invokeCommandError(name, "command_failed", `Command ${name} failed.`, cause);

/** Where a PluginHost finds its Plugins: the Generation current at each call, and reload control if any. */
export interface PluginHostSource {
  readonly currentGeneration: Effect.Effect<PluginGeneration>;
  readonly reloadControl?: ReloadControlService;
}
export const makePluginHostService = (source: PluginHostSource): PluginHostService => {
  const compactionGate: PluginHostService["compactionGate"] = (sessionId, request) => {
    const grants = createCapabilityGrants(sessionId);
    return source.currentGeneration.pipe(
      Effect.flatMap(({ emitter }) => emitCompactionGate(emitter, grants, request)),
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
      const { emitter, registry } = yield* source.currentGeneration;
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
      const base = command.payload.execute(input, commandContext);
      const withReload =
        source.reloadControl === undefined
          ? base
          : base.pipe(Effect.provideService(ReloadControl, source.reloadControl));
      return yield* withReload.pipe(Effect.mapError((cause) => commandFailure(name, cause)));
    });

  return { compactionGate, invokeCommand };
};

export const GenerationPluginHostLive = (generation: PluginGeneration): Layer.Layer<PluginHost> =>
  Layer.succeed(
    PluginHost,
    makePluginHostService({ currentGeneration: Effect.succeed(generation) }),
  );

/**
 * The `session-lifecycle` Tap broadcast for one Plugin generation. Diagnostic only: Tap delivery
 * may drop, so the durable reflection send never rides it (ADR-0002).
 */
export const generationLifecycleTap =
  (generation: PluginGeneration): SessionLifecycleTap =>
  (input) =>
    generation.emitter
      .emit("session-lifecycle", input, createCapabilityGrants(input.sessionId))
      .pipe(Effect.asVoid);

export const GenerationDriverDefault = (
  generation: PluginGeneration,
  options: DriverDefaultOptions = {},
) =>
  DriverDefault(
    {
      ...options,
      lifecycle:
        options.lifecycle ?? makeSessionLifecycle({ tap: generationLifecycleTap(generation) }),
    },
    GenerationPluginHostLive(generation),
  );

/** The session-lifecycle Tap broadcast on whichever Generation is current at each emit. */
export const currentGenerationLifecycleTap =
  (currentGeneration: Effect.Effect<PluginGeneration>): SessionLifecycleTap =>
  (input) =>
    currentGeneration.pipe(
      Effect.flatMap((generation) => generationLifecycleTap(generation)(input)),
    );

/** A host whose Plugins follow the current Generation (CliRuntime satisfies it). */
export interface CurrentGenerationHost {
  readonly currentGeneration: Effect.Effect<PluginGeneration>;
  readonly pluginHost: PluginHostService;
}

/** The Driver for a reloadable host: Commands, `/reload`, the compaction gate, and the lifecycle Tap follow its current Generation. */
export const CliRuntimeDriverDefault = (
  host: CurrentGenerationHost,
  options: DriverDefaultOptions = {},
) =>
  DriverDefault(
    {
      ...options,
      lifecycle:
        options.lifecycle ??
        makeSessionLifecycle({ tap: currentGenerationLifecycleTap(host.currentGeneration) }),
    },
    Layer.succeed(PluginHost, host.pluginHost),
  );

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
    ).pipe(
      Effect.map((generation) =>
        makePluginHostService({ currentGeneration: Effect.succeed(generation) }),
      ),
    ),
  );

export const FirstPartyDriverDefault = (
  options: DriverDefaultOptions = {},
  hostOptions: FirstPartyPluginHostOptions = {},
) => DriverDefault(options, FirstPartyPluginHostLive(hostOptions));
