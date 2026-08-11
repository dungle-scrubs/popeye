/**
 * Owns Plugin source classification before any project-local Plugin can load.
 * It exists so every source uses the same real-path rule, including CLI paths and symlinks.
 */
import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import { Data, Effect } from "effect";

export type PluginSourceOrigin = "cli" | "project" | "user-global";
export type PluginSourceScope = "external" | "project-local";

export interface PluginDiscoveryConfig {
  readonly cliPaths: ReadonlyArray<string>;
  readonly projectPath: string;
  readonly userGlobalDirectories: ReadonlyArray<string>;
}

export interface PluginSource {
  readonly origin: PluginSourceOrigin;
  readonly path: string;
  readonly scope: PluginSourceScope;
}

export interface TrustDecisionForDiscovery {
  readonly kind: "prompt_required" | "reprompt_required" | "trusted" | "untrusted";
}

export class PluginDiscoveryError extends Data.TaggedError("PluginDiscoveryError")<{
  readonly cause: unknown;
  readonly path: string;
  readonly reason: "read_directory_failed" | "realpath_failed";
}> {}

export const classifyResolvedPluginSource = (
  resolvedProjectPath: string,
  resolvedSourcePath: string,
): PluginSourceScope => {
  const pathFromProject = relative(resolvedProjectPath, resolvedSourcePath);
  return pathFromProject === "" ||
    (!pathFromProject.startsWith("..") && !isAbsolute(pathFromProject))
    ? "project-local"
    : "external";
};

const resolveRealPath = (path: string): Effect.Effect<string, PluginDiscoveryError> =>
  Effect.tryPromise({
    catch: (cause) => new PluginDiscoveryError({ cause, path, reason: "realpath_failed" }),
    try: () => realpath(path),
  });

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareSources = (left: PluginSource, right: PluginSource): number =>
  compareText(left.path, right.path) || compareText(left.origin, right.origin);

const uniqueSortedSources = (sources: ReadonlyArray<PluginSource>): ReadonlyArray<PluginSource> => {
  const unique = new Map<string, PluginSource>();
  for (const source of sources) {
    if (!unique.has(source.path)) {
      unique.set(source.path, source);
    }
  }
  return [...unique.values()].sort(compareSources);
};

const isMissingPath = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

const projectPluginPaths = (
  projectPath: string,
): Effect.Effect<ReadonlyArray<string>, PluginDiscoveryError> => {
  const directory = join(projectPath, ".peye", "plugins");
  return Effect.tryPromise({
    catch: (cause) =>
      new PluginDiscoveryError({ cause, path: directory, reason: "read_directory_failed" }),
    try: () => readdir(directory),
  }).pipe(
    Effect.map((names) => names.map((name) => join(directory, name))),
    Effect.catchIf(
      (error) => isMissingPath(error.cause),
      () => Effect.succeed([]),
    ),
  );
};

const resolveCandidates = (
  candidates: ReadonlyArray<{ readonly origin: PluginSourceOrigin; readonly path: string }>,
  resolvedProjectPath: string,
): Effect.Effect<ReadonlyArray<PluginSource>, PluginDiscoveryError> =>
  Effect.forEach(candidates, (candidate) =>
    resolveRealPath(candidate.path).pipe(
      Effect.map((path) => ({
        origin: candidate.origin,
        path,
        scope: classifyResolvedPluginSource(resolvedProjectPath, path),
      })),
    ),
  );

export const phase1Sources = (
  config: PluginDiscoveryConfig,
): Effect.Effect<ReadonlyArray<PluginSource>, PluginDiscoveryError> =>
  Effect.gen(function* () {
    const resolvedProjectPath = yield* resolveRealPath(config.projectPath);
    const candidates = [
      ...config.userGlobalDirectories.map((path) => ({ origin: "user-global" as const, path })),
      ...config.cliPaths.map((path) => ({ origin: "cli" as const, path })),
    ];
    const resolved = yield* resolveCandidates(candidates, resolvedProjectPath);
    return uniqueSortedSources(resolved.filter((source) => source.scope === "external"));
  });

export const phase2Sources = (
  config: PluginDiscoveryConfig,
  trustDecision: TrustDecisionForDiscovery,
): Effect.Effect<ReadonlyArray<PluginSource>, PluginDiscoveryError> =>
  trustDecision.kind === "trusted"
    ? Effect.gen(function* () {
        const resolvedProjectPath = yield* resolveRealPath(config.projectPath);
        const discoveredProjectPaths = yield* projectPluginPaths(resolvedProjectPath);
        const candidates = [
          ...config.cliPaths.map((path) => ({ origin: "cli" as const, path })),
          ...discoveredProjectPaths.map((path) => ({ origin: "project" as const, path })),
        ];
        const resolved = yield* resolveCandidates(candidates, resolvedProjectPath);
        return uniqueSortedSources(resolved.filter((source) => source.scope === "project-local"));
      })
    : Effect.succeed([]);
