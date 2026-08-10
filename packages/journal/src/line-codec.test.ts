import { Effect, Schema } from "effect";
import { expect, test } from "vitest";

import { createLineCodec } from "./line-codec.js";

test("decodes a multi-hop line by migrating encoded payloads in ascending order", async () => {
  const migrations: Array<number> = [];
  const codec = await Effect.runPromise(
    createLineCodec({
      currentVersion: 3,
      versions: [
        {
          payloadSchema: Schema.Struct({ title: Schema.String }),
          version: 1,
        },
        {
          migrate: () => {
            migrations.push(2);
            return { title: "draft", wordCount: "5" };
          },
          payloadSchema: Schema.Struct({
            title: Schema.String,
            wordCount: Schema.NumberFromString,
          }),
          version: 2,
        },
        {
          migrate: () => {
            migrations.push(3);
            return { status: "open", title: "draft", wordCount: "5" };
          },
          payloadSchema: Schema.Struct({
            status: Schema.String,
            title: Schema.String,
            wordCount: Schema.NumberFromString,
          }),
          version: 3,
        },
      ],
    }),
  );

  await expect(
    Effect.runPromise(codec.decodeLine('{"v":1,"payload":{"title":"draft"}}')),
  ).resolves.toEqual({ status: "open", title: "draft", wordCount: 5 });
  expect(migrations).toEqual([2, 3]);
});

test("rejects a migration intermediate that does not match that version's encoded schema", async () => {
  const codec = await Effect.runPromise(
    createLineCodec({
      currentVersion: 3,
      versions: [
        {
          payloadSchema: Schema.Struct({ title: Schema.String }),
          version: 1,
        },
        {
          migrate: () => ({ title: "draft", wordCount: 5 }),
          payloadSchema: Schema.Struct({
            title: Schema.String,
            wordCount: Schema.NumberFromString,
          }),
          version: 2,
        },
        {
          migrate: () => ({ status: "open", title: "draft", wordCount: "5" }),
          payloadSchema: Schema.Struct({
            status: Schema.String,
            title: Schema.String,
            wordCount: Schema.NumberFromString,
          }),
          version: 3,
        },
      ],
    }),
  );

  const error = await Effect.runPromise(
    Effect.flip(codec.decodeLine('{"v":1,"payload":{"title":"draft"}}')),
  );

  expect(error).toMatchObject({
    _tag: "JournalError",
    corruptionClass: "schema_mismatch",
  });
  expect(error.cause).toBeDefined();
});

test("rejects a future-version line as unsupported", async () => {
  const codec = await Effect.runPromise(
    createLineCodec({
      currentVersion: 1,
      versions: [{ payloadSchema: Schema.Struct({ title: Schema.String }), version: 1 }],
    }),
  );

  const error = await Effect.runPromise(
    Effect.flip(codec.decodeLine('{"v":2,"payload":{"title":"draft"}}')),
  );

  expect(error.corruptionClass).toBe("unsupported_version");
});

test("round-trips a transforming current schema in the domain-to-wire direction", async () => {
  const payloadSchema = Schema.Struct({
    createdAt: Schema.Date,
    retries: Schema.NumberFromString,
  });
  const codec = await Effect.runPromise(
    createLineCodec({ currentVersion: 1, versions: [{ payloadSchema, version: 1 }] }),
  );
  const payload = { createdAt: new Date("2026-08-10T00:00:00.000Z"), retries: 2 };

  // @ts-expect-error The codec derives its domain type from the current transforming schema.
  codec.encodeLine({ createdAt: "2026-08-10T00:00:00.000Z", retries: "2" });

  const encoded = await Effect.runPromise(codec.encodeLine(payload));
  expect(JSON.parse(encoded)).toEqual({
    payload: { createdAt: "2026-08-10T00:00:00.000Z", retries: "2" },
    v: 1,
  });
  await expect(Effect.runPromise(codec.decodeLine(encoded))).resolves.toEqual(payload);
});

test("rejects unknown envelope and payload fields as schema mismatches", async () => {
  const codec = await Effect.runPromise(
    createLineCodec({
      currentVersion: 1,
      versions: [{ payloadSchema: Schema.Struct({ title: Schema.String }), version: 1 }],
    }),
  );

  const envelopeError = await Effect.runPromise(
    Effect.flip(codec.decodeLine('{"extra":true,"v":1,"payload":{"title":"draft"}}')),
  );
  const payloadError = await Effect.runPromise(
    Effect.flip(codec.decodeLine('{"v":1,"payload":{"extra":true,"title":"draft"}}')),
  );

  expect(envelopeError.corruptionClass).toBe("schema_mismatch");
  expect(payloadError.corruptionClass).toBe("schema_mismatch");
});

test("rejects invalid codec registries through the typed error channel", async () => {
  const schema = Schema.Struct({ title: Schema.String });
  const invalidConfigs = [
    {
      currentVersion: 1,
      name: "duplicate versions",
      versions: [
        { payloadSchema: schema, version: 1 },
        { payloadSchema: schema, version: 1 },
      ],
    },
    {
      currentVersion: 2,
      name: "missing current version",
      versions: [{ payloadSchema: schema, version: 1 }],
    },
    {
      currentVersion: 2,
      name: "migration gap",
      versions: [
        { payloadSchema: schema, version: 1 },
        { payloadSchema: schema, version: 2 },
      ],
    },
    {
      currentVersion: 0,
      name: "zero version",
      versions: [{ payloadSchema: schema, version: 0 }],
    },
  ];

  for (const config of invalidConfigs) {
    const error = await Effect.runPromise(Effect.flip(createLineCodec(config)));

    expect(error.corruptionClass, config.name).toBe("schema_mismatch");
    expect(error.message, config.name).toContain("Invalid line codec config");
  }
});

test("reports throwing migrations as migration failures and retains the locator", async () => {
  const codec = await Effect.runPromise(
    createLineCodec({
      currentVersion: 2,
      versions: [
        { payloadSchema: Schema.Struct({ title: Schema.String }), version: 1 },
        {
          migrate: () => {
            throw new Error("broken migration");
          },
          payloadSchema: Schema.Struct({ title: Schema.String }),
          version: 2,
        },
      ],
    }),
  );

  const error = await Effect.runPromise(
    Effect.flip(
      codec.decodeLine('{"v":1,"payload":{"title":"draft"}}', {
        file: "/tmp/journal.jsonl",
        line: 7,
      }),
    ),
  );

  expect(error).toMatchObject({
    corruptionClass: "migration_failed",
    file: "/tmp/journal.jsonl",
  });
  expect(error.message).toContain("/tmp/journal.jsonl:7");
});

test("decoding malformed JSON fails typed as malformed_json, never throws", async () => {
  const codec = await Effect.runPromise(
    createLineCodec({
      currentVersion: 1,
      versions: [{ payloadSchema: Schema.Struct({ title: Schema.String }), version: 1 }],
    }),
  );

  const error = await Effect.runPromise(
    Effect.flip(
      codec.decodeLine('{"v":1,"payload":{brokenjson', { file: "sessions/a.jsonl", line: 7 }),
    ),
  );

  expect(error._tag).toBe("JournalError");
  expect(error.corruptionClass).toBe("malformed_json");
  expect(error.file).toBe("sessions/a.jsonl");
});
