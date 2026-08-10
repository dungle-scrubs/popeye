/**
 * Owns the version transition for durable journal lines before they enter journal code.
 * It exists so schema changes remain explicit instead of making old acknowledged lines ambiguous.
 */
import { Effect, Schema } from "effect";

import { type JournalCorruptionClass, JournalError } from "./errors.js";

export interface LineVersion<A, I> {
  /**
   * Converts the preceding version's encoded payload into this version's encoded payload.
   * The durable format migrates in its own representation, so migrations do not depend on
   * a previous domain model that may no longer exist.
   */
  readonly migrate?: (previous: unknown) => I;
  readonly payloadSchema: Schema.Schema<A, I>;
  readonly version: number;
}

export interface LineCodecConfig {
  readonly currentVersion: number;
  readonly versions: ReadonlyArray<{
    readonly migrate?: (previous: unknown) => unknown;
    readonly payloadSchema: Schema.Schema.AnyNoContext;
    readonly version: number;
  }>;
}

export interface LineLocator {
  readonly file?: string;
  readonly line?: number;
}

export interface LineCodec<TCurrent> {
  readonly decodeLine: (
    text: string,
    locator?: LineLocator,
  ) => Effect.Effect<TCurrent, JournalError>;
  readonly encodeLine: (
    payload: TCurrent,
    locator?: LineLocator,
  ) => Effect.Effect<string, JournalError>;
}

type CurrentPayload<TConfig extends LineCodecConfig> =
  Extract<TConfig["versions"][number], { readonly version: TConfig["currentVersion"] }> extends {
    readonly payloadSchema: Schema.Schema<infer TCurrent, infer _TEncoded>;
  }
    ? TCurrent
    : never;

interface CompiledVersion {
  readonly decodeEnvelope: (
    input: unknown,
  ) => Effect.Effect<{ readonly payload: unknown; readonly v: number }, unknown>;
  readonly decodePayload: (input: unknown) => Effect.Effect<unknown, unknown>;
  readonly encodePayload: (input: unknown) => Effect.Effect<unknown, unknown>;
  readonly migrate?: (previous: unknown) => unknown;
  readonly version: number;
}

const HeaderSchema = Schema.Struct({ payload: Schema.Unknown, v: Schema.Number });
const decodeHeader = Schema.decodeUnknown(HeaderSchema, { onExcessProperty: "error" });
const strict: { readonly onExcessProperty: "error" } = { onExcessProperty: "error" };

const formatLocation = (locator: LineLocator | undefined): string => {
  if (locator?.file !== undefined && locator.line !== undefined) {
    return ` at ${locator.file}:${locator.line}`;
  }

  if (locator?.file !== undefined) {
    return ` at ${locator.file}`;
  }

  return locator?.line === undefined ? "" : ` at line ${locator.line}`;
};

const journalError = (
  corruptionClass: JournalCorruptionClass,
  detail: string,
  locator: LineLocator | undefined,
  cause: unknown,
): JournalError =>
  new JournalError({
    ...(cause === undefined ? {} : { cause }),
    ...(locator?.file === undefined ? {} : { file: locator.file }),
    corruptionClass,
    message: `${detail}${formatLocation(locator)}`,
  });

const schemaMismatch = (cause: unknown, locator: LineLocator | undefined): JournalError =>
  journalError("schema_mismatch", String(cause), locator, cause);

const compileVersion = <TCurrent, TEncoded>(
  registration: LineVersion<TCurrent, TEncoded>,
): CompiledVersion => {
  // An append-only store must reject unknown fields: dropping them on read is data loss
  // disguised as success. Newer writers use a version bump and therefore fail as unsupported.
  const envelope = Schema.Struct({
    payload: Schema.Unknown,
    v: Schema.Literal(registration.version),
  });

  return {
    decodeEnvelope: Schema.decodeUnknown(envelope, strict),
    decodePayload: Schema.decodeUnknown(registration.payloadSchema, strict),
    encodePayload: Schema.encodeUnknown(registration.payloadSchema, strict),
    ...(registration.migrate === undefined ? {} : { migrate: registration.migrate }),
    version: registration.version,
  };
};

const configError = (detail: string): JournalError =>
  journalError("schema_mismatch", `Invalid line codec config: ${detail}`, undefined, undefined);

