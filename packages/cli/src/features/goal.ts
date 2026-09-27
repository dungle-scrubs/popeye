/** The first-party Goal Plugin uses the same Command and Tool surfaces as other Plugins. */
import { type GoalAction, GoalActionSchema } from "@dungle-scrubs/popeye-journal";
import {
  defineCommandContribution,
  defineToolContribution,
  type PluginManifest,
} from "@dungle-scrubs/popeye-plugins";
import { Data, Effect, Schema } from "effect";

const goalResult = (goal: unknown): string => JSON.stringify({ goal: goal ?? null });

const GoalToolParametersSchema = Schema.Struct({
  action: Schema.Literal("blocked", "clear", "complete", "get", "pause", "resume", "set"),
  evidence: Schema.optional(Schema.String),
  objective: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});

class GoalCommandSyntaxError extends Data.TaggedError("GoalCommandSyntaxError")<{
  readonly message: string;
}> {}

const parseGoalText = (text: string): Effect.Effect<GoalAction, GoalCommandSyntaxError> => {
  const input = text.trim();
  if (input === "") return Effect.succeed({ action: "get" });
  const parts = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input);
  if (parts === null || parts[1] === undefined) {
    return Effect.fail(new GoalCommandSyntaxError({ message: "Invalid /goal arguments." }));
  }
  const action = parts[1];
  const value = parts[2]?.trim();
  if (action === "get" || action === "pause" || action === "resume" || action === "clear") {
    return value === undefined
      ? Effect.succeed({ action })
      : Effect.fail(new GoalCommandSyntaxError({ message: `/goal ${action} takes no text.` }));
  }
  if (action === "set" || action === "blocked" || action === "complete") {
    if (value === undefined || value === "") {
      return Effect.fail(new GoalCommandSyntaxError({ message: `/goal ${action} needs text.` }));
    }
    return Effect.succeed(
      action === "set"
        ? { action, objective: value }
        : action === "blocked"
          ? { action, reason: value }
          : { action, evidence: value },
    );
  }
  return Effect.succeed({ action: "set", objective: input });
};

export const goalPlugin = {
  contributions: [
    defineCommandContribution({
      arguments: Schema.Union(GoalActionSchema, Schema.String),
      description:
        "Inspect or change the Session Goal. Actions: get, set, pause, resume, clear, blocked, complete.",
      execute: (input, context) =>
        (typeof input === "string" ? parseGoalText(input) : Effect.succeed(input)).pipe(
          Effect.flatMap((action) =>
            action.action === "get" ? context.getGoal() : context.changeGoal(action),
          ),
          Effect.map(goalResult),
        ),
      name: "goal",
    }),
    defineToolContribution({
      description:
        "Read or update the user's explicit Session Goal. Set or clear a Goal only when the user asks. Use complete with evidence when the objective is achieved; use blocked with a reason when progress needs user input or an external change.",
      execute: (input, context) =>
        Schema.decodeUnknown(GoalActionSchema, { onExcessProperty: "error" })(input).pipe(
          Effect.flatMap((action) =>
            action.action === "get" ? context.getGoal() : context.changeGoal(action),
          ),
          Effect.map((goal) => ({ content: goalResult(goal) })),
          Effect.catchAll((error) =>
            Effect.succeed({ content: `Goal update failed: ${String(error)}`, isError: true }),
          ),
        ),
      executionMode: "sequential",
      name: "manage-goal",
      parameters: GoalToolParametersSchema,
      replay: "never",
    }),
  ],
  manifest: {
    capabilities: [],
    description: "Keeps a durable Session Goal and lets the model update its progress.",
    name: "goal",
    version: "1.0.0",
  } satisfies PluginManifest,
} as const;
