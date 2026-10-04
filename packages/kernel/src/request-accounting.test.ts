import { readFile } from "node:fs/promises";
import { RecordIdSchema, RecordSchema, SessionIdSchema } from "@dungle-scrubs/popeye-journal";
import { Schema } from "effect";
import { expect, test } from "vitest";

import {
  accountingRows,
  countsFromPiAi,
  PI_AI_FAUX_MAPPING,
  PI_AI_MAPPING,
} from "./request-accounting.js";

const sessionId = SessionIdSchema.make("AAAAAAAAAAAAAAAA");
const start = {
  version: 1 as const,
  sessionId,
  requestId: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222",
  purpose: "turn" as const,
  attempt: 1,
  provider: "fixture",
  providerClass: "unknown" as const,
  model: "fixture-model",
  startedAt: "2026-09-26T00:00:00.000Z",
};

const record = (id: string, kind: string, payload: unknown) =>
  RecordSchema.make({ id: RecordIdSchema.make(id), kind, payload });

test("normalized positive counts remain distinct and ambiguous zeros stay unknown", () => {
  expect(countsFromPiAi({ input: 31, output: 4, cacheRead: 0, cacheWrite: 0 })).toEqual({
    input: { status: "normalized", value: 31, mapping: "pi-ai@1.0.2" },
    output: { status: "normalized", value: 4, mapping: "pi-ai@1.0.2" },
    cacheRead: { status: "unknown", reason: "ambiguous_zero" },
    cacheWrite: { status: "unknown", reason: "ambiguous_zero" },
    cacheWrite1h: { status: "unknown", reason: "absent" },
    reasoning: { status: "unknown", reason: "absent" },
  });
});

test("pending start is replaced by one terminal receipt and content is excluded", () => {
  const started = record("record-a", "provider_request_started", start);
  const pending = accountingRows(sessionId, [started]);
  expect(pending).toMatchObject([
    { requestId: start.requestId, outcome: "pending", completedAt: null },
  ]);
  const terminal = record("record-b", "provider_request_usage", {
    ...start,
    completedAt: "2026-09-26T00:00:01.000Z",
    outcome: "error",
    counts: countsFromPiAi({ input: 31, output: 4, cacheRead: 0, cacheWrite: 0 }),
    attemptGranularity: "provider-invocation",
  });
  const rows = accountingRows(sessionId, [
    record("private", "message", { content: "PRIVATE SENTINEL" }),
    started,
    terminal,
  ]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ requestId: start.requestId, outcome: "error" });
  expect(JSON.stringify(rows)).not.toContain("PRIVATE SENTINEL");
  expect(() => accountingRows(sessionId, [started, terminal, terminal])).toThrow(
    "ACCOUNTING_INTEGRITY",
  );
});

test("every exported string field rejects free-form content and endpoint URLs", () => {
  const invalid = [
    { sessionId: "PRIVATE SENTINEL" },
    { requestId: "PRIVATE SENTINEL" },
    { ownerId: "PRIVATE SENTINEL" },
    { provider: "https://secret.example/v1" },
    { model: "PRIVATE SENTINEL" },
    { startedAt: "PRIVATE SENTINEL" },
    { providerClass: "PRIVATE SENTINEL" },
  ];
  for (const mutation of invalid) {
    expect(() =>
      accountingRows(sessionId, [
        record("bad", "provider_request_started", { ...start, ...mutation }),
      ]),
    ).toThrow();
  }
  const terminal = {
    ...start,
    completedAt: "PRIVATE SENTINEL",
    outcome: "done",
    counts: countsFromPiAi(undefined),
    attemptGranularity: "provider-invocation",
  };
  expect(() =>
    accountingRows(sessionId, [
      record("start", "provider_request_started", start),
      record("end", "provider_request_usage", terminal),
    ]),
  ).toThrow();
});

test("legacy normalized and estimated receipt labels still decode", () => {
  const counts = {
    ...countsFromPiAi(undefined),
    input: { status: "normalized", value: 31, mapping: "pi-ai@0.84.1" },
    output: { status: "estimated", value: 4, mapping: "pi-ai-faux@0.84.1" },
  };
  expect(
    accountingRows(sessionId, [
      record("legacy-start", "provider_request_started", start),
      record("legacy-end", "provider_request_usage", {
        ...start,
        completedAt: "2026-09-26T00:00:01.000Z",
        outcome: "done",
        counts,
        attemptGranularity: "provider-invocation",
      }),
    ])[0]?.counts,
  ).toEqual(counts);
});

test("accounting mapping labels match the exact pinned pi-ai version", async () => {
  const packageJson: unknown = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const { dependencies } = Schema.decodeUnknownSync(
    Schema.Struct({
      dependencies: Schema.Struct({ "@earendil-works/pi-ai": Schema.String }),
    }),
  )(packageJson);
  const version = dependencies["@earendil-works/pi-ai"];
  expect(version).toMatch(/^\d+\.\d+\.\d+$/u);
  expect(PI_AI_MAPPING).toBe(`pi-ai@${version}`);
  expect(PI_AI_FAUX_MAPPING).toBe(`pi-ai-faux@${version}`);
});
