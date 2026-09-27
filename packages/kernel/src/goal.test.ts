import { createMemoryJournalBacking, Journal, JournalMemory } from "@dungle-scrubs/popeye-journal";
import { Effect, Either } from "effect";
import { expect, test } from "vitest";

import { makeGoalAccess } from "./goal.js";

test("clear keeps an inspectable terminal Goal and set replaces it", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      const access = makeGoalAccess(journal);
      const empty = yield* access.changeGoal(session.id, { action: "clear" });
      const linesAfterEmpty = yield* journal.countDurableLines(session.id);
      yield* access.changeGoal(session.id, { action: "set", objective: "Finish work" });
      yield* access.advanceGoal(session.id);
      const cancelled = yield* access.changeGoal(session.id, { action: "clear" });
      const restored = yield* access.getGoal(session.id);
      const linesAfterCancel = yield* journal.countDurableLines(session.id);
      yield* access.changeGoal(session.id, { action: "clear" });
      const linesAfterRepeat = yield* journal.countDurableLines(session.id);
      const replaced = yield* access.changeGoal(session.id, {
        action: "set",
        objective: "New work",
      });
      return {
        cancelled,
        empty,
        linesAfterCancel,
        linesAfterEmpty,
        linesAfterRepeat,
        replaced,
        restored,
      };
    }).pipe(Effect.provide(JournalMemory(createMemoryJournalBacking()))),
  );

  expect(result.empty).toBeUndefined();
  expect(result.linesAfterEmpty).toBe(1);
  expect(result.cancelled).toEqual({
    continuations: 1,
    objective: "Finish work",
    status: "cancelled",
  });
  expect(result.restored).toEqual(result.cancelled);
  expect(result.linesAfterRepeat).toBe(result.linesAfterCancel);
  expect(result.replaced).toEqual({
    continuations: 0,
    objective: "New work",
    status: "active",
  });
});

test("cancelled Goal rejects every non-set transition", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      const access = makeGoalAccess(journal);
      yield* access.changeGoal(session.id, { action: "set", objective: "Finish work" });
      yield* access.changeGoal(session.id, { action: "clear" });
      return yield* Effect.forEach(
        [
          { action: "pause" } as const,
          { action: "resume" } as const,
          { action: "blocked", reason: "Waiting" } as const,
          { action: "complete", evidence: "Done" } as const,
        ],
        (action) => Effect.either(access.changeGoal(session.id, action)),
      );
    }).pipe(Effect.provide(JournalMemory(createMemoryJournalBacking()))),
  );

  expect(result).toHaveLength(4);
  expect(result.every(Either.isLeft)).toBe(true);
  expect(
    result.map((item) =>
      Either.isLeft(item) && item.left._tag === "GoalTransitionError"
        ? item.left.reason
        : undefined,
    ),
  ).toEqual([
    "invalid_transition",
    "invalid_transition",
    "invalid_transition",
    "invalid_transition",
  ]);
});
