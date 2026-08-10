/**
 * Owns the version transition for durable journal lines before they enter journal code.
 * It exists so schema changes remain explicit instead of making old acknowledged lines ambiguous.
 */
import { Effect, Schema } from "effect";

import { JournalError } from "./errors.js";

export interface LineVersion {
  readonly migrate?: (previous: unknown) => unknown;
  readonly payloadSchema: Schema.Schema.AnyNoContext;
  readonly version: number;
}

export interface LineCodecConfig {
  readonly currentVersion: number;
  readonly versions: ReadonlyArray<LineVersion>;
}

export interface LineCodec<TCurrent> {
  readonly decodeLine: (text: string) => Effect.Effect<TCurrent, JournalError>;
  readonly encodeLine: (payload: TCurrent) => Effect.Effect<string, JournalError>;
}

const VersionHeader = Schema.Struct({ v: Schema.Number });

const schemaMismatch = (detail: unknown): JournalError =>
  new JournalError({
    corruptionClass: "schema_mismatch",
    message: String(detail),
  });

const envelopeSchema = (registration: LineVersion) =>
  Schema.Struct({
    payload: registration.payloadSchema,
    v: Schema.Literal(registration.version),
  });

const currentRegistration = (config: LineCodecConfig): Effect.Effect<LineVersion, JournalError> => {
  const registration = config.versions.find(
    (candidate) => candidate.version === config.currentVersion,
  );

  return registration === undefined
    ? Effect.fail(
        new JournalError({
          corruptionClass: "schema_mismatch",
          message: `No schema is registered for current version ${config.currentVersion}.`,
        }),
      )
    : Effect.succeed(registration);
};

export const createLineCodec = <TCurrent = unknown>(
  config: LineCodecConfig,
): LineCodec<TCurrent> => ({
  decodeLine: (text) =>
    Effect.gen(function* () {
      const parsed = yield* Effect.try({
        catch: (cause) =>
          new JournalError({
            corruptionClass: "malformed_json",
            message: String(cause),
          }),
        try: () => JSON.parse(text) as unknown,
      });
      const header = yield* Schema.decodeUnknown(VersionHeader)(parsed).pipe(
        Effect.mapError(schemaMismatch),
      );
      const initial = config.versions.find((registration) => registration.version === header.v);

      if (initial === undefined || header.v > config.currentVersion) {
        return yield* Effect.fail(
          new JournalError({
            corruptionClass: "schema_mismatch",
            message: `No schema is registered for line version ${header.v}.`,
          }),
        );
      }

      const decoded = yield* Schema.decodeUnknown(envelopeSchema(initial))(parsed).pipe(
        Effect.mapError(schemaMismatch),
      );
      let payload: unknown = decoded.payload;

      for (let nextVersion = header.v + 1; nextVersion <= config.currentVersion; nextVersion += 1) {
        const next = config.versions.find((registration) => registration.version === nextVersion);
        const migrate = next?.migrate;
        if (next === undefined || migrate === undefined) {
          return yield* Effect.fail(
            new JournalError({
              corruptionClass: "missing_migration",
              message: `Migration chain from version ${header.v} to version ${config.currentVersion} is missing version ${nextVersion}.`,
            }),
          );
        }

        const migrated = yield* Effect.try({
          catch: schemaMismatch,
          try: () => migrate(payload),
        });
        payload = yield* Schema.decodeUnknown(next.payloadSchema)(migrated).pipe(
          Effect.mapError(schemaMismatch),
        );
      }

      return payload as TCurrent;
    }),
  encodeLine: (payload) =>
    Effect.gen(function* () {
      const registration = yield* currentRegistration(config);
      const envelope = yield* Schema.decodeUnknown(envelopeSchema(registration))({
        payload,
        v: config.currentVersion,
      }).pipe(Effect.mapError(schemaMismatch));
      const line = yield* Effect.try({
        catch: (cause) =>
          new JournalError({
            corruptionClass: "schema_mismatch",
            message: String(cause),
          }),
        try: () => JSON.stringify(envelope),
      });

      return yield* line === undefined
        ? Effect.fail(
            new JournalError({
              corruptionClass: "schema_mismatch",
              message: "The validated line could not be encoded as JSON.",
            }),
          )
        : Effect.succeed(line);
    }),
});
