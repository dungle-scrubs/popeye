/**
 * Owns the transcript mapping contract fixtures for the HCN reader arm.
 * It exists so harness-cli-normalizer verifies its popeye reader against
 * stable journal bytes plus the envelope mapping in docs/transcript-mapping.md.
 * These tests pin popeye's side of the contract: line order, kinds, roles,
 * parent links, and the torn-tail report.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { expect, test } from "vitest";

import { Journal } from "./journal.js";
import { JournalJsonl } from "./jsonl.js";
import { SessionIdSchema } from "./shapes.js";

const FIXTURE = new URL("../test-fixtures/transcript-source.jsonl", import.meta.url).pathname;
const TORN_FIXTURE = new URL("../test-fixtures/transcript-source-torn.jsonl", import.meta.url)
  .pathname;

test("transcript fixture exposes every envelope kind in durable order", async () => {
  const source = await readFile(FIXTURE, "utf8");
  const lines = source.trim().split("\n");
  expect(lines.length).toBe(24);
  const first = lines[0];
  if (first === undefined) {
    throw new Error("Transcript fixture is empty.");
  }
  expect(first).toContain("journal_header");

  const kinds = lines.slice(1).map((line) => {
    if (line === undefined) {
      return "missing";
    }
    const parsed = JSON.parse(line) as {
      payload: { item: { id: string; kind: string }; type: string };
    };
    return `${parsed.payload.type}:${parsed.payload.item.kind}`;
  });
  expect(kinds).toContain("entry:session_root");
  expect(kinds).toContain("entry:message");
  expect(kinds).toContain("entry:compaction");
  expect(kinds).toContain("record:operation_started");
  expect(kinds).toContain("record:operation_finished");
  expect(kinds).toContain("record:leaf_moved");
  expect(kinds).toContain("record:tool_started");

  // Every line names the header session.
  const header = JSON.parse(first) as { payload: { sessionId: string } };
  for (const line of lines.slice(1)) {
    if (line === undefined) {
      continue;
    }
    const parsed = JSON.parse(line) as { payload: { sessionId: string } };
    expect(parsed.payload.sessionId).toBe(header.payload.sessionId);
  }

  // Parent links form one chain per branch: every entry parent exists.
  const body = lines.slice(1).filter((line) => line !== undefined);
  const ids = new Set(
    body.map((line) => {
      const parsed = JSON.parse(line) as { payload: { item: { id: string }; type: string } };
      return parsed.payload.type === "entry" ? parsed.payload.item.id : null;
    }),
  );
  for (const line of body) {
    const parsed = JSON.parse(line) as {
      payload: { item: { kind: string; parentId: string | null }; type: string };
    };
    if (parsed.payload.type === "entry" && parsed.payload.item.parentId !== null) {
      expect(ids.has(parsed.payload.item.parentId)).toBe(true);
    }
  }
});

test("transcript fixture reads back intact through the export path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "popeye-transcript-"));
  const source = await readFile(FIXTURE, "utf8");
  const headerLine = source.split("\n")[0] ?? "";
  const sessionId = SessionIdSchema.make(
    (JSON.parse(headerLine) as { payload: { sessionId: string } }).payload.sessionId,
  );
  await writeFile(join(directory, `${sessionId}.jsonl`), source);
  const exported = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      return yield* journal.readExport(sessionId);
    }).pipe(Effect.provide(JournalJsonl(directory))),
  );
  expect(exported.incompleteTail).toBe(false);
  expect(exported.lines).toHaveLength(23);
  expect(exported.header.sessionId).toBe(sessionId);
});

test("torn transcript fixture reports its tail without repair", async () => {
  const torn = await readFile(TORN_FIXTURE, "utf8");
  const source = await readFile(FIXTURE, "utf8");
  expect(torn.endsWith("\n")).toBe(false);
  expect(torn.startsWith(source)).toBe(true);
});

test("suppressed repair reports a pre-torn tail through the export path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "popeye-transcript-"));
  const torn = await readFile(TORN_FIXTURE, "utf8");
  const headerLine = torn.split("\n")[0] ?? "";
  const sessionId = SessionIdSchema.make(
    (JSON.parse(headerLine) as { payload: { sessionId: string } }).payload.sessionId,
  );
  await writeFile(join(directory, `${sessionId}.jsonl`), torn);
  const exported = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      return yield* journal.readExport(sessionId);
    }).pipe(Effect.provide(JournalJsonl(directory, { suppressRepair: true }))),
  );
  expect(exported.incompleteTail).toBe(true);
  expect(exported.lines).toHaveLength(23);
  await expect(readFile(join(directory, `${sessionId}.jsonl`), "utf8")).resolves.toBe(torn);
});

test("acknowledged prefix digest is stable for bookmark revalidation", async () => {
  const source = await readFile(FIXTURE, "utf8");
  // The fixture is intact, so offset is the full length and the digest
  // covers every byte.
  const digest = createHash("sha256").update(source).digest("hex");
  // Pinned so the HCN reader arm detects any byte change in the fixture.
  expect(digest).toBe("0a019f208d132e30e532a1acc80cbc298b97616bd9177a43f686539b37929f49");
  expect(/^[a-f0-9]{64}$/.test(digest)).toBe(true);
});
