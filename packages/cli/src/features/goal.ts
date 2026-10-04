/** The first-party Goal Plugin: the user owns activation through the Command; the model reports on the active Goal. */
import { type Goal, type GoalAction, GoalActionSchema } from "@dungle-scrubs/popeye-journal";
import {
  defineCommandContribution,
  defineToolContribution,
  type PluginManifest,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from "@dungle-scrubs/popeye-plugins";
import { Data, Effect, Either, Schema } from "effect";

const goalResult = (goal: unknown): string => JSON.stringify({ goal: goal ?? null });

const USER_ONLY_ERROR =
  "Only the user can create, replace, resume, or clear a Goal. Use /goal <objective>, /goal resume, or /goal clear.";
const NO_ACTIVE_ERROR = "No active Goal is set. Only the user can start or resume a Goal.";
const INVALID_ARGUMENTS_ERROR =
  "Invalid manage-goal arguments. Use get, pause, blocked with a reason, or complete with evidence.";

const userOnlyResult = (): ToolExecutionResult => ({ content: USER_ONLY_ERROR, isError: true });
const noActiveResult = (): ToolExecutionResult => ({ content: NO_ACTIVE_ERROR, isError: true });
const invalidArgumentsResult = (): ToolExecutionResult => ({
  content: INVALID_ARGUMENTS_ERROR,
  isError: true,
});
const goalUpdateFailed = (error: unknown): Effect.Effect<ToolExecutionResult> =>
  Effect.succeed({
    content: `Goal update failed: ${String(error)}`,
    isError: true,
  });
const goalReadResult = (goal: Goal | undefined): ToolExecutionResult => ({
  content: goalResult(goal),
});
const goalWriteResult = (goal: Goal | undefined): ToolExecutionResult => ({
  content: goalResult(goal),
});

const GoalToolParametersSchema = Schema.Struct({
  action: Schema.Literal("blocked", "complete", "get", "pause"),
  evidence: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});

/** Allowed Tool actions, sharing the shared text validation and length limit with the Command. */
const GoalToolActionSchema = Schema.Union(
  Schema.Struct({ action: Schema.Literal("get", "pause") }),
  GoalActionSchema.members[2],
  GoalActionSchema.members[3],
);

/** Default excess-property handling is "ignore"; only an `action` literal check is needed. */
const isUserOnlyAction = Schema.is(
  Schema.Struct({ action: Schema.Literal("set", "replace", "resume", "clear") }),
);

const strict = { onExcessProperty: "error" } as const;

const decodeParameters = Schema.decodeUnknown(GoalToolParametersSchema, strict);
const decodeAction = Schema.decodeUnknown(GoalToolActionSchema, strict);

const dispatch = (action: typeof GoalToolActionSchema.Type, context: ToolExecutionContext) =>
  Effect.gen(function* () {
    if (action.action === "get") {
      const goal = yield* context.getGoal();
      return goalReadResult(goal);
    }
    const goal = yield* context.getGoal();
    if (goal === undefined || goal.status !== "active") {
      return noActiveResult();
    }
    const updated = yield* context.changeGoal(action);
    return goalWriteResult(updated);
  }).pipe(Effect.catchAll(goalUpdateFailed));

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
        "Read the Session Goal. For an active Goal, report completion with evidence, report a blocker with a reason, or pause work. Only the user can create, replace, resume, or clear a Goal through the goal Command. Earlier user requests do not authorize Goal activation.",
      execute: (input, context) =>
        Effect.gen(function* () {
          if (isUserOnlyAction(input)) {
            return userOnlyResult();
          }
          const decoded = yield* Effect.either(decodeParameters(input));
          if (Either.isLeft(decoded)) {
            return invalidArgumentsResult();
          }
          const action = yield* Effect.either(decodeAction(decoded.right));
          if (Either.isLeft(action)) {
            return invalidArgumentsResult();
          }
          return yield* dispatch(action.right, context);
        }),
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
