import { Effect, Layer } from "effect";
import { expect, test } from "vitest";
import { Journal } from "../journal.js";
import { createMemoryJournalHarness } from "../memory.js";
import {
  type Entry,
  type EntryId,
  RecordIdSchema,
  RecordSchema,
  type SessionId,
} from "../shapes.js";
import {
  assertLeafMovePersistsAfterReopen,
  describeJournalContract,
  type JournalContractHarness,
} from "./index.js";

test("exports the parameterized Journal conformance suite", () => {
  expect(describeJournalContract).toBeTypeOf("function");
});

const layerThatDropsLeafMoves = (base: JournalContractHarness["layer"]) => {
  const entriesBySession = new Map<SessionId, Map<EntryId, Entry>>();
  const movedLeaves = new Map<SessionId, Entry>();

  return Layer.effect(
    Journal,
    Effect.gen(function* () {
      const journal = yield* Journal;
      return Journal.of({
        ...journal,
        appendEntry: (sessionId, entry) =>
          journal.appendEntry(sessionId, entry).pipe(
            Effect.tap((appended) =>
              Effect.sync(() => {
                entriesBySession.get(sessionId)?.set(appended.id, appended);
              }),
            ),
          ),
        createSession: () =>
          journal.createSession().pipe(
            Effect.tap((session) =>
              Effect.sync(() => {
                entriesBySession.set(
                  session.id,
                  new Map([[session.rootEntry.id, session.rootEntry]]),
                );
              }),
            ),
          ),
        getLeaf: (sessionId) => {
          const movedLeaf = movedLeaves.get(sessionId);
          return movedLeaf === undefined ? journal.getLeaf(sessionId) : Effect.succeed(movedLeaf);
        },
        moveLeaf: (sessionId, toEntryId) => {
          const target = entriesBySession.get(sessionId)?.get(toEntryId);
          if (target === undefined) {
            return journal.moveLeaf(sessionId, toEntryId);
          }
          return Effect.sync(() => {
            movedLeaves.set(sessionId, target);
            return RecordSchema.make({
              id: RecordIdSchema.make("dropped-leaf-move"),
              kind: "leaf_moved",
              payload: { toEntryId },
            });
          });
        },
      });
    }),
  ).pipe(Layer.provide(base));
};

const createLeafMoveDroppingHarness = (): JournalContractHarness => {
  const memory = createMemoryJournalHarness();
  return {
    layer: layerThatDropsLeafMoves(memory.layer),
    reopen: () => layerThatDropsLeafMoves(memory.reopen()),
    snapshotLines: memory.snapshotLines,
  };
};

test("reports that moveLeaf must persist its record when an adapter drops leaf moves", async () => {
  await expect(assertLeafMovePersistsAfterReopen(createLeafMoveDroppingHarness)).rejects.toThrow(
    "Journal contract violation: moveLeaf must persist a leaf_moved record so reopening reconstructs the moved leaf.",
  );
});
