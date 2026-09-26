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
          requestId: "request-a",
          ownerId: "turn-a",
          purpose: "turn",
          attempt: 1,
          provider: "fixture",
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
      requestId: "request-a",
      outcome: "done",
    });
    expect(first.stdout).not.toContain("PRIVATE SENTINEL");
    expect(statSync(file).size).toBe(before);
    if (format === "jsonl") expect(readFileSync(file, "utf8")).toContain("PRIVATE SENTINEL");
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

test("direct CLI request reaches the Journal receipt and passive export", async () => {
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
      ["-p", "--session-dir", directory, "PRIVATE SENTINEL"],
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
    const exported = runBuiltBin(["usage", "export", "--session-dir", directory]);
    expect(exported.status, exported.stderr).toBe(0);
    const rows = exported.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "done",
      model: "fixture-model",
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
