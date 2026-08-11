/**
 * Owns native Plugin module import and factory construction.
 * It exists because D-027 requires Node type stripping through absolute file URLs, without a
 * transforming loader, and reload needs an explicit query-string cache key. That key reloads only
 * the entry module: relative sibling imports keep their original URLs, so sibling edits require a
 * full process restart. Each distinct query also adds a permanent, non-evictable Node ESM registry
 * entry. D-027 accepts that v1 tradeoff because reloads are human-paced rather than a hot loop.
 * Import timeout (RFC Design 4, 03/D-010) bounds composition latency only: native ESM imports are
 * not cancellable, a timed-out import's side effects may still run later, and repeated reload
 * attempts with cache-busted specifiers accumulate registry entries.
 */
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { Effect } from "effect";

import type { Contribution } from "./contribution.js";
import { PluginLoadError } from "./errors.js";
import { decodePluginManifest, type PluginManifest } from "./manifest.js";

export interface LoadedPlugin {
  readonly contributions: ReadonlyArray<Contribution>;
  readonly manifest: PluginManifest;
  readonly path: string;
}

export const DEFAULT_IMPORT_TIMEOUT_MILLIS = 30_000;

export interface PluginModuleLoadOptions {
  readonly cacheKey?: string;
  readonly importTimeoutMillis?: number;
}

type PluginFactory = () => unknown;

const nativeImport = (specifier: string): Promise<unknown> => import(specifier);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const errorCode = (cause: unknown): string | undefined =>
  isRecord(cause) && typeof cause.code === "string" ? cause.code : undefined;

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const unsupportedConstruct = (message: string): "enum" | "namespace" | "unknown" => {
  if (/\benum\b/i.test(message)) return "enum";
  if (/\bnamespace\b/i.test(message)) return "namespace";
  return "unknown";
};

const loadFailure = (path: string, cause: unknown): PluginLoadError => {
  const message = errorMessage(cause);
  const construct = unsupportedConstruct(message);
  if (errorCode(cause) === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") {
    return new PluginLoadError({
      cause: "unsupported_syntax",
      message: `Plugin ${path} uses unsupported TypeScript ${construct} syntax: ${message}`,
      plugin: path,
      schemaCause: cause,
    });
  }
  return new PluginLoadError({
    cause: "build_failed",
    message: `Plugin ${path} failed to load or build: ${message}`,
    plugin: path,
    schemaCause: cause,
  });
};

const pluginFactory = (
  module: unknown,
  path: string,
): Effect.Effect<PluginFactory, PluginLoadError> => {
  if (!isRecord(module)) {
    return Effect.fail(loadFailure(path, "module did not expose named exports"));
  }
  const candidate = module.default ?? module.plugin;
  return typeof candidate === "function"
    ? Effect.succeed(candidate as PluginFactory)
    : Effect.fail(loadFailure(path, "default or named plugin export must be a factory"));
};

const pluginDefinition = (
  input: unknown,
  path: string,
): Effect.Effect<LoadedPlugin, PluginLoadError> => {
  if (!isRecord(input) || !Array.isArray(input.contributions) || !("manifest" in input)) {
    return Effect.fail(
      loadFailure(path, "factory must return an object with manifest and contributions"),
    );
  }
  return decodePluginManifest(input.manifest).pipe(
    Effect.map((manifest) => ({
      contributions: input.contributions as ReadonlyArray<Contribution>,
      manifest,
      path,
    })),
  );
};

export const loadPluginModule = (
  path: string,
  options: PluginModuleLoadOptions = {},
): Effect.Effect<LoadedPlugin, PluginLoadError> => {
  if (!isAbsolute(path)) {
    return Effect.fail(loadFailure(path, "Plugin path must be absolute"));
  }
  const url = pathToFileURL(path);
  if (options.cacheKey !== undefined) {
    url.searchParams.set("reload", options.cacheKey);
  }
  const timeoutMillis = options.importTimeoutMillis ?? DEFAULT_IMPORT_TIMEOUT_MILLIS;
  const timeoutError = new PluginLoadError({
    cause: "import_timeout",
    message: `Plugin ${path} import timed out after ${timeoutMillis}ms`,
    plugin: path,
  });
  const importAndFactory = Effect.tryPromise({
    catch: (cause) => loadFailure(path, cause),
    try: () => nativeImport(url.href),
  }).pipe(
    Effect.flatMap((module) => pluginFactory(module, path)),
    Effect.flatMap((factory) =>
      Effect.tryPromise({
        catch: (cause) => loadFailure(path, cause),
        try: () => Promise.resolve(factory()),
      }),
    ),
    Effect.timeoutFail({
      duration: timeoutMillis,
      onTimeout: () => timeoutError,
    }),
  );
  return importAndFactory.pipe(Effect.flatMap((definition) => pluginDefinition(definition, path)));
};
