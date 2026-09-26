import { RecordIdSchema, RecordSchema, SessionIdSchema } from "@dungle-scrubs/popeye-journal";
import { expect, test } from "vitest";

import { accountingRows, countsFromPiAi } from "./request-accounting.js";

const sessionId = SessionIdSchema.make("session-a");
const start = {
  version: 1 as const,
  sessionId,
  requestId: "request-a",
  ownerId: "turn-a",
  purpose: "turn" as const,
  attempt: 1,
  provider: "fixture",
  model: "fixture-model",
  startedAt: "2026-09-26T00:00:00.000Z",
};

const record = (id: string, kind: string, payload: unknown) =>
  RecordSchema.make({ id: RecordIdSchema.make(id), kind, payload });

test("normalized positive counts remain distinct and ambiguous zeros stay unknown", () => {
  expect(countsFromPiAi({ input: 31, output: 4, cacheRead: 0, cacheWrite: 0 })).toEqual({
    input: { status: "normalized", value: 31, mapping: "pi-ai@0.84.1" },
    output: { status: "normalized", value: 4, mapping: "pi-ai@0.84.1" },
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
    { requestId: "request-a", outcome: "pending", completedAt: null },
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
  expect(rows[0]).toMatchObject({ requestId: "request-a", outcome: "error" });
  expect(JSON.stringify(rows)).not.toContain("PRIVATE SENTINEL");
  expect(() => accountingRows(sessionId, [started, terminal, terminal])).toThrow(
    "ACCOUNTING_INTEGRITY",
  );
});
