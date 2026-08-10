/**
 * Owns the published Journal backend contract so every adapter proves the same semantics.
 * It exists to prevent adapter-specific tests from changing the Journal interface contract.
 *
 * Vitest is a required peer dependency of this conformance subpath. The main package entry
 * deliberately does not import Vitest.
 */
import { Effect, type Layer } from "effect";

import type { JournalError } from "../errors.js";
import { Journal } from "../journal.js";
import {
  type EntryDraft,
  EntryDraftSchema,
  type RecordDraft,
  RecordDraftSchema,
} from "../shapes.js";

export interface JournalContractHarness {
  readonly layer: Layer.Layer<Journal, JournalError>;
  readonly reopen: () => Layer.Layer<Journal, JournalError>;
  readonly snapshotLines: () => Effect.Effect<ReadonlyArray<unknown>, JournalError>;
}

export type MakeJournalLayer = () => JournalContractHarness;

const entryDraft = (kind: string, payload: unknown): EntryDraft =>
  EntryDraftSchema.make({ kind, payload });

const recordDraft = (kind: string, payload: unknown): RecordDraft =>
  RecordDraftSchema.make({ kind, payload });

export const assertLeafMovePersistsAfterReopen = async (
  makeLayer: MakeJournalLayer,
): Promise<void> => {
  const harness = makeLayer();
  const initial = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      const first = yield* journal.appendEntry(
        session.id,
        entryDraft("user_input", { text: "First." }),
      );
      yield* journal.appendEntry(session.id, entryDraft("assistant_output", { text: "Second." }));
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

  if (JSON.stringify(reopened) !== JSON.stringify({ branch: initial.branch, leaf: initial.leaf })) {
    throw new Error(
      "Journal contract violation: moveLeaf must persist a leaf_moved record so reopening reconstructs the moved leaf.",
    );
  }
};

