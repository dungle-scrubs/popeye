/**
 * Owns reusable Journal behavior checks so every durable adapter proves the same semantics.
 * It exists to prevent adapter-specific tests from changing the Journal interface contract.
 */
import { Effect, type Layer } from "effect";
import { describe, expect, test } from "vitest";

import { Journal } from "./journal.js";

export interface JournalContractHarness {
  readonly layer: Layer.Layer<Journal>;
  readonly readStoredLines: () => ReadonlyArray<unknown>;
  readonly reopen: () => Layer.Layer<Journal>;
}

export type MakeJournalLayer = () => JournalContractHarness;

export const describeJournalContract = (makeLayer: MakeJournalLayer): void => {
  describe("Journal contract", () => {
    test("createSession appends root entry and reports it as leaf", async () => {
      const { layer } = makeLayer();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const session = yield* journal.createSession();
          const leaf = yield* journal.getLeaf(session.id);

          return { leaf, session };
        }).pipe(Effect.provide(layer)),
      );

      expect(result.session.rootEntry).toMatchObject({
        kind: "session_root",
        parentId: null,
      });
      expect(result.leaf).toEqual(result.session.rootEntry);
    });

    test("appendEntry parents to leaf and moves leaf", async () => {
      const { layer } = makeLayer();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const session = yield* journal.createSession();
          const entry = yield* journal.appendEntry(session.id, {
            kind: "user_input",
            payload: { text: "Continue." },
          });
          const leaf = yield* journal.getLeaf(session.id);

          return { entry, leaf, session };
        }).pipe(Effect.provide(layer)),
      );

      expect(result.entry.parentId).toBe(result.session.rootEntry.id);
      expect(result.leaf).toEqual(result.entry);
    });

    test("appendRecord does not move the entry leaf", async () => {
      const { layer } = makeLayer();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const session = yield* journal.createSession();
          const entry = yield* journal.appendEntry(session.id, {
            kind: "user_input",
            payload: { text: "Continue." },
          });
          yield* journal.appendRecord(session.id, {
            kind: "operation_note",
            payload: { attempt: 1 },
          });
          const leaf = yield* journal.getLeaf(session.id);

          return { entry, leaf };
        }).pipe(Effect.provide(layer)),
      );

      expect(result.leaf).toEqual(result.entry);
    });

    test("moveLeaf to earlier entry appends leaf_moved record without rewriting", async () => {
      const harness = makeLayer();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const session = yield* journal.createSession();
          yield* journal.appendEntry(session.id, {
            kind: "user_input",
            payload: { text: "Continue." },
          });
          const storedLines = JSON.stringify(harness.readStoredLines());
          const record = yield* journal.moveLeaf(session.id, session.rootEntry.id);

          return { record, session, storedLines };
        }).pipe(Effect.provide(harness.layer)),
      );

      const lines = harness.readStoredLines();
      expect(result.record).toMatchObject({
        kind: "leaf_moved",
        payload: { toEntryId: result.session.rootEntry.id },
      });
      expect(JSON.stringify(lines.slice(0, -1))).toBe(result.storedLines);
    });

    test("readBranch returns root-to-leaf entry path", async () => {
      const { layer } = makeLayer();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const session = yield* journal.createSession();
          const first = yield* journal.appendEntry(session.id, {
            kind: "user_input",
            payload: { text: "First." },
          });
          yield* journal.appendEntry(session.id, {
            kind: "assistant_output",
            payload: { text: "Second." },
          });
          yield* journal.moveLeaf(session.id, first.id);
          const branch = yield* journal.readBranch(session.id);

          return { branch, first, session };
        }).pipe(Effect.provide(layer)),
      );

      expect(result.branch).toEqual([result.session.rootEntry, result.first]);
    });

    test("records never appear in branch reads", async () => {
      const { layer } = makeLayer();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const session = yield* journal.createSession();
          const entry = yield* journal.appendEntry(session.id, {
            kind: "user_input",
            payload: { text: "Continue." },
          });
          const record = yield* journal.appendRecord(session.id, {
            kind: "operation_note",
            payload: { attempt: 1 },
          });
          const branch = yield* journal.readBranch(session.id);

          return { branch, entry, record, session };
        }).pipe(Effect.provide(layer)),
      );

      expect(result.branch).toEqual([result.session.rootEntry, result.entry]);
      expect(result.branch.map(({ id }) => id)).not.toContain(result.record.id);
    });

    test("leaf reconstructs from records alone after close/reopen", async () => {
      const harness = makeLayer();
      const initial = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const session = yield* journal.createSession();
          const first = yield* journal.appendEntry(session.id, {
            kind: "user_input",
            payload: { text: "First." },
          });
          yield* journal.appendEntry(session.id, {
            kind: "assistant_output",
            payload: { text: "Second." },
          });
          yield* journal.moveLeaf(session.id, first.id);
          const branch = yield* journal.readBranch(session.id);
          const leaf = yield* journal.getLeaf(session.id);

          return { branch, leaf, session };
        }).pipe(Effect.provide(harness.layer)),
      );
      const reopened = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const branch = yield* journal.readBranch(initial.session.id);
          const leaf = yield* journal.getLeaf(initial.session.id);

          return { branch, leaf };
        }).pipe(Effect.provide(harness.reopen())),
      );

      expect(reopened).toEqual({ branch: initial.branch, leaf: initial.leaf });
    });

    test("two sessions stay isolated", async () => {
      const { layer } = makeLayer();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const firstSession = yield* journal.createSession();
          const secondSession = yield* journal.createSession();
          const firstEntry = yield* journal.appendEntry(firstSession.id, {
            kind: "user_input",
            payload: { text: "First." },
          });
          const secondEntry = yield* journal.appendEntry(secondSession.id, {
            kind: "user_input",
            payload: { text: "Second." },
          });
          const firstBranch = yield* journal.readBranch(firstSession.id);
          const firstLeaf = yield* journal.getLeaf(firstSession.id);
          const secondBranch = yield* journal.readBranch(secondSession.id);
          const secondLeaf = yield* journal.getLeaf(secondSession.id);
          const sessions = yield* journal.listSessions();

          return {
            firstBranch,
            firstEntry,
            firstLeaf,
            firstSession,
            secondBranch,
            secondEntry,
            secondLeaf,
            secondSession,
            sessions,
          };
        }).pipe(Effect.provide(layer)),
      );

      expect(result.sessions).toEqual([result.firstSession, result.secondSession]);
      expect(result.firstBranch).toEqual([result.firstSession.rootEntry, result.firstEntry]);
      expect(result.firstLeaf).toEqual(result.firstEntry);
      expect(result.secondBranch).toEqual([result.secondSession.rootEntry, result.secondEntry]);
      expect(result.secondLeaf).toEqual(result.secondEntry);
    });

    test("entry ids are unique and stable across reopen", async () => {
      const harness = makeLayer();
      const initial = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const session = yield* journal.createSession();
          const entry = yield* journal.appendEntry(session.id, {
            kind: "user_input",
            payload: { text: "Continue." },
          });
          const branch = yield* journal.readBranch(session.id);

          return { branch, entry, session };
        }).pipe(Effect.provide(harness.layer)),
      );
      const reopened = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const appended = yield* journal.appendEntry(initial.session.id, {
            kind: "assistant_output",
            payload: { text: "Done." },
          });
          const branch = yield* journal.readBranch(initial.session.id);

          return { appended, branch };
        }).pipe(Effect.provide(harness.reopen())),
      );
      const ids = reopened.branch.map(({ id }) => id);

      expect(reopened.branch.slice(0, -1)).toEqual(initial.branch);
      expect(new Set(ids)).toHaveLength(ids.length);
      expect(reopened.appended.id).not.toBe(initial.entry.id);
    });

    test("readRecords returns append-ordered records", async () => {
      const { layer } = makeLayer();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const session = yield* journal.createSession();
          const first = yield* journal.appendRecord(session.id, {
            kind: "operation_note",
            payload: { attempt: 1 },
          });
          const second = yield* journal.appendRecord(session.id, {
            kind: "operation_note",
            payload: { attempt: 2 },
          });
          const records = yield* journal.readRecords(session.id);

          return { first, records, second };
        }).pipe(Effect.provide(layer)),
      );

      expect(result.records).toEqual([result.first, result.second]);
    });

    test("moveLeaf reports an unknown entry through JournalNotFound", async () => {
      const { layer } = makeLayer();
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const session = yield* journal.createSession();

          return yield* Effect.flip(journal.moveLeaf(session.id, "missing-entry"));
        }).pipe(Effect.provide(layer)),
      );

      expect(error).toMatchObject({ id: "missing-entry", what: "entry" });
      expect(error._tag).toBe("JournalNotFound");
    });
  });
};
