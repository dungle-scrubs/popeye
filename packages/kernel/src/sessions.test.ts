import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryJournalBacking,
  EntryDraftSchema,
  Journal,
  JournalJsonl,
  JournalMemory,
  RecordDraftSchema,
} from "@peye/journal";
import { Effect, Layer } from "effect";
import { expect, test } from "vitest";

import { MailboxLive } from "./mailbox.js";
import { Sessions, SessionsLive } from "./sessions.js";

test("create opens a journal-backed session at the root revision", async () => {
  const backing = createMemoryJournalBacking();
  const layer = SessionsLive.pipe(
    Layer.provide(MailboxLive),
    Layer.provide(JournalMemory(backing)),
  );

  const created = await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      return yield* sessions.create();
    }).pipe(Effect.provide(layer)),
  );

  expect(created).toMatchObject({ revision: 1 });
  expect(created.id).toEqual(expect.any(String));
  expect(created.leaf.id).toEqual(expect.any(String));
  expect(created.leaf.kind).toBe("session_root");
});

test("resume restores the journal leaf and count of durable lines", async () => {
  const backing = createMemoryJournalBacking();
  const makeLayer = () =>
    SessionsLive.pipe(Layer.provide(MailboxLive), Layer.provide(JournalMemory(backing)));
  const created = await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      return yield* sessions.create();
    }).pipe(Effect.provide(makeLayer())),
  );

  const leaf = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const entry = yield* journal.appendEntry(
        created.id,
        EntryDraftSchema.make({ kind: "user_input", payload: { text: "hello" } }),
      );
      yield* journal.appendRecord(
        created.id,
        RecordDraftSchema.make({ kind: "command_started", payload: {} }),
      );
      return entry;
    }).pipe(Effect.provide(JournalMemory(backing))),
  );

  const resumed = await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      return yield* sessions.resume(created.id);
    }).pipe(Effect.provide(makeLayer())),
  );

  expect(resumed).toMatchObject({ id: created.id, leaf: { id: leaf.id }, revision: 3 });
});

test("list reports every journal-backed session with its revision", async () => {
  const backing = createMemoryJournalBacking();
  const layer = SessionsLive.pipe(
    Layer.provide(MailboxLive),
    Layer.provide(JournalMemory(backing)),
  );

  const listed = await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const first = yield* sessions.create();
      const second = yield* sessions.create();
      const listed = yield* sessions.list();
      return { first, listed, second };
    }).pipe(Effect.provide(layer)),
  );

  expect(listed.listed).toEqual([
    { id: listed.first.id, revision: 1 },
    { id: listed.second.id, revision: 1 },
  ]);
});

test("create and resume work with the JSONL journal layer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peye-kernel-m7-"));
  const makeLayer = () =>
    SessionsLive.pipe(Layer.provide(MailboxLive), Layer.provide(JournalJsonl(directory)));

  const created = await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      return yield* sessions.create();
    }).pipe(Effect.provide(makeLayer())),
  );
  const resumed = await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      return yield* sessions.resume(created.id);
    }).pipe(Effect.provide(makeLayer())),
  );
  await rm(directory, { force: true, recursive: true });

  expect(resumed).toMatchObject({ id: created.id, revision: 1 });
});