const compileRegistry = (
  config: LineCodecConfig,
): Effect.Effect<Map<number, CompiledVersion>, JournalError> =>
  Effect.gen(function* () {
    const registry = new Map<number, CompiledVersion>();
    let lowestVersion = Number.POSITIVE_INFINITY;

    for (const registration of config.versions) {
      if (!Number.isInteger(registration.version) || registration.version <= 0) {
        return yield* Effect.fail(
          configError(`version ${registration.version} is not a positive integer.`),
        );
      }

      if (registry.has(registration.version)) {
        return yield* Effect.fail(
          configError(`version ${registration.version} is registered more than once.`),
        );
      }

      lowestVersion = Math.min(lowestVersion, registration.version);
      registry.set(registration.version, compileVersion(registration));
    }

    if (!registry.has(config.currentVersion)) {
      return yield* Effect.fail(
        configError(`current version ${config.currentVersion} has no registered schema.`),
      );
    }

    for (const registration of registry.values()) {
      if (registration.version > lowestVersion && registration.migrate === undefined) {
        return yield* Effect.fail(
          configError(`version ${registration.version} has no migration from its predecessor.`),
        );
      }
    }

    return registry;
  });

const createCompiledCodec = (current: CompiledVersion, registry: Map<number, CompiledVersion>) => ({
  decodeLine: (text: string, locator?: LineLocator) =>
    Effect.gen(function* () {
      const parsed = yield* Effect.try({
        catch: (cause) => journalError("malformed_json", String(cause), locator, cause),
        try: () => JSON.parse(text),
      });
      const header = yield* decodeHeader(parsed).pipe(
        Effect.mapError((cause) => schemaMismatch(cause, locator)),
      );

      if (header.v > current.version) {
        return yield* Effect.fail(
          journalError(
            "unsupported_version",
            `Journal line version ${header.v} is newer than current version ${current.version}.`,
            locator,
            undefined,
          ),
        );
      }

      const initial = registry.get(header.v);
      if (initial === undefined) {
        return yield* Effect.fail(
          journalError(
            "missing_migration",
            `No schema is registered for journal line version ${header.v}.`,
            locator,
            undefined,
          ),
        );
      }

      const decodedEnvelope = yield* initial
        .decodeEnvelope(parsed)
        .pipe(Effect.mapError((cause) => schemaMismatch(cause, locator)));
      let encodedPayload = decodedEnvelope.payload;

      for (
        let nextVersion = initial.version + 1;
        nextVersion <= current.version;
        nextVersion += 1
      ) {
        const next = registry.get(nextVersion);
        const migrate = next?.migrate;
        if (next === undefined || migrate === undefined) {
          return yield* Effect.fail(
            journalError(
              "missing_migration",
              `Migration chain from version ${initial.version} to version ${current.version} is missing version ${nextVersion}.`,
              locator,
              undefined,
            ),
          );
        }

        encodedPayload = yield* Effect.try({
          catch: (cause) =>
            journalError(
              "migration_failed",
              `Migration to version ${nextVersion} failed: ${String(cause)}`,
              locator,
              cause,
            ),
          try: () => migrate(encodedPayload),
        });
        yield* next
          .decodePayload(encodedPayload)
          .pipe(Effect.mapError((cause) => schemaMismatch(cause, locator)));
      }

      return yield* current
        .decodePayload(encodedPayload)
        .pipe(Effect.mapError((cause) => schemaMismatch(cause, locator)));
    }),
  encodeLine: (payload: unknown, locator?: LineLocator) =>
    Effect.gen(function* () {
      const encodedPayload = yield* current
        .encodePayload(payload)
        .pipe(Effect.mapError((cause) => schemaMismatch(cause, locator)));
      return JSON.stringify({ payload: encodedPayload, v: current.version });
    }),
});

export function createLineCodec<const TConfig extends LineCodecConfig>(
  config: TConfig,
): Effect.Effect<LineCodec<CurrentPayload<TConfig>>, JournalError>;
export function createLineCodec(
  config: LineCodecConfig,
): Effect.Effect<LineCodec<unknown>, JournalError> {
  return Effect.gen(function* () {
    const registry = yield* compileRegistry(config);
    const current = registry.get(config.currentVersion);

    if (current === undefined) {
      return yield* Effect.fail(
        configError(`current version ${config.currentVersion} has no registered schema.`),
      );
    }

    return createCompiledCodec(current, registry);
  });
}
