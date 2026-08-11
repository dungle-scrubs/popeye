/**
 * Owns the per-project Trust decision and its binding to project Plugin file content.
 * It exists so project-local code cannot execute until D-015 has produced a structured decision.
 *
 * Trust is not a sandbox. It gates whether project-local code executes at all. Plugin code that is
 * trusted runs with the process authority. Digest computation reads Plugin bytes to hash them, but
 * it does not import or execute those bytes. Prompt presentation belongs to a Head. This module
 * returns structured prompt results instead.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { Clock, Context, Data, Effect, Layer, Option, Ref, Schema } from "effect";

import type { CapabilityGrants } from "./capability.js";
import type { PluginDiscoveryConfig } from "./discovery.js";
import type { HookEmitError, HookEmitterService } from "./emitter.js";
import type { TrustHookInput } from "./hook-points.js";
import {
  computeProjectPluginDigest,
  type PluginDigestDiagnostic,
  type PluginDigestError,
  type PluginFileDigest,
} from "./trust-digest.js";

export type { PluginFileDigest } from "./trust-digest.js";

export type TrustDecision = "trusted" | "untrusted";
export type TrustDecisionProvenance = "hook" | "revoked" | "user";

export interface TrustRecord {
  readonly decidedAt: string;
  readonly decidedBy: TrustDecisionProvenance;
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
      readonly decidedBy: TrustDecisionProvenance;
      readonly kind: "reprompt_required";
    }
  | {
      readonly decidedBy: TrustDecisionProvenance;
      readonly kind: "trusted";
      readonly trustedDigest: string;
    }
  | { readonly decidedBy: TrustDecisionProvenance; readonly kind: "untrusted" };

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

export interface TrustDecisionDiagnostic {
  readonly changeSummary?: TrustChangeSummary;
  readonly decidedBy?: TrustDecisionProvenance;
  readonly decision: TrustCheckResult["kind"];
  readonly digest: string;
  readonly projectPath: string;
  readonly scope: "project-local";
  readonly type: "trust_decision";
}

export type TrustDiagnostic = PluginDigestDiagnostic | TrustDecisionDiagnostic;

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
  decidedBy: Schema.optionalWith(Schema.Literal("hook", "revoked", "user"), {
    default: () => "user" as const,
  }),
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
  const diagnostic: TrustDecisionDiagnostic = {
    ...(result.kind === "reprompt_required" ? { changeSummary: result.changeSummary } : {}),
    ...("decidedBy" in result ? { decidedBy: result.decidedBy } : {}),
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
        ...(diagnostic.decidedBy === undefined ? {} : { decidedBy: diagnostic.decidedBy }),
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

const emptyTrustStoreFile = (): TrustStoreFile => ({
  format: "peye_trust",
  records: [],
  version: 1,
});

const readRecoverableTrustStoreFile = (
  path: string,
): Effect.Effect<TrustStoreFile, Exclude<TrustStoreError, { readonly reason: "store_corrupt" }>> =>
  readTrustStoreFile(path).pipe(
    Effect.catchIf(
      (error) => error.reason === "store_corrupt",
      (error) => Effect.logWarning(error.message).pipe(Effect.as(emptyTrustStoreFile())),
    ),
  );

const writeTrustStoreFile = (
  path: string,
  records: ReadonlyArray<TrustRecord>,
): Effect.Effect<void, TrustStoreError> => {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const content = `${JSON.stringify({ format: "peye_trust", records, version: 1 })}\n`;
  return Effect.tryPromise({
    catch: (cause) => storeFailure(path, "store_io_failure", cause),
    try: async () => {
      await mkdir(dirname(path), { mode: 0o700, recursive: true });
      await chmod(dirname(path), 0o700);
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
        await handle.close();
        await rename(temporaryPath, path);
        const directoryHandle = await open(dirname(path), "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } catch (cause) {
        await handle.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
        throw cause;
      }
    },
  });
};

const isLockBusy = (error: TrustStoreError): boolean =>
  typeof error.cause === "object" &&
  error.cause !== null &&
  "code" in error.cause &&
  error.cause.code === "EEXIST";

const withStoreLock = <TOutput>(
  path: string,
  effect: Effect.Effect<TOutput, TrustStoreError>,
): Effect.Effect<TOutput, TrustStoreError> => {
  const lockPath = `${path}.lock`;
  const acquire = (
    remainingAttempts: number,
  ): Effect.Effect<Awaited<ReturnType<typeof open>>, TrustStoreError> =>
    Effect.tryPromise({
      catch: (cause) => storeFailure(lockPath, "store_io_failure", cause),
      try: () => open(lockPath, "wx", 0o600),
    }).pipe(
      Effect.catchIf(isLockBusy, (error) =>
        remainingAttempts > 0
          ? Effect.sleep("10 millis").pipe(Effect.zipRight(acquire(remainingAttempts - 1)))
          : Effect.fail(error),
      ),
    );
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      catch: (cause) => storeFailure(path, "store_io_failure", cause),
      try: async () => {
        await mkdir(dirname(path), { mode: 0o700, recursive: true });
        await chmod(dirname(path), 0o700);
      },
    });
    return yield* Effect.acquireUseRelease(
      acquire(500),
      () => effect,
      (handle) =>
        Effect.tryPromise({
          catch: (cause) => storeFailure(lockPath, "store_io_failure", cause),
          try: async () => {
            await handle.close();
            await unlink(lockPath);
          },
        }).pipe(Effect.orDie),
    );
  });
};

export const TrustStoreLive = (
  options: TrustStoreLiveOptions,
): Layer.Layer<TrustStore, TrustStoreError> =>
  Layer.effect(
    TrustStore,
    Effect.gen(function* () {
      const loaded = yield* readRecoverableTrustStoreFile(options.path);
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
              yield* withStoreLock(
                options.path,
                Effect.gen(function* () {
                  const latest = yield* readRecoverableTrustStoreFile(options.path);
                  const next = new Map(
                    latest.records.map((storedRecord) => [storedRecord.projectPath, storedRecord]),
                  );
                  next.set(record.projectPath, record);
                  const sorted = [...next.values()].sort((left, right) =>
                    compareText(left.projectPath, right.projectPath),
                  );
                  yield* writeTrustStoreFile(options.path, sorted);
                  yield* Ref.set(records, next);
                }),
              );
            }),
          ),
      } satisfies TrustStoreService;
    }),
  );

export const checkTrust = (
  config: PluginDiscoveryConfig,
  options: TrustCheckOptions = {},
): Effect.Effect<
  TrustCheckResult,
  HookEmitError<"trust"> | PluginDigestError | TrustStoreError,
  TrustStore
> =>
  Effect.gen(function* () {
    const canonicalProjectPath = yield* resolvedProjectPath(config.projectPath);
    const canonicalConfig = { ...config, projectPath: canonicalProjectPath };
    const diagnosticSink = options.diagnosticSink ?? defaultDiagnosticSink;
    const current = yield* computeProjectPluginDigest(canonicalConfig, diagnosticSink);
    const store = yield* TrustStore;
    const recorded = yield* store.get(canonicalProjectPath);
    let result: TrustCheckResult;
    if (Option.isNone(recorded)) {
      result = { currentDigest: current.digest, kind: "prompt_required" };
    } else if (recorded.value.digest !== current.digest) {
      result = {
        changeSummary: summarizeChanges(recorded.value.files, current.files),
        currentDigest: current.digest,
        decidedBy: recorded.value.decidedBy,
        kind: "reprompt_required",
      };
    } else {
      result =
        recorded.value.decision === "trusted"
          ? ({
              decidedBy: recorded.value.decidedBy,
              kind: "trusted",
              trustedDigest: current.digest,
            } as const)
          : ({ decidedBy: recorded.value.decidedBy, kind: "untrusted" } as const);
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
      const hookOutcome = yield* options.hookEmitter
        .emit("trust", hookInput, options.grants, { pluginScope: "external" })
        .pipe(
          Effect.map((decision) => ({ decision, kind: "completed" as const })),
          Effect.catchTag("GateRejected", () => Effect.succeed({ kind: "blocked" as const })),
        );
      if (hookOutcome.kind === "blocked") {
        result = { decidedBy: "hook", kind: "untrusted" };
      } else if (hookOutcome.decision !== undefined) {
        const decisionDigest = result.currentDigest;
        yield* recordDecision(
          canonicalConfig,
          hookOutcome.decision.decision,
          decisionDigest,
          "hook",
        ).pipe(
          Effect.catchIf(
            (error) => error.reason === "digest_mismatch",
            (error) =>
              Effect.gen(function* () {
                const changed = yield* computeProjectPluginDigest(canonicalConfig, diagnosticSink);
                yield* observeTrust(diagnosticSink, changed.digest, canonicalProjectPath, {
                  changeSummary: summarizeChanges(current.files, changed.files),
                  currentDigest: changed.digest,
                  decidedBy: "hook",
                  kind: "reprompt_required",
                });
                return yield* error;
              }),
          ),
        );
        result =
          hookOutcome.decision.decision === "trusted"
            ? { decidedBy: "hook", kind: "trusted", trustedDigest: decisionDigest }
            : { decidedBy: "hook", kind: "untrusted" };
      }
    }
    yield* observeTrust(diagnosticSink, current.digest, canonicalProjectPath, result);
    return result;
  }).pipe(Effect.withSpan("plugins.trust", { attributes: { projectPath: config.projectPath } }));

export const recordDecision = (
  config: PluginDiscoveryConfig,
  decision: TrustDecision,
  digest: string,
  decidedBy: Exclude<TrustDecisionProvenance, "revoked">,
): Effect.Effect<TrustRecord, PluginDigestError | TrustStoreError, TrustStore> =>
  Effect.gen(function* () {
    const canonicalProjectPath = yield* resolvedProjectPath(config.projectPath);
    const current = yield* computeProjectPluginDigest({
      ...config,
      projectPath: canonicalProjectPath,
    });
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
      decidedBy,
      decision,
      digest,
      files: current.files,
      projectPath: canonicalProjectPath,
    };
    const store = yield* TrustStore;
    yield* store.put(record);
    return record;
  });

export const revokeTrust = (
  projectPath: string,
): Effect.Effect<void, TrustStoreError, TrustStore> =>
  Effect.gen(function* () {
    const canonicalProjectPath = yield* resolvedProjectPath(projectPath);
    const store = yield* TrustStore;
    const recorded = yield* store.get(canonicalProjectPath);
    if (Option.isNone(recorded)) {
      return;
    }
    const decidedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* store.put({
      ...recorded.value,
      decidedAt,
      decidedBy: "revoked",
      decision: "untrusted",
    });
  });
