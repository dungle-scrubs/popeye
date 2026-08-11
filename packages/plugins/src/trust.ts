/**
 * Owns the per-project Trust decision and its binding to project Plugin file content.
 * It exists so project-local code cannot execute until D-015 has produced a structured decision.
 *
 * Trust is not a sandbox. It gates whether project-local code executes at all. Plugin code that is
 * trusted runs with the process authority. Digest computation reads Plugin bytes to hash them, but
 * it does not import or execute those bytes. Prompt presentation belongs to a Head. This module
 * returns structured prompt results instead.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

import { Clock, Context, Data, Effect, Layer, Option, Ref, Schema } from "effect";

import type { CapabilityGrants } from "./capability.js";
import { classifyResolvedPluginSource } from "./discovery.js";
import type { HookEmitError, HookEmitterService } from "./emitter.js";
import type { TrustHookInput } from "./hook-points.js";

export type TrustDecision = "trusted" | "untrusted";

export interface PluginFileDigest {
  readonly digest: string;
  readonly path: string;
}

export interface TrustRecord {
  readonly decidedAt: string;
  readonly decision: TrustDecision;
  readonly digest: string;
  readonly files: ReadonlyArray<PluginFileDigest>;
  readonly projectPath: string;
}

export interface TrustChangeSummary {
  readonly added: ReadonlyArray<string>;
  readonly modified: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
}

export type TrustCheckResult =
  | { readonly currentDigest: string; readonly kind: "prompt_required" }
  | {
      readonly changeSummary: TrustChangeSummary;
      readonly currentDigest: string;
      readonly kind: "reprompt_required";
    }
  | { readonly kind: "trusted" }
  | { readonly kind: "untrusted" };

export type TrustStoreErrorReason =
  | "digest_mismatch"
  | "filesystem_failure"
  | "store_corrupt"
  | "store_io_failure";

export class TrustStoreError extends Data.TaggedError("TrustStoreError")<{
  readonly cause: unknown;
  readonly message: string;
  readonly path: string;
  readonly reason: TrustStoreErrorReason;
}> {}

export interface TrustStoreService {
  readonly get: (projectPath: string) => Effect.Effect<Option.Option<TrustRecord>, TrustStoreError>;
  readonly put: (record: TrustRecord) => Effect.Effect<void, TrustStoreError>;
}

export class TrustStore extends Context.Tag("@peye/plugins/TrustStore")<
  TrustStore,
  TrustStoreService
>() {}

export interface TrustStoreLiveOptions {
  readonly path: string;
}

export interface TrustDiagnostic {
  readonly changeSummary?: TrustChangeSummary;
  readonly decision: TrustCheckResult["kind"];
  readonly digest: string;
  readonly projectPath: string;
  readonly scope: "project-local";
  readonly type: "trust_decision";
}

export interface TrustCheckOptions {
  readonly diagnosticSink?: (diagnostic: TrustDiagnostic) => Effect.Effect<void>;
  readonly grants?: CapabilityGrants;
  readonly hookEmitter?: HookEmitterService;
}

const DigestSchema = Schema.String.pipe(Schema.pattern(/^[a-f\d]{64}$/));
const PluginFileDigestSchema = Schema.Struct({
  digest: DigestSchema,
  path: Schema.String,
});
const TrustRecordSchema = Schema.Struct({
  decidedAt: Schema.String,
  decision: Schema.Literal("trusted", "untrusted"),
  digest: DigestSchema,
  files: Schema.Array(PluginFileDigestSchema),
  projectPath: Schema.String,
});
const TrustStoreFileSchema = Schema.Struct({
  format: Schema.Literal("peye_trust"),
  records: Schema.Array(TrustRecordSchema).pipe(
    Schema.filter(
      (records) => new Set(records.map((record) => record.projectPath)).size === records.length,
      { message: () => "Trust records must have unique project paths" },
    ),
  ),
  version: Schema.Literal(1),
});

type TrustStoreFile = Schema.Schema.Type<typeof TrustStoreFileSchema>;

interface ProjectDigest {
  readonly digest: string;
  readonly files: ReadonlyArray<PluginFileDigest>;
}

const filesystemFailure = (path: string, cause: unknown): TrustStoreError =>
  new TrustStoreError({
    cause,
    message: `Could not read Plugin content at ${path}: ${String(cause)}`,
    path,
    reason: "filesystem_failure",
  });

const fileEffect = <TOutput>(
  path: string,
  run: () => Promise<TOutput>,
): Effect.Effect<TOutput, TrustStoreError> =>
  Effect.tryPromise({ catch: (cause) => filesystemFailure(path, cause), try: run });

const isMissingPath = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const collectPluginFiles = (
  ancestorDirectories: ReadonlySet<string>,
  directory: string,
  logicalDirectory: string,
  projectPath: string,
): Effect.Effect<ReadonlyArray<PluginFileDigest>, TrustStoreError> =>
  fileEffect(directory, () => readdir(directory, { withFileTypes: true })).pipe(
    Effect.flatMap((entries) =>
      Effect.forEach(
        [...entries].sort((left, right) => compareText(left.name, right.name)),
        (entry) =>
          Effect.gen(function* () {
            const sourcePath = join(directory, entry.name);
            const resolvedPath = yield* fileEffect(sourcePath, () => realpath(sourcePath));
            if (classifyResolvedPluginSource(projectPath, resolvedPath) === "external") {
              return [];
            }
            const information = yield* fileEffect(resolvedPath, () => stat(resolvedPath));
            const logicalPath =
              logicalDirectory === "" ? entry.name : posix.join(logicalDirectory, entry.name);
            if (information.isFile()) {
              const content = yield* fileEffect(resolvedPath, () => readFile(resolvedPath));
              return [
                {
                  digest: createHash("sha256").update(content).digest("hex"),
                  path: logicalPath,
                },
              ];
            }
            if (!information.isDirectory() || ancestorDirectories.has(resolvedPath)) {
              return [];
            }
            return yield* collectPluginFiles(
              new Set([...ancestorDirectories, resolvedPath]),
              resolvedPath,
              logicalPath,
              projectPath,
            );
          }),
      ),
    ),
    Effect.map((groups) => groups.flat().sort((left, right) => compareText(left.path, right.path))),
  );

const computeProjectDigest = (projectPath: string): Effect.Effect<ProjectDigest, TrustStoreError> =>
  Effect.gen(function* () {
    const pluginRoot = join(projectPath, ".peye", "plugins");
    const resolvedPluginRoot = yield* fileEffect(pluginRoot, () => realpath(pluginRoot)).pipe(
      Effect.catchIf(
        (error) => isMissingPath(error.cause),
        () => Effect.succeed(null),
      ),
    );
    const files =
      resolvedPluginRoot === null ||
      classifyResolvedPluginSource(projectPath, resolvedPluginRoot) === "external"
        ? []
        : yield* collectPluginFiles(
            new Set([resolvedPluginRoot]),
            resolvedPluginRoot,
            "",
            projectPath,
          );
    const digest = createHash("sha256")
      .update("peye-project-plugin-digest-v1\0")
      .update(JSON.stringify(files))
      .digest("hex");
    return { digest, files };
  });

const summarizeChanges = (
  previousFiles: ReadonlyArray<PluginFileDigest>,
  currentFiles: ReadonlyArray<PluginFileDigest>,
): TrustChangeSummary => {
  const previous = new Map(previousFiles.map((file) => [file.path, file.digest]));
  const current = new Map(currentFiles.map((file) => [file.path, file.digest]));
  return {
    added: [...current.keys()].filter((path) => !previous.has(path)).sort(compareText),
    modified: [...current.entries()]
      .filter(([path, digest]) => previous.has(path) && previous.get(path) !== digest)
      .map(([path]) => path)
      .sort(compareText),
    removed: [...previous.keys()].filter((path) => !current.has(path)).sort(compareText),
  };
};

const resolvedProjectPath = (projectPath: string): Effect.Effect<string, TrustStoreError> =>
  fileEffect(projectPath, () => realpath(projectPath));

const defaultDiagnosticSink = (diagnostic: TrustDiagnostic): Effect.Effect<void> =>
  Effect.logInfo(JSON.stringify(diagnostic));

const observeTrust = (
  diagnosticSink: (diagnostic: TrustDiagnostic) => Effect.Effect<void>,
  digest: string,
  projectPath: string,
  result: TrustCheckResult,
): Effect.Effect<void> => {
  const diagnostic: TrustDiagnostic = {
    ...(result.kind === "reprompt_required" ? { changeSummary: result.changeSummary } : {}),
    decision: result.kind,
    digest,
    projectPath,
    scope: "project-local",
    type: "trust_decision",
  };
  return diagnosticSink(diagnostic).pipe(
    Effect.zipRight(
      Effect.annotateCurrentSpan({
        ...(diagnostic.changeSummary === undefined
          ? {}
          : { changeSummary: JSON.stringify(diagnostic.changeSummary) }),
        decision: diagnostic.decision,
        digest: diagnostic.digest,
        projectPath: diagnostic.projectPath,
        scope: diagnostic.scope,
      }),
    ),
  );
};

export const TrustStoreMemory = (
  initialRecords: ReadonlyArray<TrustRecord> = [],
): Layer.Layer<TrustStore> =>
  Layer.effect(
    TrustStore,
    Ref.make(new Map(initialRecords.map((record) => [record.projectPath, record]))).pipe(
      Effect.map((records) => ({
        get: (projectPath) =>
          Ref.get(records).pipe(Effect.map((state) => Option.fromNullable(state.get(projectPath)))),
        put: (record) =>
          Ref.update(records, (state) => {
            const next = new Map(state);
            next.set(record.projectPath, record);
            return next;
          }),
      })),
    ),
  );

const storeFailure = (
  path: string,
  reason: "store_corrupt" | "store_io_failure",
  cause: unknown,
): TrustStoreError =>
  new TrustStoreError({
    cause,
    message:
      reason === "store_corrupt"
        ? `Trust store ${path} is corrupt: ${String(cause)}`
        : `Could not access Trust store ${path}: ${String(cause)}`,
    path,
    reason,
  });

const readTrustStoreFile = (path: string): Effect.Effect<TrustStoreFile, TrustStoreError> =>
  Effect.tryPromise({
    catch: (cause) => storeFailure(path, "store_io_failure", cause),
    try: () => readFile(path, "utf8"),
  }).pipe(
    Effect.catchIf(
      (error) => isMissingPath(error.cause),
      () => Effect.succeed('{"format":"peye_trust","records":[],"version":1}'),
    ),
    Effect.flatMap((text) =>
      Effect.try({
        catch: (cause) => storeFailure(path, "store_corrupt", cause),
        try: () => JSON.parse(text) as unknown,
      }),
    ),
    Effect.flatMap(Schema.decodeUnknown(TrustStoreFileSchema, { onExcessProperty: "error" })),
    Effect.mapError((cause) =>
      cause instanceof TrustStoreError ? cause : storeFailure(path, "store_corrupt", cause),
    ),
  );

const writeTrustStoreFile = (
  path: string,
  records: ReadonlyArray<TrustRecord>,
): Effect.Effect<void, TrustStoreError> => {
  const temporaryPath = `${path}.tmp`;
  const content = `${JSON.stringify({ format: "peye_trust", records, version: 1 })}\n`;
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      catch: (cause) => storeFailure(path, "store_io_failure", cause),
      try: () => mkdir(dirname(path), { recursive: true }),
    });
    yield* Effect.tryPromise({
      catch: (cause) => storeFailure(path, "store_io_failure", cause),
      try: () => writeFile(temporaryPath, content, { mode: 0o600 }),
    });
    yield* Effect.tryPromise({
      catch: (cause) => storeFailure(path, "store_io_failure", cause),
      try: () => rename(temporaryPath, path),
    });
  });
};

export const TrustStoreLive = (
  options: TrustStoreLiveOptions,
): Layer.Layer<TrustStore, TrustStoreError> =>
  Layer.effect(
    TrustStore,
    Effect.gen(function* () {
      const loaded = yield* readTrustStoreFile(options.path);
      const records = yield* Ref.make(
        new Map(loaded.records.map((record) => [record.projectPath, record])),
      );
      const writeMutex = yield* Effect.makeSemaphore(1);
      return {
        get: (projectPath) =>
          Ref.get(records).pipe(Effect.map((state) => Option.fromNullable(state.get(projectPath)))),
        put: (record) =>
          writeMutex.withPermits(1)(
            Effect.gen(function* () {
              const state = yield* Ref.get(records);
              const next = new Map(state);
              next.set(record.projectPath, record);
              const sorted = [...next.values()].sort((left, right) =>
                compareText(left.projectPath, right.projectPath),
              );
              yield* writeTrustStoreFile(options.path, sorted);
              yield* Ref.set(records, next);
            }),
          ),
      } satisfies TrustStoreService;
    }),
  );

export const checkTrust = (
  projectPath: string,
  options: TrustCheckOptions = {},
): Effect.Effect<TrustCheckResult, HookEmitError<"trust"> | TrustStoreError, TrustStore> =>
  Effect.gen(function* () {
    const canonicalProjectPath = yield* resolvedProjectPath(projectPath);
    const current = yield* computeProjectDigest(canonicalProjectPath);
    const store = yield* TrustStore;
    const recorded = yield* store.get(canonicalProjectPath);
    let result: TrustCheckResult;
    if (Option.isNone(recorded)) {
      result = { currentDigest: current.digest, kind: "prompt_required" };
    } else if (recorded.value.digest !== current.digest) {
      result = {
        changeSummary: summarizeChanges(recorded.value.files, current.files),
        currentDigest: current.digest,
        kind: "reprompt_required",
      };
    } else {
      result =
        recorded.value.decision === "trusted"
          ? ({ kind: "trusted" } as const)
          : ({ kind: "untrusted" } as const);
    }
    if (
      (result.kind === "prompt_required" || result.kind === "reprompt_required") &&
      options.hookEmitter !== undefined &&
      options.grants !== undefined
    ) {
      const hookInput: TrustHookInput = {
        ...(result.kind === "reprompt_required" ? { changeSummary: result.changeSummary } : {}),
        currentDigest: result.currentDigest,
        kind: result.kind,
        projectPath: canonicalProjectPath,
      };
      const hookOutcome = yield* options.hookEmitter.emit("trust", hookInput, options.grants).pipe(
        Effect.map((decision) => ({ decision, kind: "completed" as const })),
        Effect.catchTag("GateRejected", () => Effect.succeed({ kind: "blocked" as const })),
      );
      if (hookOutcome.kind === "blocked") {
        result = { kind: "untrusted" };
      } else if (hookOutcome.decision !== undefined) {
        yield* recordDecision(
          canonicalProjectPath,
          hookOutcome.decision.decision,
          result.currentDigest,
        );
        result = { kind: hookOutcome.decision.decision };
      }
    }
    yield* observeTrust(
      options.diagnosticSink ?? defaultDiagnosticSink,
      current.digest,
      canonicalProjectPath,
      result,
    );
    return result;
  }).pipe(Effect.withSpan("plugins.trust", { attributes: { projectPath } }));

export const recordDecision = (
  projectPath: string,
  decision: TrustDecision,
  digest: string,
): Effect.Effect<TrustRecord, TrustStoreError, TrustStore> =>
  Effect.gen(function* () {
    const canonicalProjectPath = yield* resolvedProjectPath(projectPath);
    const current = yield* computeProjectDigest(canonicalProjectPath);
    if (current.digest !== digest) {
      return yield* new TrustStoreError({
        cause: null,
        message: `Plugin content changed before the Trust decision was recorded for ${canonicalProjectPath}.`,
        path: canonicalProjectPath,
        reason: "digest_mismatch",
      });
    }
    const decidedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const record: TrustRecord = {
      decidedAt,
      decision,
      digest,
      files: current.files,
      projectPath: canonicalProjectPath,
    };
    const store = yield* TrustStore;
    yield* store.put(record);
    return record;
  });
