import { mkdtempSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, expect, test } from "vitest";
import { Journal } from "./journal.js";
import { describeJournalContract } from "./journal-contract.js";
import { createJsonlJournalHarness, JournalJsonl } from "./jsonl.js";
import { EntryDraftSchema } from "./shapes.js";

const directories: Array<string> = [];

const makeDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "peye-journal-"));
  directories.push(directory);
  return directory;
};

const makeDirectorySync = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "peye-journal-"));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

test("createSession acknowledges only after its header and root entry are on disk", async () => {
  const directory = await makeDirectory();
  const session = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      return yield* journal.createSession();
    }).pipe(Effect.provide(JournalJsonl(directory))),
  );

  const stored = await readFile(join(directory, `${session.id}.jsonl`), "utf8");

  expect(stored.endsWith("\n")).toBe(true);
  expect(stored.trimEnd().split("\n")).toHaveLength(2);
});

test("appendEntry acknowledges only after its versioned line is on disk", async () => {
  const directory = await makeDirectory();
  const { entry, session } = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      const entry = yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({ kind: "user_input", payload: {} }),
      );
      return { entry, session };
    }).pipe(Effect.provide(JournalJsonl(directory))),
  );

  const lines = (await readFile(join(directory, `${session.id}.jsonl`), "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as { payload: { item?: { id: string } }; v: number });

  expect(lines).toHaveLength(3);
  expect(lines.every((line) => line.v === 1)).toBe(true);
  expect(lines[2]?.payload.item?.id).toBe(entry.id);
});

test("open discards only a torn unacknowledged tail and reports recovery", async () => {
  const directory = await makeDirectory();
  const initial = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      return yield* journal.createSession();
    }).pipe(Effect.provide(JournalJsonl(directory))),
  );
  const file = join(directory, `${initial.id}.jsonl`);
  const acknowledged = await readFile(file, "utf8");
  await appendFile(file, '{"v":1,"payload":');
  const diagnostics: Array<unknown> = [];

  const reopened = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      return yield* journal.getLeaf(initial.id);
    }).pipe(
      Effect.provide(
        JournalJsonl(directory, {
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
        }),
      ),
    ),
  );

  expect(reopened).toEqual(initial.rootEntry);
  await expect(readFile(file, "utf8")).resolves.toBe(acknowledged);
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ action: "recovered_torn_tail", file }),
  );
});

test("open rejects an acknowledged invalid record sequence without changing its file", async () => {
  const directory = await makeDirectory();
  const initial = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      return yield* journal.createSession();
    }).pipe(Effect.provide(JournalJsonl(directory))),
  );
  const file = join(directory, `${initial.id}.jsonl`);
  const [header, root] = (await readFile(file, "utf8")).trimEnd().split("\n");
  const firstId = "first";
  const invalidFile = [
    header,
    root,
    JSON.stringify({
      payload: {
        item: { id: firstId, kind: "first", parentId: initial.rootEntry.id, payload: {} },
        sessionId: initial.id,
        type: "entry",
      },
      v: 1,
    }),
    JSON.stringify({
      payload: {
        item: {
          id: "moved",
          kind: "leaf_moved",
          payload: { toEntryId: initial.rootEntry.id },
        },
        sessionId: initial.id,
        type: "record",
      },
      v: 1,
    }),
    JSON.stringify({
      payload: {
        item: { id: "second", kind: "second", parentId: firstId, payload: {} },
        sessionId: initial.id,
        type: "entry",
      },
      v: 1,
    }),
    "",
  ].join("\n");
  await writeFile(file, invalidFile);
  const diagnostics: Array<unknown> = [];

  const error = await Effect.runPromise(
    Effect.flip(
      Effect.gen(function* () {
        const journal = yield* Journal;
        return yield* journal.getLeaf(initial.id);
      }).pipe(
        Effect.provide(
          JournalJsonl(directory, {
            diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
          }),
        ),
      ),
    ),
  );

  expect(error).toMatchObject({
    _tag: "JournalError",
    corruptionClass: "invalid_record_sequence",
    file,
  });
  await expect(readFile(file, "utf8")).resolves.toBe(invalidFile);
  expect(diagnostics).toContainEqual(
    expect.objectContaining({
      action: "rejected",
      corruptionClass: "invalid_record_sequence",
      file,
    }),
  );
});

test("open rejects an acknowledged line from a different session without changing its file", async () => {
  const directory = await makeDirectory();
  const initial = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      return yield* journal.createSession();
    }).pipe(Effect.provide(JournalJsonl(directory))),
  );
  const file = join(directory, `${initial.id}.jsonl`);
  const [header, root] = (await readFile(file, "utf8")).trimEnd().split("\n");
  const corrupted = [
    header,
    root,
    JSON.stringify({
      payload: {
        item: { id: "foreign", kind: "foreign", parentId: initial.rootEntry.id, payload: {} },
        sessionId: "other-session",
        type: "entry",
      },
      v: 1,
    }),
    "",
  ].join("\n");
  await writeFile(file, corrupted);

  const error = await Effect.runPromise(
    Effect.flip(
      Effect.gen(function* () {
        const journal = yield* Journal;
        return yield* journal.getLeaf(initial.id);
      }).pipe(Effect.provide(JournalJsonl(directory))),
    ),
  );

  expect(error).toMatchObject({
    _tag: "JournalError",
    corruptionClass: "invalid_record_sequence",
    file,
  });
  await expect(readFile(file, "utf8")).resolves.toBe(corrupted);
});

test("open rejects a malformed newline-terminated line without repairing it", async () => {
  const directory = await makeDirectory();
  const initial = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      return yield* journal.createSession();
    }).pipe(Effect.provide(JournalJsonl(directory))),
  );
  const file = join(directory, `${initial.id}.jsonl`);
  await appendFile(file, '{"v":1,"payload":\n');
  const corrupted = await readFile(file, "utf8");

  const error = await Effect.runPromise(
    Effect.flip(
      Effect.gen(function* () {
        const journal = yield* Journal;
        return yield* journal.getLeaf(initial.id);
      }).pipe(Effect.provide(JournalJsonl(directory))),
    ),
  );

  expect(error).toMatchObject({ _tag: "JournalError", corruptionClass: "malformed_json", file });
  await expect(readFile(file, "utf8")).resolves.toBe(corrupted);
});

test("reopen reports the opened file through the diagnostic sink", async () => {
  const directory = await makeDirectory();
  const initial = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      return yield* journal.createSession();
    }).pipe(Effect.provide(JournalJsonl(directory))),
  );
  const file = join(directory, `${initial.id}.jsonl`);
  const diagnostics: Array<unknown> = [];

  await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      return yield* journal.getLeaf(initial.id);
    }).pipe(
      Effect.provide(
        JournalJsonl(directory, {
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
        }),
      ),
    ),
  );

  expect(diagnostics).toContainEqual(expect.objectContaining({ action: "opened", file }));
});

describeJournalContract(() => createJsonlJournalHarness(makeDirectorySync()));
