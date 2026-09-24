/**
 * Owns CLI Plugin discovery-config as thin DiscoveryAdapter over GenerationRuntime (D-003).
 * It exists so GenerationRuntime's ONE recomposition loader can be tested without a process and so
 * run.ts stays an I/O boundary. It builds PluginDiscoveryConfig (cliPaths, projectPath,
 * userGlobalDirectories plus the --no-project-plugins decoy) and delegates file→Generation work
 * to GenerationRuntime via loadGeneration; first-party catalog, path mapping, and
 * name-collision invariants live behind FirstPartySuite (02 architecture review).
 * Why this adapter remains shallow: it adds exactly one Branch (decoy directory when
 * --no-project-plugins) and delegates the catalog guard to FirstPartySuite; deleting it
 * would merely move that Branch into GenerationRuntime or its tests, not concentrate
 * complexity. Its seam is plugin discovery config: two adapters justify it — real
 * readdir/mkdtemp on the host vs fake config in pipeline.test.ts that proves the same
 * generation path without first-party duplication.
 * Not responsible for source enumeration or digest binding (PluginDiscovery owns those via
 * sources/trust-digest private seams) or for first-party catalog invariants
 * (FirstPartySuite owns that) or for module import or manifest validation (loader owns
 * that) or for registry priority (registry owns that) or for generation lifetime/
 * checkout/drain counting (GenerationRuntime owns that) or for Tool adaptation
 * (adapter owns that).
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type GenerationLoadError,
  type GenerationPlugin,
  loadGeneration,
  type PluginDiscoveryConfig,
  type PluginGeneration,
  phase1Sources,
  TrustStoreMemory,
} from "@dungle-scrubs/popeye-plugins";
import { Data, Effect } from "effect";

import {
  defaultFirstPartyPlugins,
  type FirstPartyPlugin,
  firstPartyGenerationPlugins,
  pluginNameCollision,
} from "../features/first-party-suite.js";
import type { ToolGrantFilter } from "../tools/grants.js";

export type { FirstPartyPlugin } from "../features/first-party-suite.js";

export interface ComposePluginRuntimeOptions {
  readonly firstPartyPlugins?: ReadonlyArray<FirstPartyPlugin>;
  /** HCN tool-free isolation: first-party plugins only, no tools. */
  readonly isolation?: string;
  readonly noProjectPlugins: boolean;
  readonly pluginPaths: ReadonlyArray<string>;
  readonly projectPath: string;
  /** HCN skills allowlist: plugin names to keep; absent keeps all. */
  readonly skills?: ReadonlyArray<string>;
  /** HCN tool-grant filter; absent means every trusted tool is granted. */
  readonly toolGrants?: ToolGrantFilter;
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
    // HCN tool-free isolation: first-party plugins only. External sources
    // never load, so untrusted contributions cannot reach the grant filter.
    if (options.isolation === "tool-free") {
      const decoyProjectPath = yield* Effect.tryPromise({
        catch: (cause) =>
          new PluginPipelineConfigError({
            cause,
            message: `Could not create temporary Plugin discovery directory: ${String(cause)}`,
            path: tmpdir(),
            reason: "decoy_directory_unavailable",
          }),
        try: () => mkdtemp(join(tmpdir(), "popeye-cli-plugin-pipeline-isolated-")),
      });
      return {
        cliPaths: [],
        projectPath: decoyProjectPath,
        userGlobalDirectories: [],
      };
    }
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
      try: () => mkdtemp(join(tmpdir(), "popeye-cli-plugin-pipeline-no-project-")),
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
  options.noProjectPlugins || options.isolation === "tool-free"
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
        const firstPartyPlugins = options.firstPartyPlugins ?? defaultFirstPartyPlugins;
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
          // HCN skills allowlist filters plugin names: keep listed plugins,
          // drop the rest. Unknown names match nothing.
          if (options.skills !== undefined) {
            const keep = new Set(options.skills);
            const drop = [...firstPartyGeneration, ...generation.plugins]
              .map((plugin) => plugin.name)
              .filter((name) => !keep.has(name));
            yield* Effect.forEach(drop, (name) => generation.registry.removePlugin(name), {
              discard: true,
            });
          }
          const kept =
            options.skills === undefined
              ? [...firstPartyGeneration, ...generation.plugins]
              : [...firstPartyGeneration, ...generation.plugins].filter((plugin) =>
                  new Set(options.skills).has(plugin.name),
                );
          return {
            ...generation,
            plugins: kept,
          };
        }).pipe(Effect.onError(() => generation.close));
      }),
    (config) => removeDecoyProjectPath(options, config),
  ).pipe(Effect.provide(TrustStoreMemory()));
