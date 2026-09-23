import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, expect, test } from "vitest";

import { Journal } from "./journal.js";
import { JournalJsonl } from "./jsonl.js";
import { migrateJsonlToSqlite } from "./migrate.js";
import { EntryDraftSchema } from "./shapes.js";
import { JournalSqlite } from "./sqlite.js";

const directories: Array<string> = [];

const makeDirectory = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "popeye-migrate-"));
  directories.push(dir);
  return dir;
};

const makeDirectorySync = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "popeye-migrate-"));
  directories.push(dir);
  return dir;
};
// reference to avoid unused error - used in afterEach cleanup via directories array
void makeDirectorySync;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { force: true, recursive: true })));
});

test("migrate bulk-imports acknowledged JSONL lines into journal.sqlite", async () => {
  const dir = await makeDirectory();

  // Create session via JSONL
  const jsonlSession = await Effect.runPromise(
    Effect.gen(function* () {
      const j = yield* Journal;
      const s = yield* j.createSession();
      yield* j.appendEntry(
        s.id,
        EntryDraftSchema.make({ kind: "user", payload: { text: "hello" } }),
      );
      yield* j.appendEntry(
        s.id,
        EntryDraftSchema.make({ kind: "assistant", payload: { text: "world" } }),
      );
      const branch = yield* j.readBranch(s.id);
      return { sessionId: s.id, branchLength: branch.length };
    }).pipe(Effect.provide(JournalJsonl(dir))),
  );

  // Migrate to sqlite
  const result = await Effect.runPromise(migrateJsonlToSqlite(dir));
  expect(result.filesMigrated).toBeGreaterThan(0);
  expect(result.migratedSessions).toContain(jsonlSession.sessionId as string);

  // Verify via sqlite that session is readable with same branch
  const sqliteBranch = await Effect.runPromise(
    Effect.gen(function* () {
      const j = yield* Journal;
      return yield* j.readBranch(jsonlSession.sessionId);
    }).pipe(Effect.provide(JournalSqlite(dir))),
  );

  expect(sqliteBranch.length).toBe(jsonlSession.branchLength);
});

test("migrate is idempotent - second run skips already migrated sessions", async () => {
  const dir = await makeDirectory();
  await Effect.runPromise(
    Effect.gen(function* () {
      const j = yield* Journal;
      const s = yield* j.createSession();
      yield* j.appendEntry(s.id, EntryDraftSchema.make({ kind: "user", payload: { text: "x" } }));
    }).pipe(Effect.provide(JournalJsonl(dir))),
  );

  const first = await Effect.runPromise(migrateJsonlToSqlite(dir));
  expect(first.migratedSessions.length).toBe(1);

  const second = await Effect.runPromise(migrateJsonlToSqlite(dir));
  expect(second.migratedSessions.length).toBe(0);
});

test("existing JSONL dirs untouched by default open - sqlite not created until migrate", async () => {
  const dir = await makeDirectory();
  await Effect.runPromise(
    Effect.gen(function* () {
      const j = yield* Journal;
      yield* j.createSession();
    }).pipe(Effect.provide(JournalJsonl(dir))),
  );

  const { existsSync } = await import("node:fs");
  expect(existsSync(join(dir, "journal.sqlite"))).toBe(false);

  // Opening via sqlite explicitly would create it, but default is jsonl - tested via selectJournalLayer elsewhere
});
