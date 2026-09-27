/** A Goal is Branch-derived state recorded as an Entry, never a Record. */
import { Effect, Schema } from "effect";

import { JournalError } from "./errors.js";
import type { Entry } from "./shapes.js";

export const GOAL_TEXT_MAX_LENGTH = 2_000;

const MeaningfulTextSchema = Schema.String.pipe(
  Schema.filter((value) => value.trim().length > 0, {
    message: () => "Goal text must contain a non-whitespace character",
  }),
  Schema.maxLength(GOAL_TEXT_MAX_LENGTH),
);

const GoalBaseSchema = Schema.Struct({
  continuations: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  objective: MeaningfulTextSchema,
});

export const GoalSchema = Schema.Union(
  Schema.extend(
    GoalBaseSchema,
    Schema.Struct({ status: Schema.Literal("active", "paused", "cancelled") }),
  ),
  Schema.extend(
    GoalBaseSchema,
    Schema.Struct({ reason: MeaningfulTextSchema, status: Schema.Literal("blocked") }),
  ),
  Schema.extend(
    GoalBaseSchema,
    Schema.Struct({ evidence: MeaningfulTextSchema, status: Schema.Literal("complete") }),
  ),
);

export type Goal = Schema.Schema.Type<typeof GoalSchema>;

export const GoalActionSchema = Schema.Union(
  Schema.Struct({ action: Schema.Literal("get", "pause", "resume", "clear") }),
  Schema.Struct({ action: Schema.Literal("set"), objective: GoalBaseSchema.fields.objective }),
  Schema.Struct({ action: Schema.Literal("blocked"), reason: MeaningfulTextSchema }),
  Schema.Struct({ action: Schema.Literal("complete"), evidence: MeaningfulTextSchema }),
);

export type GoalAction = Schema.Schema.Type<typeof GoalActionSchema>;

export const GoalChangePayloadSchema = Schema.Struct({ goal: Schema.NullOr(GoalSchema) });

export type GoalChangePayload = Schema.Schema.Type<typeof GoalChangePayloadSchema>;

const decodeGoalChange = Schema.decodeUnknown(GoalChangePayloadSchema, {
  onExcessProperty: "error",
});

/** Newest change on the current root-to-leaf Branch wins; null represents a legacy clear. */
export const deriveGoal = (
  branch: ReadonlyArray<Entry>,
): Effect.Effect<Goal | undefined, JournalError> =>
  Effect.gen(function* () {
    let goal: Goal | undefined;
    for (const entry of branch) {
      if (entry.kind !== "goal_change") continue;
      const payload = yield* decodeGoalChange(entry.payload).pipe(
        Effect.mapError(
          (cause) =>
            new JournalError({
              cause,
              corruptionClass: "schema_mismatch",
              message: `Entry ${entry.id} payload does not match goal_change: ${String(cause)}`,
            }),
        ),
      );
      goal = payload.goal ?? undefined;
    }
    return goal;
  });
