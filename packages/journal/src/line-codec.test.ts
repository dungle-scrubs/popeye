import { Effect, Schema } from "effect";
import { expect, test } from "vitest";

import { createLineCodec } from "./line-codec.js";

test("decoding an older-version line with a missing migration fails with the typed migration error naming both versions", async () => {
  const codec = createLineCodec({
    currentVersion: 3,
    versions: [
      {
        payloadSchema: Schema.Struct({ title: Schema.String }),
        version: 1,
      },
      {
        payloadSchema: Schema.Struct({ title: Schema.String, wordCount: Schema.Number }),
        version: 3,
      },
    ],
  });

  const error = await Effect.runPromise(
    Effect.flip(codec.decodeLine('{"v":1,"payload":{"title":"draft"}}')),
  );

  expect(error).toMatchObject({
    _tag: "JournalError",
    corruptionClass: "missing_migration",
  });
  expect(error.message).toContain("version 1");
  expect(error.message).toContain("version 3");
});

test("encoded journal lines carry a schema version envelope", async () => {
  const codec = createLineCodec({
    currentVersion: 1,
    versions: [
      {
        payloadSchema: Schema.Struct({ title: Schema.String }),
        version: 1,
      },
    ],
  });

  const encoded = await Effect.runPromise(codec.encodeLine({ title: "draft" }));

  expect(JSON.parse(encoded)).toEqual({ v: 1, payload: { title: "draft" } });
});

test("decoding a current-version line yields the typed value", async () => {
  const codec = createLineCodec<{ readonly title: string }>({
    currentVersion: 1,
    versions: [
      {
        payloadSchema: Schema.Struct({ title: Schema.String }),
        version: 1,
      },
    ],
  });

  await expect(
    Effect.runPromise(codec.decodeLine('{"v":1,"payload":{"title":"draft"}}')),
  ).resolves.toEqual({ title: "draft" });
});

test("decoding an older-version line runs its registered migration chain", async () => {
  const codec = createLineCodec<{ readonly title: string; readonly wordCount: number }>({
    currentVersion: 2,
    versions: [
      {
        payloadSchema: Schema.Struct({ title: Schema.String }),
        version: 1,
      },
      {
        migrate: (previous) => {
          const decoded = previous as { readonly title: string };
          return { title: decoded.title, wordCount: decoded.title.length };
        },
        payloadSchema: Schema.Struct({ title: Schema.String, wordCount: Schema.Number }),
        version: 2,
      },
    ],
  });

  await expect(
    Effect.runPromise(codec.decodeLine('{"v":1,"payload":{"title":"draft"}}')),
  ).resolves.toEqual({ title: "draft", wordCount: 5 });
});

test("decoding malformed JSON fails typed, never throws", async () => {
  const codec = createLineCodec({
    currentVersion: 1,
    versions: [
      {
        payloadSchema: Schema.Struct({ title: Schema.String }),
        version: 1,
      },
    ],
  });

  const error = await Effect.runPromise(Effect.flip(codec.decodeLine("{")));

  expect(error).toMatchObject({
    _tag: "JournalError",
    corruptionClass: "malformed_json",
  });
});

test("decoding a schema mismatch fails typed with the Schema parse detail", async () => {
  const codec = createLineCodec({
    currentVersion: 1,
    versions: [
      {
        payloadSchema: Schema.Struct({ title: Schema.String }),
        version: 1,
      },
    ],
  });

  const error = await Effect.runPromise(
    Effect.flip(codec.decodeLine('{"v":1,"payload":{"title":7}}')),
  );

  expect(error).toMatchObject({
    _tag: "JournalError",
    corruptionClass: "schema_mismatch",
  });
  expect(error.message).toContain("title");
});

test("the codec supports a second toy payload schema", async () => {
  const codec = createLineCodec<{ readonly completed: boolean; readonly priority: number }>({
    currentVersion: 1,
    versions: [
      {
        payloadSchema: Schema.Struct({ completed: Schema.Boolean, priority: Schema.Number }),
        version: 1,
      },
    ],
  });

  await expect(
    Effect.runPromise(codec.decodeLine('{"v":1,"payload":{"completed":true,"priority":2}}')),
  ).resolves.toEqual({ completed: true, priority: 2 });
});
