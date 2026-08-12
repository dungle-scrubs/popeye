/**
 * Owns Plugin source enumeration as private seam of PluginDiscovery.
 * It exists so phase-1 (external only) and phase-2 (project-local only) file walks, realpath
 * resolution, scope classification, and symlink-escape detection hide behind canonical helpers
 * that PluginDiscovery composes. It is not a standalone seam: callers depend on PluginDiscovery
 * (phase1Sources/phase2Sources), not on phase1ExecutionSources/phase2ExecutionSources directly.
 * Not responsible for digest binding or trust decisions (trust-digest owns hashing and limits;
 * discovery owns the trusted/untrusted branch) or for import/manifest validation (loader owns that)
 * or for registry priority (registry owns that).
 */
import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { Data, Effect } from "effect";

export type PluginSourceOrigin = "cli" | "project" | "user-global";
export type PluginSourceScope = "external" | "project-local";

export interface PluginDigestLimits {
  readonly maxFileCount: number;
  readonly maxTotalBytes: number;
}

export interface PluginDiscoveryConfig {
  readonly cliPaths: ReadonlyArray<string>;
  readonly digestLimits?: Partial<PluginDigestLimits>;
  readonly projectPath: string;
  readonly userGlobalDirectories: ReadonlyArray<string>;
}

export interface PluginSource {
  readonly origin: PluginSourceOrigin;
  readonly path: string;
  readonly scope: PluginSourceScope;
}

export class PluginDiscoveryError extends Data.TaggedError("PluginDiscoveryError")<{
  readonly cause: unknown;
  readonly path: string;
  readonly reason: "project_symlink_escape" | "read_directory_failed" | "realpath_failed";
}> {}

const isUnavailableProjectPluginPath = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause.code === "EACCES" || cause.code === "ENOENT" || cause.code === "ENOTDIR");

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

export const classifyResolvedPluginSource = (
  resolvedProjectPath: string,
  resolvedSourcePath: string,
): PluginSourceScope => {
  const pathFromProject = relative(resolvedProjectPath, resolvedSourcePath);
  return pathFromProject === "" ||
    (pathFromProject !== ".." &&
      !pathFromProject.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromProject))
    ? "project-local"
    : "external";
};

const resolveRealPath = (path: string): Effect.Effect<string, PluginDiscoveryError> =>
  Effect.tryPromise({
    catch: (cause) => new PluginDiscoveryError({ cause, path, reason: "realpath_failed" }),
    try: () => realpath(path),
  });

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
      (error) => isUnavailableProjectPluginPath(error.cause),
      () => Effect.succeed([]),
    ),
  );
};

const userGlobalPluginPaths = (
  directory: string,
): Effect.Effect<ReadonlyArray<string>, PluginDiscoveryError> =>
  Effect.tryPromise({
    catch: (cause) =>
      new PluginDiscoveryError({ cause, path: directory, reason: "read_directory_failed" }),
    try: () => readdir(directory),
  }).pipe(Effect.map((names) => names.map((name) => join(directory, name))));

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

export const phase1ExecutionSources = (
  config: PluginDiscoveryConfig,
): Effect.Effect<ReadonlyArray<PluginSource>, PluginDiscoveryError> =>
  Effect.gen(function* () {
    const resolvedProjectPath = yield* resolveRealPath(config.projectPath);
    const userGlobalPaths = yield* Effect.forEach(
      config.userGlobalDirectories,
      userGlobalPluginPaths,
    ).pipe(Effect.map((directories) => directories.flat()));
    const candidates = [
      ...userGlobalPaths.map((path) => ({ origin: "user-global" as const, path })),
      ...config.cliPaths.map((path) => ({ origin: "cli" as const, path })),
    ];
    const resolved = yield* resolveCandidates(candidates, resolvedProjectPath);
    return uniqueSortedSources(resolved.filter((source) => source.scope === "external"));
  });

export const phase2ExecutionSources = (
  config: PluginDiscoveryConfig,
): Effect.Effect<ReadonlyArray<PluginSource>, PluginDiscoveryError> =>
  Effect.gen(function* () {
    const resolvedProjectPath = yield* resolveRealPath(config.projectPath);
    const discoveredProjectPaths = yield* projectPluginPaths(resolvedProjectPath);
    const candidates = [
      ...config.cliPaths.map((path) => ({ origin: "cli" as const, path })),
      ...discoveredProjectPaths.map((path) => ({ origin: "project" as const, path })),
    ];
    const resolved = yield* resolveCandidates(candidates, resolvedProjectPath);
    const escapingProjectSourceIndex = resolved.findIndex(
      (source) => source.origin === "project" && source.scope === "external",
    );
    if (escapingProjectSourceIndex !== -1) {
      const candidate = candidates[escapingProjectSourceIndex];
      return yield* new PluginDiscoveryError({
        cause: null,
        path: candidate?.path ?? resolved[escapingProjectSourceIndex]?.path ?? resolvedProjectPath,
        reason: "project_symlink_escape",
      });
    }
    return uniqueSortedSources(resolved.filter((source) => source.scope === "project-local"));
  });
