/**
 * Owns a reusable in-memory Journal adapter for fast behavior checks and local composition.
 * It exists to prove Journal rules from append-only content without file mechanics.
 */
import { randomBytes } from "node:crypto";
import { Effect, Layer } from "effect";

import { JournalNotFound } from "./errors.js";
import {
  branchFor,
  entriesFor,
  Journal,
  type JournalService,
  leafFor,
  recordsFor,
} from "./journal.js";
import type { Entry, JournalLine, Record, SessionRootEntry } from "./shapes.js";

export interface JournalMemoryStore {
  readonly lines: Array<JournalLine>;
}

const createId = (): string => randomBytes(12).toString("base64url");

const sessionLinesFor = (
  store: JournalMemoryStore,
  sessionId: string,
): ReadonlyArray<JournalLine> => store.lines.filter((line) => line.sessionId === sessionId);

const missingSession = (sessionId: string): JournalNotFound =>
  new JournalNotFound({ id: sessionId, what: "session" });

const requireSessionLines = (
  store: JournalMemoryStore,
  sessionId: string,
): Effect.Effect<ReadonlyArray<JournalLine>, JournalNotFound> => {
  const lines = sessionLinesFor(store, sessionId);

  return entriesFor(lines).some((entry) => entry.kind === "session_root" && entry.parentId === null)
    ? Effect.succeed(lines)
    : Effect.fail(missingSession(sessionId));
};

const createJournalMemory = (store: JournalMemoryStore): JournalService => ({
  appendEntry: (sessionId, entry) =>
    Effect.gen(function* () {
      const lines = yield* requireSessionLines(store, sessionId);
      const leaf = leafFor(lines);

      if (leaf === undefined) {
        return yield* Effect.fail(missingSession(sessionId));
      }

      const appended: Entry = { ...entry, id: createId(), parentId: leaf.id };
      store.lines.push({ item: appended, sessionId });
      return appended;
    }),
  appendRecord: (sessionId, record) =>
    Effect.gen(function* () {
      yield* requireSessionLines(store, sessionId);
      const appended: Record = { ...record, id: createId() };

      store.lines.push({ item: appended, sessionId });
      return appended;
    }),
  createSession: () =>
    Effect.sync(() => {
      const id = createId();
      const rootEntry: SessionRootEntry = {
        id: createId(),
        kind: "session_root",
        parentId: null,
        payload: {},
      };

      store.lines.push({ item: rootEntry, sessionId: id });
      return { id, rootEntry };
    }),
  getLeaf: (sessionId) =>
    Effect.gen(function* () {
      const lines = yield* requireSessionLines(store, sessionId);
      const leaf = leafFor(lines);

      if (leaf === undefined) {
        return yield* Effect.fail(missingSession(sessionId));
      }

      return leaf;
    }),
  listSessions: () =>
    Effect.sync(() =>
      store.lines.flatMap(({ item, sessionId }) =>
        item.kind === "session_root" && "parentId" in item && item.parentId === null
          ? [{ id: sessionId, rootEntry: item }]
          : [],
      ),
    ),
  moveLeaf: (sessionId, toEntryId) =>
    Effect.gen(function* () {
      const lines = yield* requireSessionLines(store, sessionId);
      const entry = entriesFor(lines).find(({ id }) => id === toEntryId);

      if (entry === undefined) {
        return yield* Effect.fail(new JournalNotFound({ id: toEntryId, what: "entry" }));
      }

      const record: Record = {
        id: createId(),
        kind: "leaf_moved",
        payload: { toEntryId },
      };
      store.lines.push({ item: record, sessionId });
      return record;
    }),
  readBranch: (sessionId) =>
    requireSessionLines(store, sessionId).pipe(Effect.map((lines) => branchFor(lines))),
  readRecords: (sessionId) =>
    requireSessionLines(store, sessionId).pipe(Effect.map((lines) => recordsFor(lines))),
});

export const createJournalMemoryStore = (): JournalMemoryStore => ({ lines: [] });

export const JournalMemory = (store: JournalMemoryStore): Layer.Layer<Journal> =>
  Layer.succeed(Journal, createJournalMemory(store));

export const createJournalMemoryHarness = () => {
  const store = createJournalMemoryStore();

  return {
    layer: JournalMemory(store),
    readStoredLines: () => store.lines,
    reopen: () => JournalMemory(store),
  };
};
