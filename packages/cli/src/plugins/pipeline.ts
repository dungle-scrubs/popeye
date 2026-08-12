/**
 * Owns CLI Plugin discovery-config as DiscoveryAdapter -> config only (D-003).
 * It exists so GenerationRuntime's ONE recomposition loader can be tested without a process and so run.ts stays an I/O boundary.
 * The composition root is runtime.ts as thin DiscoveryAdapter over GenerationRuntime; this module is its discovery/guard helper, not the runtime.
 * Not responsible for generation lifetime (GenerationRuntime owns that) or Tool adaptation (adapter owns that).
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { reloadPlugin } from "../features/reload.js";
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
  readonly reason: "name_collision" | "phase2_displacement";
}> {}

export class PluginPipelineConfigError extends Data.TaggedError("PluginPipelineConfigError")<{
  readonly cause: unknown;
  readonly message: string;
  readonly path: string;
  readonly reason: "decoy_directory_unavailable" | "user_plugin_directory_unavailable";
}> {}

const firstPartyPath = (plugin: FirstPartyPlugin): string =>
  plugin === compactPlugin
    ? fileURLToPath(new URL("../features/compact.js", import.meta.url))
    : plugin === sessionNamePlugin
      ? fileURLToPath(new URL("../features/session-name.js", import.meta.url))
      : plugin === reloadPlugin
        ? fileURLToPath(new URL("../features/reload.js", import.meta.url))
        : `first-party:${plugin.manifest.name}`;

const firstPartyGenerationPlugins = (
  plugins: ReadonlyArray<FirstPartyPlugin>,
): ReadonlyArray<GenerationPlugin> =>
  plugins.map((plugin) => ({
    manifest: plugin.manifest,
    name: plugin.manifest.name,
    origin: "first-party" as const,
    path: firstPartyPath(plugin),
    scope: "external" as const,
    version: plugin.manifest.version,
  }));

const pluginNameCollision = (
  plugins: ReadonlyArray<GenerationPlugin>,
): readonly [GenerationPlugin, GenerationPlugin] | undefined => {
  const pluginByName = new Map<string, GenerationPlugin>();
  for (const plugin of plugins) {
    const existing = pluginByName.get(plugin.name);
    if (existing !== undefined && existing.path !== plugin.path) {
      return [existing, plugin];
    }
    pluginByName.set(plugin.name, plugin);
  }
  return undefined;
};

const pluginNameCollisionError = (
  collision: readonly [GenerationPlugin, GenerationPlugin],
): PluginPipelineError => {
  const [first, second] = collision;
  const phase1 = first.scope === "external" ? first : second;
  const phase2 = first.scope === "project-local" ? first : second;
  return phase1.scope === "external" && phase2.scope === "project-local"
    ? new PluginPipelineError({
        message: `Project Plugin ${phase2.path} cannot displace phase-1 Plugin ${phase1.path} with manifest name ${JSON.stringify(phase2.name)}.`,
        phase1Path: phase1.path,
        phase2Path: phase2.path,
        pluginName: phase2.name,
        reason: "phase2_displacement",
      })
    : new PluginPipelineError({
        message: `Plugin ${first.path} and Plugin ${second.path} share manifest name ${JSON.stringify(first.name)}.`,
        phase1Path: first.path,
        phase2Path: second.path,
        pluginName: first.name,
        reason: "name_collision",
      });
};

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
            try: () => readdir(userPluginDir),
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
    const decoyProjectPath = yield* Effect.tryPromise({
      catch: (cause) =>
        new PluginPipelineConfigError({
          cause,
          message: `Could not create temporary Plugin discovery directory: ${String(cause)}`,
          path: tmpdir(),
          reason: "decoy_directory_unavailable",
        }),
      try: () => mkdtemp(join(tmpdir(), "peye-cli-plugin-pipeline-no-project-")),
    });
    return {
      cliPaths: sources.filter((source) => source.origin === "cli").map((source) => source.path),
      projectPath: decoyProjectPath,
      userGlobalDirectories: config.userGlobalDirectories,
    };
  });

const removeDecoyProjectPath = (
  options: ComposePluginRuntimeOptions,
  config: PluginDiscoveryConfig,
): Effect.Effect<void> =>
  options.noProjectPlugins
    ? Effect.tryPromise({
        catch: (cause) =>
          new PluginPipelineConfigError({
            cause,
            message: `Could not remove temporary Plugin discovery directory ${config.projectPath}: ${String(cause)}`,
            path: config.projectPath,
            reason: "decoy_directory_unavailable",
          }),
        try: () => rm(config.projectPath, { force: true, recursive: true }),
      }).pipe(Effect.orDie)
    : Effect.void;

export const composePluginRuntime = (
  options: ComposePluginRuntimeOptions,
): Effect.Effect<
  PluginGeneration,
  GenerationLoadError | PluginPipelineConfigError | PluginPipelineError
> =>
  Effect.acquireUseRelease(
    discoveryConfig(options),
    (config) =>
      Effect.gen(function* () {
        const generation = yield* loadGeneration({
          config,
          generationDiagnosticSink: diagnosticSink("generation"),
          hookDiagnosticSink: diagnosticSink("hook"),
          registryDiagnosticSink: diagnosticSink("registry"),
          trust: "trusted",
          trustDiagnosticSink: diagnosticSink("trust"),
        });
        const firstPartyPlugins = options.firstPartyPlugins ?? [
          compactPlugin,
          reloadPlugin,
          sessionNamePlugin,
        ];
        const firstPartyGeneration = firstPartyGenerationPlugins(firstPartyPlugins);
        return yield* Effect.gen(function* () {
          const collision = pluginNameCollision([...firstPartyGeneration, ...generation.plugins]);
          if (collision !== undefined) {
            return yield* pluginNameCollisionError(collision);
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
      }),
    (config) => removeDecoyProjectPath(options, config),
  ).pipe(Effect.provide(TrustStoreMemory()));
