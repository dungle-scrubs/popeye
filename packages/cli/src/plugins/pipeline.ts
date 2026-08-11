/**
 * Owns CLI Plugin discovery-config construction and loadGeneration composition, including the
 * Trust constant, memory store, diagnostic sinks, displacement guard, and fail-closed mapping.
 * It exists so run.ts stays an I/O boundary and the pipeline remains testable without a process.
 * Tool adaptation is not owned here; a later milestone adapts Plugin tools into the kernel.
 */
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  type Contribution,
  type GenerationLoadError,
  type GenerationPlugin,
  loadGeneration,
  type PluginDiscoveryConfig,
  type PluginGeneration,
  type PluginManifest,
  phase1Sources,
  TrustStoreMemory,
} from "@pop-eye/plugins";
import { Data, Effect } from "effect";

import { compactPlugin } from "../features/compact.js";
import { sessionNamePlugin } from "../features/session-name.js";

export interface FirstPartyPlugin {
  readonly contributions: ReadonlyArray<Contribution>;
  readonly manifest: PluginManifest;
}

export interface ComposePluginRuntimeOptions {
  readonly firstPartyPlugins?: ReadonlyArray<FirstPartyPlugin>;
  readonly noProjectPlugins: boolean;
  readonly pluginPaths: ReadonlyArray<string>;
  readonly projectPath: string;
  readonly userPluginDir?: string;
}

export class PluginPipelineError extends Data.TaggedError("PluginPipelineError")<{
  readonly message: string;
  readonly phase1Path: string;
  readonly phase2Path: string;
  readonly pluginName: string;
  readonly reason: "phase2_displacement";
}> {}

export class PluginPipelineConfigError extends Data.TaggedError("PluginPipelineConfigError")<{
  readonly cause: unknown;
  readonly message: string;
  readonly path: string;
  readonly reason: "user_plugin_directory_unavailable";
}> {}

const firstPartyPath = (plugin: FirstPartyPlugin): string =>
  plugin === compactPlugin
    ? fileURLToPath(new URL("../features/compact.js", import.meta.url))
    : plugin === sessionNamePlugin
      ? fileURLToPath(new URL("../features/session-name.js", import.meta.url))
      : `first-party:${plugin.manifest.name}`;

const firstPartyGenerationPlugins = (
  plugins: ReadonlyArray<FirstPartyPlugin>,
): ReadonlyArray<GenerationPlugin> =>
  plugins.map((plugin) => ({
    name: plugin.manifest.name,
    path: firstPartyPath(plugin),
    scope: "external" as const,
    version: plugin.manifest.version,
  }));

type DiagnosticFamily = "generation" | "hook" | "registry" | "trust";

const diagnosticSink =
  (diagnosticFamily: DiagnosticFamily) =>
  <TDiagnostic extends object>(diagnostic: TDiagnostic): Effect.Effect<void> =>
    Effect.logInfo(JSON.stringify({ diagnosticFamily, ...diagnostic }));

const discoveryConfig = (
  options: ComposePluginRuntimeOptions,
): Effect.Effect<PluginDiscoveryConfig, GenerationLoadError | PluginPipelineConfigError> =>
  Effect.gen(function* () {
    const userPluginDir = options.userPluginDir;
    const userGlobalDirectories =
      userPluginDir === undefined
        ? []
        : yield* Effect.tryPromise({
            catch: (cause) =>
              new PluginPipelineConfigError({
                cause,
                message: `Could not inspect user Plugin directory ${userPluginDir}: ${String(cause)}`,
                path: userPluginDir,
                reason: "user_plugin_directory_unavailable",
              }),
            try: () => stat(userPluginDir),
          }).pipe(
            Effect.as([userPluginDir]),
            Effect.catchIf(
              (error) =>
                typeof error.cause === "object" &&
                error.cause !== null &&
                "code" in error.cause &&
                error.cause.code === "ENOENT",
              () => Effect.succeed([]),
            ),
          );
    const config: PluginDiscoveryConfig = {
      cliPaths: options.pluginPaths,
      projectPath: options.projectPath,
      userGlobalDirectories,
    };
    if (!options.noProjectPlugins) {
      return config;
    }
    const sources = yield* phase1Sources(config);
    return {
      cliPaths: sources.filter((source) => source.origin === "cli").map((source) => source.path),
      projectPath: fileURLToPath(new URL(".", import.meta.url)),
      userGlobalDirectories: config.userGlobalDirectories,
    };
  });

export const composePluginRuntime = (
  options: ComposePluginRuntimeOptions,
): Effect.Effect<
  PluginGeneration,
  GenerationLoadError | PluginPipelineConfigError | PluginPipelineError
> =>
  Effect.gen(function* () {
    const config = yield* discoveryConfig(options);
    const generation = yield* loadGeneration({
      config,
      generationDiagnosticSink: diagnosticSink("generation"),
      hookDiagnosticSink: diagnosticSink("hook"),
      registryDiagnosticSink: diagnosticSink("registry"),
      trust: "trusted",
      trustDiagnosticSink: diagnosticSink("trust"),
    });
    const firstPartyPlugins = options.firstPartyPlugins ?? [compactPlugin, sessionNamePlugin];
    const firstPartyGeneration = firstPartyGenerationPlugins(firstPartyPlugins);
    return yield* Effect.gen(function* () {
      const phase1ByName = new Map(
        [...firstPartyGeneration, ...generation.plugins]
          .filter((plugin) => plugin.scope === "external")
          .map((plugin) => [plugin.name, plugin] as const),
      );
      const displaced = generation.plugins.find(
        (plugin) => plugin.scope === "project-local" && phase1ByName.has(plugin.name),
      );
      if (displaced !== undefined) {
        const existing = phase1ByName.get(displaced.name);
        if (existing === undefined) {
          return yield* Effect.die("Displacement lookup lost its phase-1 Plugin.");
        }
        return yield* new PluginPipelineError({
          message: `Project Plugin ${displaced.path} cannot displace phase-1 Plugin ${existing.path} with manifest name ${JSON.stringify(displaced.name)}.`,
          phase1Path: existing.path,
          phase2Path: displaced.path,
          pluginName: displaced.name,
          reason: "phase2_displacement",
        });
      }
      yield* Effect.forEach(
        firstPartyPlugins,
        (plugin) =>
          generation.registry.registerPlugin(plugin.manifest, plugin.contributions, "external"),
        { discard: true },
      );
      return {
        ...generation,
        plugins: [...firstPartyGeneration, ...generation.plugins],
      };
    }).pipe(Effect.onError(() => generation.close));
  }).pipe(Effect.provide(TrustStoreMemory()));
