import {
  deriveGoal,
  EntryDraftSchema,
  type Goal,
  type GoalAction,
  GoalChangePayloadSchema,
  type JournalFailure,
  type JournalService,
  type SessionId,
} from "@dungle-scrubs/popeye-journal";
import { Data, Effect, Schema } from "effect";

export class GoalTransitionError extends Data.TaggedError("GoalTransitionError")<{
  readonly message: string;
  readonly reason: "missing_goal" | "invalid_transition";
}> {}

const missingGoal = (): GoalTransitionError =>
  new GoalTransitionError({ message: "No Goal is set for this Session.", reason: "missing_goal" });

const invalidTransition = (message: string): GoalTransitionError =>
  new GoalTransitionError({ message, reason: "invalid_transition" });

const nextGoal = (
  current: Goal | undefined,
  action: GoalAction,
): Effect.Effect<Goal | null, GoalTransitionError> => {
  switch (action.action) {
    case "get":
      return Effect.succeed(current ?? null);
    case "set":
      return Effect.succeed({ continuations: 0, objective: action.objective, status: "active" });
    case "clear":
      return Effect.succeed(
        current === undefined
          ? null
          : {
              continuations: current.continuations,
              objective: current.objective,
              status: "cancelled",
            },
      );
    case "pause":
      return current === undefined
        ? Effect.fail(missingGoal())
        : current.status === "complete" || current.status === "cancelled"
          ? Effect.fail(invalidTransition("A terminal Goal cannot be paused."))
          : Effect.succeed({
              continuations: current.continuations,
              objective: current.objective,
              status: "paused",
            });
    case "resume":
      return current === undefined
        ? Effect.fail(missingGoal())
        : current.status === "complete" || current.status === "cancelled"
          ? Effect.fail(invalidTransition("A terminal Goal cannot be resumed."))
          : Effect.succeed({ continuations: 0, objective: current.objective, status: "active" });
    case "blocked":
      return current === undefined
        ? Effect.fail(missingGoal())
        : current.status === "complete" || current.status === "cancelled"
          ? Effect.fail(invalidTransition("A terminal Goal cannot be blocked."))
          : Effect.succeed({
              continuations: current.continuations,
              objective: current.objective,
              reason: action.reason,
              status: "blocked",
            });
    case "complete":
      return current === undefined
        ? Effect.fail(missingGoal())
        : current.status === "cancelled"
          ? Effect.fail(invalidTransition("A cancelled Goal cannot be completed."))
          : Effect.succeed({
              continuations: current.continuations,
              evidence: action.evidence,
              objective: current.objective,
              status: "complete",
            });
  }
};

export interface GoalAccess {
  readonly advanceGoal: (sessionId: SessionId) => Effect.Effect<Goal | undefined, JournalFailure>;
  readonly changeGoal: (
    sessionId: SessionId,
    action: GoalAction,
  ) => Effect.Effect<Goal | undefined, JournalFailure | GoalTransitionError>;
  readonly getGoal: (sessionId: SessionId) => Effect.Effect<Goal | undefined, JournalFailure>;
}

export const makeGoalAccess = (journal: JournalService): GoalAccess => {
  const getGoal: GoalAccess["getGoal"] = (sessionId) =>
    journal.readBranch(sessionId).pipe(Effect.flatMap(deriveGoal));

  const changeGoal: GoalAccess["changeGoal"] = (sessionId, action) =>
    Effect.gen(function* () {
      const current = yield* getGoal(sessionId);
      if (action.action === "get") return current;
      if (action.action === "clear" && current === undefined) return undefined;
      if (action.action === "clear" && current?.status === "cancelled") return current;
      const goal = yield* nextGoal(current, action);
      const payload = yield* Schema.decodeUnknown(GoalChangePayloadSchema, {
        onExcessProperty: "error",
      })({ goal }).pipe(Effect.mapError(() => invalidTransition("The Goal change is invalid.")));
      yield* journal.appendEntry(
        sessionId,
        EntryDraftSchema.make({ kind: "goal_change", payload }),
      );
      return goal ?? undefined;
    });

  const advanceGoal: GoalAccess["advanceGoal"] = (sessionId) =>
    Effect.gen(function* () {
      const current = yield* getGoal(sessionId);
      if (current?.status !== "active") return current;
      const goal: Goal = { ...current, continuations: current.continuations + 1 };
      yield* journal.appendEntry(
        sessionId,
        EntryDraftSchema.make({ kind: "goal_change", payload: { goal } }),
      );
      return goal;
    });

  return { advanceGoal, changeGoal, getGoal };
};
