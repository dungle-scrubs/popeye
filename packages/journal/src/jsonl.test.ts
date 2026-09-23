import { mkdtempSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, expect, test } from "vitest";
import { describeJournalContract } from "./conformance/index.js";
import { Journal } from "./journal.js";
import { createJsonlJournalHarness, JournalJsonl } from "./jsonl.js";
import { EntryDraftSchema, SessionIdSchema } from "./shapes.js";

const directories: Array<string> = [];

const makeDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "popeye-journal-"));
  directories.push(directory);
  return directory;
};

const makeDirectorySync = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "popeye-journal-"));
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

test("createSession and appendEntry acknowledge only after write and sync", async () => {
  const directory = await makeDirectory();
  const events: Array<string> = [];
  const io = {
    observe: (event: { readonly operation: string }) =>
      Effect.sync(() => events.push(event.operation)),
  };
  const session = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      return yield* journal.createSession();
    }).pipe(Effect.provide(JournalJsonl(directory, { io }))),
  );

  expect(events).toEqual(["write", "sync", "sync", "ack"]);

  events.splice(0);
  await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({ kind: "user_input", payload: {} }),
      );
    }).pipe(Effect.provide(JournalJsonl(directory, { io }))),
  );

  expect(events).toEqual(["write", "sync", "ack"]);
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
  const ioEvents: Array<{ readonly file: string; readonly operation: string }> = [];

  const reopened = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      return yield* journal.getLeaf(initial.id);
    }).pipe(
      Effect.provide(
        JournalJsonl(directory, {
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
          io: {
            observe: (event) => Effect.sync(() => ioEvents.push(event)),
          },
        }),
      ),
    ),
  );

  expect(reopened).toEqual(initial.rootEntry);
  await expect(readFile(file, "utf8")).resolves.toBe(acknowledged);
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ action: "recovered_torn_tail", file: await realpath(file) }),
  );
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ action: "opened", file: await realpath(file) }),
  );
  expect(ioEvents).toContainEqual(
    expect.objectContaining({ file: await realpath(directory), operation: "sync" }),
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
    file: await realpath(file),
  });
  await expect(readFile(file, "utf8")).resolves.toBe(invalidFile);
  expect(diagnostics).toContainEqual(
    expect.objectContaining({
      action: "rejected",
      corruptionClass: "invalid_record_sequence",
      file: await realpath(file),
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
    file: await realpath(file),
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

  expect(error).toMatchObject({
    _tag: "JournalError",
    corruptionClass: "malformed_json",
    file: await realpath(file),
  });
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

  expect(diagnostics).toContainEqual(
    expect.objectContaining({ action: "opened", file: await realpath(file) }),
  );
});

test("a valid JSON final line without a newline is discarded before the next append", async () => {
  const directory = await makeDirectory();
  const initial = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      return yield* journal.createSession();
    }).pipe(Effect.provide(JournalJsonl(directory))),
  );
  const file = join(directory, `${initial.id}.jsonl`);
  const acknowledged = await readFile(file, "utf8");
  const unacknowledged = JSON.stringify({
    payload: {
      item: { id: "unacknowledged", kind: "lost", parentId: initial.rootEntry.id, payload: {} },
      sessionId: initial.id,
      type: "entry",
    },
    v: 1,
  });
  await appendFile(file, unacknowledged);

  await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      yield* journal.appendEntry(
        initial.id,
        EntryDraftSchema.make({ kind: "user_input", payload: { after: "recovery" } }),
      );
    }).pipe(Effect.provide(JournalJsonl(directory))),
  );

  const stored = await readFile(file, "utf8");
  expect(stored.startsWith(acknowledged)).toBe(true);
  expect(stored).not.toContain(unacknowledged);
  expect(stored.endsWith("\n")).toBe(true);
  expect(() =>
    stored
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).not.toThrow();
});

test("a failed append invalidates its cache and the next append re-derives from disk", async () => {
  const directory = await makeDirectory();
  let failSync = false;
  const io = {
    sync: async (_handle: unknown, file: string): Promise<void> => {
      if (failSync && file.endsWith(".jsonl")) {
        failSync = false;
        throw new Error("simulated sync failure");
      }
    },
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      failSync = true;
      const failed = yield* Effect.flip(
        journal.appendEntry(session.id, EntryDraftSchema.make({ kind: "first", payload: {} })),
      );
      const second = yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({ kind: "second", payload: {} }),
      );
      return { failed, second, session };
    }).pipe(Effect.provide(JournalJsonl(directory, { io }))),
  );

  expect(result.failed).toMatchObject({ _tag: "JournalError", corruptionClass: "io_failure" });
  const records = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      return yield* journal.readBranch(result.session.id);
    }).pipe(Effect.provide(JournalJsonl(directory))),
  );
  expect(records.map((entry) => entry.kind)).toEqual(["session_root", "first", "second"]);
  expect(records.at(-1)?.id).toBe(result.second.id);
});

