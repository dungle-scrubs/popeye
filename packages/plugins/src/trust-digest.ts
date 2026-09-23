/**
 * Owns content digests for the exact phase-2 Plugin execution set as private seam of PluginDiscovery.
 * It exists so Trust decisions have bounded, fail-closed content binding via hashing of the
 * canonical phase-2 source enumeration. It is not a standalone seam: callers depend on
 * PluginDiscovery's phase2Sources(trustDecision) which internally verifies digest equality,
 * not on computeProjectPluginDigest directly. Digest limits (maxFileCount, maxTotalBytes) and
 * the hash are owned here, but the decision to trust or to recompute lives in discovery.
 * Not responsible for source enumeration (sources owns file walks) or for trust prompting/storage
 * (trust owns records and checkTrust), or for module import (loader owns that).
 */
import { createHash } from "node:crypto";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { relative, sep } from "node:path";

import { Data, Effect } from "effect";

import {
  classifyResolvedPluginSource,
  type PluginDigestLimits,
  type PluginDiscoveryConfig,
  type PluginDiscoveryError,
  type PluginSource,
  phase2ExecutionSources,
} from "./sources.js";

export const DEFAULT_PLUGIN_DIGEST_MAX_FILE_COUNT = 10_000;
export const DEFAULT_PLUGIN_DIGEST_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export interface PluginFileDigest {
  readonly digest: string;
  readonly path: string;
}

export interface ProjectPluginDigest {
  readonly digest: string;
  readonly files: ReadonlyArray<PluginFileDigest>;
  readonly sources: ReadonlyArray<PluginSource>;
}

export type PluginDigestViolation =
  | "digest_mismatch"
  | "file_count_exceeded"
  | "filesystem_failure"
  | "invalid_limits"
  | "symlink_escape"
  | "total_bytes_exceeded";

export class PluginDigestError extends Data.TaggedError("PluginDigestError")<{
  readonly cause: unknown;
  readonly message: string;
  readonly path: string;
  readonly reason: "digest_error";
  readonly violation: PluginDigestViolation;
}> {}

export interface PluginDigestDiagnostic {
  readonly path: string;
  readonly reason: PluginDigestViolation;
  readonly type: "plugin_digest_rejected";
}

interface DigestState {
  readonly files: Array<PluginFileDigest>;
  readonly limits: PluginDigestLimits;
  readonly projectPath: string;
  readonly visitedRealPaths: Set<string>;
  totalBytes: number;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const digestError = (
  path: string,
  violation: PluginDigestViolation,
  message: string,
  cause: unknown = null,
): PluginDigestError =>
  new PluginDigestError({ cause, message, path, reason: "digest_error", violation });

const digestLimits = (config: PluginDiscoveryConfig): PluginDigestLimits | PluginDigestError => {
  const limits = {
    maxFileCount: config.digestLimits?.maxFileCount ?? DEFAULT_PLUGIN_DIGEST_MAX_FILE_COUNT,
    maxTotalBytes: config.digestLimits?.maxTotalBytes ?? DEFAULT_PLUGIN_DIGEST_MAX_TOTAL_BYTES,
  };
  if (
    !Number.isSafeInteger(limits.maxFileCount) ||
    limits.maxFileCount < 0 ||
    !Number.isSafeInteger(limits.maxTotalBytes) ||
    limits.maxTotalBytes < 0
  ) {
    return digestError(
      config.projectPath,
      "invalid_limits",
      "Plugin digest limits must be non-negative safe integers.",
    );
  }
  return limits;
};

const logicalPath = (projectPath: string, path: string): string =>
  relative(projectPath, path).split(sep).join("/");

const hashFile = (path: string, state: DigestState): Effect.Effect<string, PluginDigestError> =>
  Effect.tryPromise({
    catch: (cause) =>
      cause instanceof PluginDigestError
        ? cause
        : digestError(
            path,
            "filesystem_failure",
            `Could not hash Plugin file ${path}: ${String(cause)}`,
            cause,
          ),
    try: async () => {
      const handle = await open(path, "r");
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let fileBytes = 0;
      try {
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) {
            break;
          }
          fileBytes += bytesRead;
          if (state.totalBytes + fileBytes > state.limits.maxTotalBytes) {
            throw digestError(
              path,
              "total_bytes_exceeded",
              `Plugin digest total-byte budget ${state.limits.maxTotalBytes} was exceeded at ${path}.`,
            );
          }
          hash.update(buffer.subarray(0, bytesRead));
        }
      } finally {
        await handle.close();
      }
      state.totalBytes += fileBytes;
      return hash.digest("hex");
    },
  });