export const describeJournalContract = async (makeLayer: MakeJournalLayer): Promise<void> => {
  const { describe, expect, test } = await import("vitest");

  describe("Journal contract", () => {
    test("createSession appends a tagged root entry and reports it as leaf", async () => {
      const { layer } = makeLayer();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const session = yield* journal.createSession();
          const leaf = yield* journal.getLeaf(session.id);

          return { leaf, session };
        }).pipe(Effect.provide(layer)),
      );

      expect(result.session.rootEntry).toMatchObject({ kind: "session_root", parentId: null });
      expect(result.leaf).toEqual(result.session.rootEntry);
    });

    test("appendEntry parents to the current leaf and moves it", async () => {
      const { layer } = makeLayer();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const session = yield* journal.createSession();
          const entry = yield* journal.appendEntry(
            session.id,
            entryDraft("user_input", { text: "Continue." }),
          );
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
          const entry = yield* journal.appendEntry(
            session.id,
            entryDraft("user_input", { text: "Continue." }),
          );
          yield* journal.appendRecord(session.id, recordDraft("operation_note", { attempt: 1 }));
          const leaf = yield* journal.getLeaf(session.id);

          return { entry, leaf };
        }).pipe(Effect.provide(layer)),
      );

      expect(result.leaf).toEqual(result.entry);
    });

    test("moveLeaf is append-only and never rewrites prior lines", async () => {
      const harness = makeLayer();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const session = yield* journal.createSession();
          yield* journal.appendEntry(session.id, entryDraft("user_input", { text: "Continue." }));
          const before = yield* harness.snapshotLines();
          const record = yield* journal.moveLeaf(session.id, session.rootEntry.id);
          const after = yield* harness.snapshotLines();

          return { after, before, record, session };
        }).pipe(Effect.provide(harness.layer)),
      );

      expect(result.record).toMatchObject({
        kind: "leaf_moved",
        payload: { toEntryId: result.session.rootEntry.id },
      });
      expect(JSON.stringify(result.after.slice(0, result.before.length))).toBe(
        JSON.stringify(result.before),
      );
      expect(result.after.length).toBeGreaterThanOrEqual(result.before.length + 1);
    });

    test("readBranch returns the root-to-leaf path and excludes records", async () => {
      const { layer } = makeLayer();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const session = yield* journal.createSession();
          const first = yield* journal.appendEntry(
            session.id,
            entryDraft("user_input", { text: "First." }),
          );
          yield* journal.appendEntry(
            session.id,
            entryDraft("assistant_output", { text: "Second." }),
          );
          const record = yield* journal.appendRecord(
            session.id,
            recordDraft("operation_note", { attempt: 1 }),
          );
          yield* journal.moveLeaf(session.id, first.id);
          const branch = yield* journal.readBranch(session.id);

          return { branch, first, record, session };
        }).pipe(Effect.provide(layer)),
      );

      expect(result.branch).toEqual([result.session.rootEntry, result.first]);
      expect(result.branch.map(({ id }) => id)).not.toContain(result.record.id);
    });

    test("leaf reconstructs after reopen", async () => {
      await assertLeafMovePersistsAfterReopen(makeLayer);
    });

    test("append after moveLeaf parents to the moved-to entry", async () => {
      const { layer } = makeLayer();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const session = yield* journal.createSession();
          const first = yield* journal.appendEntry(session.id, entryDraft("first", {}));
          yield* journal.appendEntry(session.id, entryDraft("second", {}));
          yield* journal.moveLeaf(session.id, first.id);
          const appended = yield* journal.appendEntry(session.id, entryDraft("third", {}));

          return { appended, first };
        }).pipe(Effect.provide(layer)),
      );

      expect(result.appended.parentId).toBe(result.first.id);
    });

    test("the newest leaf_moved record wins and moving to the current leaf is valid", async () => {
      const { layer } = makeLayer();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const session = yield* journal.createSession();
          const first = yield* journal.appendEntry(session.id, entryDraft("first", {}));
          const second = yield* journal.appendEntry(session.id, entryDraft("second", {}));
          yield* journal.moveLeaf(session.id, first.id);
          const noOp = yield* journal.moveLeaf(session.id, first.id);
          yield* journal.moveLeaf(session.id, second.id);
          const leaf = yield* journal.getLeaf(session.id);

          return { leaf, noOp, second };
        }).pipe(Effect.provide(layer)),
      );

      expect(result.noOp.kind).toBe("leaf_moved");
      expect(result.leaf).toEqual(result.second);
    });

    test("sessions stay isolated, including cross-session move targets", async () => {
      const { layer } = makeLayer();
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const first = yield* journal.createSession();
          const second = yield* journal.createSession();
          const foreignEntry = yield* journal.appendEntry(second.id, entryDraft("user_input", {}));

          return yield* Effect.flip(journal.moveLeaf(first.id, foreignEntry.id));
        }).pipe(Effect.provide(layer)),
      );

      expect(error).toMatchObject({ what: "entry" });
      expect(error._tag).toBe("JournalNotFound");
    });

    test("public append APIs reject reserved kinds", async () => {
      const { layer } = makeLayer();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const session = yield* journal.createSession();
          const entryError = yield* Effect.flip(
            journal.appendEntry(session.id, entryDraft("session_root", {})),
          );
          const recordError = yield* Effect.flip(
            journal.appendRecord(session.id, recordDraft("leaf_moved", {})),
          );

          return { entryError, recordError };
        }).pipe(Effect.provide(layer)),
      );

      expect(result.entryError).toMatchObject({ kind: "session_root", reason: "reserved_kind" });
      expect(result.recordError).toMatchObject({ kind: "leaf_moved", reason: "reserved_kind" });
    });

    test("concurrent appends to one session form a strictly linear parent chain", async () => {
      const { layer } = makeLayer();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const session = yield* journal.createSession();
          yield* Effect.all(
            Array.from({ length: 50 }, (_, index) =>
              journal.appendEntry(session.id, entryDraft("concurrent", { index })),
            ),
            { concurrency: "unbounded" },
          );
          const branch = yield* journal.readBranch(session.id);

          return { branch, session };
        }).pipe(Effect.provide(layer)),
      );
      const entries = result.branch.slice(1);

      expect(entries).toHaveLength(50);
      expect(entries[0]?.parentId).toBe(result.session.rootEntry.id);
      for (let index = 1; index < entries.length; index += 1) {
        expect(entries[index]?.parentId).toBe(entries[index - 1]?.id);
      }
      expect(new Set(entries.map((entry) => entry.parentId))).toHaveLength(entries.length);
    });
  });
};