test("a second concurrent layer over one canonical directory fails typed", async () => {
  const directory = await makeDirectory();
  const error = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(JournalJsonl(directory));
        return yield* Effect.flip(Layer.build(JournalJsonl(directory)));
      }),
    ),
  );

  expect(error).toMatchObject({
    _tag: "JournalError",
    corruptionClass: "io_failure",
    message: expect.stringContaining("already open"),
  });
});

test("a torn-only file and a torn tail after prior corruption reject without rewriting", async () => {
  const directory = await makeDirectory();
  const tornId = SessionIdSchema.make("torn-only");
  const tornFile = join(directory, `${tornId}.jsonl`);
  await writeFile(tornFile, '{"v":1,"payload":{}');

  const initial = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      return yield* journal.createSession();
    }).pipe(Effect.provide(JournalJsonl(directory))),
  );
  const corruptedFile = join(directory, `${initial.id}.jsonl`);
  const [header, root] = (await readFile(corruptedFile, "utf8")).trimEnd().split("\n");
  const corrupted = `${header}\n${root}\n{"v":1,"payload":\n{"v":1,"payload":{}}`;
  await writeFile(corruptedFile, corrupted);
  const diagnostics: Array<unknown> = [];

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const torn = yield* Effect.flip(journal.getLeaf(tornId));
      const earlierCorruption = yield* Effect.flip(journal.getLeaf(initial.id));
      return { earlierCorruption, torn };
    }).pipe(
      Effect.provide(
        JournalJsonl(directory, {
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
        }),
      ),
    ),
  );

  expect(result.torn).toMatchObject({
    _tag: "JournalError",
    corruptionClass: "invalid_record_sequence",
  });
  expect(result.earlierCorruption).toMatchObject({
    _tag: "JournalError",
    corruptionClass: "malformed_json",
  });
  await expect(readFile(tornFile, "utf8")).resolves.toBe('{"v":1,"payload":{}');
  await expect(readFile(corruptedFile, "utf8")).resolves.toBe(corrupted);
  expect(diagnostics).not.toContainEqual(
    expect.objectContaining({ action: "recovered_torn_tail" }),
  );
});

test("a zero-byte file rejects without recovery and does not change", async () => {
  const directory = await makeDirectory();
  const id = SessionIdSchema.make("empty");
  const file = join(directory, `${id}.jsonl`);
  await writeFile(file, "");
  const diagnostics: Array<unknown> = [];
  const error = await Effect.runPromise(
    Effect.flip(
      Effect.gen(function* () {
        const journal = yield* Journal;
        return yield* journal.getLeaf(id);
      }).pipe(
        Effect.provide(
          JournalJsonl(directory, {
            diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
          }),
        ),
      ),
    ),
  );

  expect(error).toMatchObject({ _tag: "JournalError", corruptionClass: "invalid_record_sequence" });
  await expect(readFile(file, "utf8")).resolves.toBe("");
  expect(diagnostics).not.toContainEqual(
    expect.objectContaining({ action: "recovered_torn_tail" }),
  );
});

test("bad session files do not prevent healthy sessions from opening", async () => {
  const directory = await makeDirectory();
  const healthy = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      return yield* journal.createSession();
    }).pipe(Effect.provide(JournalJsonl(directory))),
  );
  await writeFile(join(directory, "bad.jsonl"), "");
  await mkdir(join(directory, "x.jsonl"));
  await writeFile(join(directory, "orphan.tmp"), "leftover");
  const diagnostics: Array<unknown> = [];
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const leaf = yield* journal.getLeaf(healthy.id);
      const bad = yield* Effect.flip(journal.getLeaf(SessionIdSchema.make("bad")));
      const directoryError = yield* Effect.flip(journal.getLeaf(SessionIdSchema.make("x")));
      return { bad, directoryError, leaf };
    }).pipe(
      Effect.provide(
        JournalJsonl(directory, {
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
        }),
      ),
    ),
  );

  expect(result.leaf).toEqual(healthy.rootEntry);
  expect(result.bad).toMatchObject({ _tag: "JournalError" });
  expect(result.directoryError).toMatchObject({
    _tag: "JournalError",
    corruptionClass: "io_failure",
  });
  expect(
    diagnostics.filter((diagnostic) => (diagnostic as { action?: string }).action === "rejected"),
  ).toHaveLength(2);
  await expect(readFile(join(directory, "orphan.tmp"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

await describeJournalContract(() => createJsonlJournalHarness(makeDirectorySync()));