const collectPath = (path: string, state: DigestState): Effect.Effect<void, PluginDigestError> =>
  Effect.gen(function* () {
    const resolvedPath = yield* Effect.tryPromise({
      catch: (cause) =>
        digestError(
          path,
          "filesystem_failure",
          `Could not resolve Plugin path ${path}: ${String(cause)}`,
          cause,
        ),
      try: () => realpath(path),
    });
    if (classifyResolvedPluginSource(state.projectPath, resolvedPath) === "external") {
      return yield* digestError(
        path,
        "symlink_escape",
        `Project-local Plugin path ${path} resolves outside the project to ${resolvedPath}.`,
      );
    }
    if (state.visitedRealPaths.has(resolvedPath)) {
      return;
    }
    state.visitedRealPaths.add(resolvedPath);
    const information = yield* Effect.tryPromise({
      catch: (cause) =>
        digestError(
          resolvedPath,
          "filesystem_failure",
          `Could not inspect Plugin path ${resolvedPath}: ${String(cause)}`,
          cause,
        ),
      try: () => stat(resolvedPath),
    });
    if (information.isFile()) {
      if (state.files.length >= state.limits.maxFileCount) {
        return yield* digestError(
          path,
          "file_count_exceeded",
          `Plugin digest file-count budget ${state.limits.maxFileCount} was exceeded at ${path}.`,
        );
      }
      state.files.push({
        digest: yield* hashFile(resolvedPath, state),
        path: logicalPath(state.projectPath, resolvedPath),
      });
      return;
    }
    if (!information.isDirectory()) {
      return;
    }
    const entries = yield* Effect.tryPromise({
      catch: (cause) =>
        digestError(
          resolvedPath,
          "filesystem_failure",
          `Could not read Plugin directory ${resolvedPath}: ${String(cause)}`,
          cause,
        ),
      try: () => readdir(resolvedPath),
    });
    yield* Effect.forEach(
      [...entries].sort(compareText),
      (entry) => collectPath(`${resolvedPath}${sep}${entry}`, state),
      { discard: true },
    );
  });

const discoveryDigestError = (error: PluginDiscoveryError): PluginDigestError =>
  digestError(
    error.path,
    error.reason === "project_symlink_escape" ? "symlink_escape" : "filesystem_failure",
    error.reason === "project_symlink_escape"
      ? `Project-local Plugin path ${error.path} resolves outside the project.`
      : `Could not enumerate project-local Plugin sources at ${error.path}: ${String(error.cause)}`,
    error,
  );

const defaultDiagnosticSink = (diagnostic: PluginDigestDiagnostic): Effect.Effect<void> =>
  Effect.logWarning(JSON.stringify(diagnostic));

export const computeProjectPluginDigest = (
  config: PluginDiscoveryConfig,
  diagnosticSink: (
    diagnostic: PluginDigestDiagnostic,
  ) => Effect.Effect<void> = defaultDiagnosticSink,
): Effect.Effect<ProjectPluginDigest, PluginDigestError> => {
  const limits = digestLimits(config);
  const computation =
    limits instanceof PluginDigestError
      ? Effect.fail(limits)
      : Effect.gen(function* () {
          const projectPath = yield* Effect.tryPromise({
            catch: (cause) =>
              digestError(
                config.projectPath,
                "filesystem_failure",
                `Could not resolve project path ${config.projectPath}: ${String(cause)}`,
                cause,
              ),
            try: () => realpath(config.projectPath),
          });
          const sources = yield* phase2ExecutionSources(config).pipe(
            Effect.mapError(discoveryDigestError),
          );
          const state: DigestState = {
            files: [],
            limits,
            projectPath,
            totalBytes: 0,
            visitedRealPaths: new Set<string>(),
          };
          yield* Effect.forEach(sources, (source) => collectPath(source.path, state), {
            discard: true,
          });
          const files = state.files.sort((left, right) => compareText(left.path, right.path));
          const sourceIdentity = sources.map((source) => ({
            origin: source.origin,
            path: logicalPath(projectPath, source.path),
          }));
          const digest = createHash("sha256")
            .update("popeye-project-plugin-digest-v2\0")
            .update(JSON.stringify({ files, sources: sourceIdentity }))
            .digest("hex");
          return { digest, files, sources };
        });
  return computation.pipe(
    Effect.tapError((error) =>
      diagnosticSink({ path: error.path, reason: error.violation, type: "plugin_digest_rejected" }),
    ),
  );
};

export const digestMismatchError = (
  path: string,
  trustedDigest: string,
  currentDigest: string,
): PluginDigestError =>
  digestError(
    path,
    "digest_mismatch",
    `Plugin content digest changed from ${trustedDigest} to ${currentDigest} before phase 2.`,
  );
