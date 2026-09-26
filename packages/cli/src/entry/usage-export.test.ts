import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  Journal,
  JournalJsonl,
  JournalSqlite,
  RecordDraftSchema,
} from "@dungle-scrubs/popeye-journal";
import { Effect } from "effect";
import { afterEach, expect, test } from "vitest";

import { cleanCliEnvironment, runBuiltBin } from "../test-support/cli.js";
import { executeCli } from "./cli-entry.js";

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

for (const format of ["jsonl", "sqlite"] as const) {
  test(`usage export reads ${format} passively and excludes private Journal content`, async () => {
    const directory = mkdtempSync(join(tmpdir(), `popeye-usage-${format}-`));
    directories.push(directory);
    const sessionId = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal;
        const session = yield* journal.createSession();
        const start = {
          version: 1,
          sessionId: session.id,
          requestId: "11111111-1111-4111-8111-111111111111",
          ownerId: "22222222-2222-4222-8222-222222222222",
          purpose: "turn",
          attempt: 1,
          provider: "fixture",
          providerClass: "unknown",
          model: "fixture-model",
          startedAt: "2026-09-26T00:00:00.000Z",
        };
        yield* journal.appendRecord(
          session.id,
          RecordDraftSchema.make({
            kind: "private_note",
            payload: { content: "PRIVATE SENTINEL" },
          }),
        );
        yield* journal.appendRecord(
          session.id,
          RecordDraftSchema.make({ kind: "provider_request_started", payload: start }),
        );
        yield* journal.appendRecord(
          session.id,
          RecordDraftSchema.make({
            kind: "provider_request_usage",
            payload: {
              ...start,
              completedAt: "2026-09-26T00:00:01.000Z",
              outcome: "done",
              attemptGranularity: "provider-invocation",
              counts: {
                input: { status: "normalized", value: 31, mapping: "pi-ai@0.84.1" },
                output: { status: "normalized", value: 4, mapping: "pi-ai@0.84.1" },
                cacheRead: { status: "unknown", reason: "ambiguous_zero" },
                cacheWrite: { status: "unknown", reason: "ambiguous_zero" },
                cacheWrite1h: { status: "unknown", reason: "absent" },
                reasoning: { status: "unknown", reason: "absent" },
              },
            },
          }),
        );
        return session.id;
      }).pipe(
        Effect.provide(format === "sqlite" ? JournalSqlite(directory) : JournalJsonl(directory)),
      ),
    );
    const file =
      format === "sqlite"
        ? join(directory, "journal.sqlite")
        : join(directory, `${sessionId}.jsonl`);
    const before = statSync(file).size;
    const first = runBuiltBin(["usage", "export", "--session-dir", directory]);
    const second = runBuiltBin(["usage", "export", "--session-dir", directory]);
    expect(first.status).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toBe(second.stdout);
    expect(JSON.parse(first.stdout)).toMatchObject({
      sessionId,
      requestId: "11111111-1111-4111-8111-111111111111",
      outcome: "done",
    });
    expect(first.stdout).not.toContain("PRIVATE SENTINEL");
    expect(statSync(file).size).toBe(before);
    if (format === "jsonl") expect(readFileSync(file, "utf8")).toContain("PRIVATE SENTINEL");

    await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal;
        yield* journal.appendRecord(
          sessionId,
          RecordDraftSchema.make({
            kind: "provider_request_started",
            payload: {
              version: 1,
              sessionId,
              requestId: "33333333-3333-4333-8333-333333333333",
              ownerId: "44444444-4444-4444-8444-444444444444",
              purpose: "turn",
              attempt: 1,
              provider: "fixture",
              providerClass: "unknown",
              model: "PRIVATE SENTINEL",
              startedAt: "2026-09-26T00:00:00.000Z",
            },
          }),
        );
      }).pipe(
        Effect.provide(format === "sqlite" ? JournalSqlite(directory) : JournalJsonl(directory)),
      ),
    );
    const invalid = runBuiltBin(["usage", "export", "--session-dir", directory]);
    expect(invalid.status).toBe(4);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toBe("ERROR ACCOUNTING_READ_FAILED\n");
    expect(invalid.stderr).not.toContain("PRIVATE SENTINEL");
  });
}

test("torn JSONL tail fails export without repair or leaking its content", async () => {
  const directory = mkdtempSync(join(tmpdir(), "popeye-usage-torn-"));
  directories.push(directory);
  const sessionId = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      return (yield* journal.createSession()).id;
    }).pipe(Effect.provide(JournalJsonl(directory))),
  );
  const file = join(directory, `${sessionId}.jsonl`);
  appendFileSync(file, "PRIVATE SENTINEL");
  const before = readFileSync(file, "utf8");
  const result = runBuiltBin(["usage", "export", "--session-dir", directory]);
  expect(result.status).toBe(4);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("ERROR ACCOUNTING_INCOMPLETE_TAIL\n");
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("direct and HCN CLI requests reach distinct Journal receipts and passive export", async () => {
  const directory = mkdtempSync(join(tmpdir(), "popeye-usage-live-fixture-"));
  directories.push(directory);
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [], usage: { prompt_tokens: 31, completion_tokens: 4, total_tokens: 35 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No fixture listener");
    const run = async (mode: "print" | "hcn") => {
      const input = new PassThrough();
      input.end();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let output = "";
      let errors = "";
      stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      stderr.on("data", (chunk: Buffer) => {
        errors += chunk.toString();
      });
      const code = await executeCli(
        ["-p", "--mode", mode, "--session-dir", directory, "PRIVATE SENTINEL"],
        {
          ...cleanCliEnvironment(),
          POPEYE_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          POPEYE_MODEL: "fixture-model",
          POPEYE_USER_PLUGIN_DIR: join(directory, "plugins"),
        },
        { input, stdout, stderr },
      );
      expect(code, errors).toBe(0);
      expect(output).toContain("ok");
    };
    await run("print");
    await run("hcn");
    const exported = runBuiltBin(["usage", "export", "--session-dir", directory]);
    expect(exported.status, exported.stderr).toBe(0);
    const rows = exported.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.requestId)).size).toBe(2);
    for (const row of rows)
      expect(row).toMatchObject({
        outcome: "done",
        model: "fixture-model",
        provider: "openai-compatible",
        providerClass: "local",
        counts: {
          input: { status: "normalized", value: 31 },
          output: { status: "normalized", value: 4 },
        },
      });
    expect(exported.stdout).not.toContain("PRIVATE SENTINEL");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15_000);
