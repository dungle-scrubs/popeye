import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, expect, test } from "vitest";

import {
  deriveGoal,
  GOAL_TEXT_MAX_LENGTH,
  GoalActionSchema,
  GoalChangePayloadSchema,
  GoalSchema,
} from "./goal.js";
import { Journal } from "./journal.js";
import { JournalJsonl } from "./jsonl.js";
import { createMemoryJournalBacking, JournalMemory } from "./memory.js";
import { type Entry, EntryDraftSchema, EntryIdSchema } from "./shapes.js";

const directories: Array<string> = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const entry = (id: string, payload: unknown): Entry => ({
  id: EntryIdSchema.make(id),
  kind: "goal_change",
  parentId: EntryIdSchema.make("root"),
  payload,
});

test("Goal schema requires blocked reason and completion evidence", () => {
  expect(
    Schema.decodeUnknownSync(GoalSchema)({
      continuations: 3,
      objective: "Do work",
      status: "cancelled",
    }),
  ).toEqual({ continuations: 3, objective: "Do work", status: "cancelled" });
  expect(() =>
    Schema.decodeUnknownSync(GoalSchema)({
      continuations: 0,
      objective: "Do work",
      status: "blocked",
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(GoalSchema)({
      continuations: 0,
      objective: "Do work",
      status: "complete",
    }),
  ).toThrow();
});

test("Goal text is bounded in actions and durable state", () => {
  const atLimit = "x".repeat(GOAL_TEXT_MAX_LENGTH);
  const tooLong = `${atLimit}x`;
  expect(() =>
    Schema.decodeUnknownSync(GoalActionSchema)({ action: "set", objective: atLimit }),
  ).not.toThrow();
  for (const action of [
    { action: "set", objective: tooLong },
    { action: "blocked", reason: tooLong },
    { action: "complete", evidence: tooLong },
  ]) {
    expect(() => Schema.decodeUnknownSync(GoalActionSchema)(action)).toThrow();
  }
  for (const goal of [
    { continuations: 0, objective: tooLong, status: "active" },
    { continuations: 0, objective: "Do work", reason: tooLong, status: "blocked" },
    { continuations: 0, evidence: tooLong, objective: "Do work", status: "complete" },
  ]) {
    expect(() => Schema.decodeUnknownSync(GoalSchema)(goal)).toThrow();
  }
});

test("Goal fold uses newest change on the Branch and accepts legacy null clear", async () => {
  const active = Schema.decodeUnknownSync(GoalChangePayloadSchema)({
    goal: { continuations: 0, objective: "Do work", status: "active" },
  });
  const paused = Schema.decodeUnknownSync(GoalChangePayloadSchema)({
    goal: { continuations: 2, objective: "Do work", status: "paused" },
  });
  const branch = [entry("a", active), entry("b", paused)];
  expect(await Effect.runPromise(deriveGoal(branch))).toEqual(paused.goal);
  expect(
    await Effect.runPromise(deriveGoal([...branch, entry("c", { goal: null })])),
  ).toBeUndefined();
});

test("Goal fold preserves inspectable cancellation", async () => {
  const cancelled = { continuations: 4, objective: "Do work", status: "cancelled" };
  expect(await Effect.runPromise(deriveGoal([entry("cancelled", { goal: cancelled })]))).toEqual(
    cancelled,
  );
});

test("Goal fold rejects malformed goal change entries", async () => {
  const exit = await Effect.runPromiseExit(
    deriveGoal([entry("bad", { goal: { objective: "Do work", status: "active" } })]),
  );
  expect(exit._tag).toBe("Failure");
});

test("moving the Leaf reconstructs the Goal from the selected Branch", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      const active = yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "goal_change",
          payload: { goal: { continuations: 0, objective: "Finish work", status: "active" } },
        }),
      );
      const complete = yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "goal_change",
          payload: {
            goal: {
              continuations: 2,
              evidence: "Work verified",
              objective: "Finish work",
              status: "complete",
            },
          },
        }),
      );
      yield* journal.moveLeaf(session.id, active.id);
      const paused = yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "goal_change",
          payload: { goal: { continuations: 1, objective: "Finish work", status: "paused" } },
        }),
      );
      const pausedGoal = yield* journal.readBranch(session.id).pipe(Effect.flatMap(deriveGoal));
      yield* journal.moveLeaf(session.id, complete.id);
      const completeGoal = yield* journal.readBranch(session.id).pipe(Effect.flatMap(deriveGoal));
      yield* journal.moveLeaf(session.id, paused.id);
      const restoredGoal = yield* journal.readBranch(session.id).pipe(Effect.flatMap(deriveGoal));
      return { completeGoal, pausedGoal, restoredGoal };
    }).pipe(Effect.provide(JournalMemory(createMemoryJournalBacking()))),
  );

  expect(result.pausedGoal).toMatchObject({ continuations: 1, status: "paused" });
  expect(result.completeGoal).toMatchObject({
    continuations: 2,
    evidence: "Work verified",
    status: "complete",
  });
  expect(result.restoredGoal).toEqual(result.pausedGoal);
});

test("a fresh Journal layer reconstructs Goal and Leaf from disk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "popeye-goal-"));
  directories.push(directory);
  const written = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      const active = yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "goal_change",
          payload: { goal: { continuations: 0, objective: "Resume work", status: "active" } },
        }),
      );
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "goal_change",
          payload: { goal: { continuations: 3, objective: "Resume work", status: "paused" } },
        }),
      );
      yield* journal.moveLeaf(session.id, active.id);
      return { activeId: active.id, sessionId: session.id };
    }).pipe(Effect.provide(JournalJsonl(directory))),
  );

  const reopened = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const leaf = yield* journal.getLeaf(written.sessionId);
      const branch = yield* journal.readBranch(written.sessionId);
      return { branch, goal: yield* deriveGoal(branch), leaf };
    }).pipe(Effect.provide(JournalJsonl(directory))),
  );

  expect(reopened.leaf.id).toBe(written.activeId);
  expect(reopened.branch.map((item) => item.id).at(-1)).toBe(written.activeId);
  expect(reopened.goal).toEqual({ continuations: 0, objective: "Resume work", status: "active" });
});
