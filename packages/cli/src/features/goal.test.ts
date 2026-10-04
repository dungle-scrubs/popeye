import {
  createMemoryJournalBacking,
  GOAL_TEXT_MAX_LENGTH,
  type GoalAction,
  JournalMemory,
} from "@dungle-scrubs/popeye-journal";
import { Deferred, Effect, Fiber, JSONSchema, Layer, Schema, Stream } from "effect";
import { expect, test } from "vitest";

import {
  Driver,
  defineTool,
  FirstPartyDriverDefault,
  Provider,
  ToolError,
  ToolRegistryLive,
} from "../compose.js";
import { runHcnHead } from "../heads/hcn.js";
import { runJsonHead } from "../heads/json.js";
import { runPrintHead } from "../heads/print.js";
import { captureWriter } from "../test-support/writer.js";
import { goalPlugin } from "./goal.js";

const driverLayer = FirstPartyDriverDefault().pipe(
  Layer.provide(
    Layer.mergeAll(
      JournalMemory(createMemoryJournalBacking()),
      Layer.succeed(Provider, {
        streamAssistant: () =>
          Stream.fromIterable([{ _tag: "done" as const, stopReason: "done" as const }]),
      }),
      ToolRegistryLive([]),
    ),
  ),
);

test("Goal Command persists state visible in the authoritative Snapshot", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      const initial = yield* driver.invokeCommand(session.id, "goal", { action: "get" });
      yield* driver.invokeCommand(session.id, "goal", {
        action: "set",
        objective: "Finish Popeye issue 39",
      });
      const active = yield* driver.getSnapshot(session.id);
      yield* driver.invokeCommand(session.id, "goal", { action: "pause" });
      const paused = yield* driver.getSnapshot(session.id);
      yield* driver.invokeCommand(session.id, "goal", { action: "resume" });
      yield* driver.invokeCommand(session.id, "goal", {
        action: "complete",
        evidence: "All focused checks passed",
      });
      const complete = yield* driver.getSnapshot(session.id);
      return { active, complete, initial, paused };
    }).pipe(Effect.provide(driverLayer)),
  );

  expect(result.initial).toBe('{"goal":null}');
  expect(result.active.goal).toMatchObject({
    continuations: 0,
    objective: "Finish Popeye issue 39",
    status: "active",
  });
  expect(result.paused.goal?.status).toBe("paused");
  expect(result.complete.goal).toMatchObject({
    evidence: "All focused checks passed",
    status: "complete",
  });
  expect(result.complete.entries.filter((entry) => entry.kind === "goal_change")).toHaveLength(4);
});

test("Goal Command retains replacement, blocked, clear, and terminal transition rules", async () => {
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      yield* driver.invokeCommand(session.id, "goal", { action: "clear" });
      const empty = yield* driver.getSnapshot(session.id);
      yield* driver.invokeCommand(session.id, "goal", { action: "set", objective: "Original" });
      yield* driver.invokeCommand(session.id, "goal", { action: "set", objective: "Replacement" });
      const replacement = yield* driver.getSnapshot(session.id);
      yield* driver.invokeCommand(session.id, "goal", { action: "blocked", reason: "Need input" });
      const blocked = yield* driver.getSnapshot(session.id);
      yield* driver.invokeCommand(session.id, "goal", { action: "pause" });
      yield* driver.invokeCommand(session.id, "goal", { action: "resume" });
      const resumed = yield* driver.getSnapshot(session.id);
      yield* driver.invokeCommand(session.id, "goal", { action: "clear" });
      const cancelled = yield* driver.getSnapshot(session.id);
      const get = yield* driver.invokeCommand(session.id, "goal", { action: "get" });
      yield* driver.invokeCommand(session.id, "goal", { action: "clear" });
      const rejected = yield* Effect.forEach(mutations, (action) =>
        Effect.either(driver.invokeCommand(session.id, "goal", action)),
      );
      const terminal = yield* driver.getSnapshot(session.id);
      yield* driver.invokeCommand(session.id, "goal", { action: "set", objective: "Fresh" });
      return {
        empty,
        replacement,
        blocked,
        resumed,
        cancelled,
        get,
        rejected,
        terminal,
        fresh: yield* driver.getSnapshot(session.id),
      };
    }).pipe(Effect.provide(driverLayer)),
  );
  expect(outcome.empty.goal).toBeUndefined();
  expect(outcome.empty.entries.filter((entry) => entry.kind === "goal_change")).toHaveLength(0);
  expect(outcome.replacement.goal).toEqual({
    continuations: 0,
    objective: "Replacement",
    status: "active",
  });
  expect(outcome.blocked.goal).toMatchObject({ status: "blocked", reason: "Need input" });
  expect(outcome.resumed.goal).toEqual({
    continuations: 0,
    objective: "Replacement",
    status: "active",
  });
  expect(outcome.cancelled.goal).toEqual({
    continuations: 0,
    objective: "Replacement",
    status: "cancelled",
  });
  expect(outcome.get).toBe(JSON.stringify({ goal: outcome.cancelled.goal }));
  expect(outcome.rejected.every((item) => item._tag === "Left")).toBe(true);
  expect(outcome.terminal.entries).toEqual(outcome.cancelled.entries);
  expect(outcome.fresh.goal).toEqual({ continuations: 0, objective: "Fresh", status: "active" });
});

test("Goal text parsing rejects malformed actions and accepts whitespace separators", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      const malformed = yield* Effect.forEach(
        ["pause now", "get extra", "set", "blocked", "complete"],
        (input) => Effect.either(driver.invokeCommand(session.id, "goal", input)),
      );
      const before = yield* driver.getSnapshot(session.id);
      yield* driver.invokeCommand(session.id, "goal", "set\tObjective with a tab");
      return { before, malformed, after: yield* driver.getSnapshot(session.id) };
    }).pipe(Effect.provide(driverLayer)),
  );
  expect(result.malformed.every((item) => item._tag === "Left")).toBe(true);
  expect(result.before.goal).toBeUndefined();
  expect(result.after.goal?.objective).toBe("Objective with a tab");
});

const manageGoalContribution = goalPlugin.contributions.find(
  (contribution) => contribution.kind === "tool" && contribution.name === "manage-goal",
);
if (manageGoalContribution?.kind !== "tool") throw new Error("Goal Tool is missing.");
const manageGoal = manageGoalContribution.payload;
const manageGoalTool = defineTool({
  description: manageGoal.description,
  execute: (input, context) =>
    manageGoal.execute(input as never, context).pipe(
      Effect.mapError(
        (error) =>
          new ToolError({
            message: error.message,
            toolCallId: error.toolCallId,
            toolName: error.toolName,
          }),
      ),
    ),
  ...(manageGoal.executionMode === undefined ? {} : { executionMode: manageGoal.executionMode }),
  name: manageGoal.name,
  parameters: manageGoal.parameters,
  ...(manageGoal.replay === undefined ? {} : { replay: manageGoal.replay }),
});

const USER_ONLY_ERROR =
  "Only the user can create, replace, resume, or clear a Goal. Use /goal <objective>, /goal resume, or /goal clear.";
const NO_ACTIVE_ERROR = "No active Goal is set. Only the user can start or resume a Goal.";
const INVALID_ARGUMENTS_ERROR =
  "Invalid manage-goal arguments. Use get, pause, blocked with a reason, or complete with evidence.";
const GOAL_DESCRIPTION =
  "Read the Session Goal. For an active Goal, report completion with evidence, report a blocker with a reason, or pause work. Only the user can create, replace, resume, or clear a Goal through the goal Command. Earlier user requests do not authorize Goal activation.";
const OBJECTIVE = "Finish and verify the task";
const runtimeForbiddenError = (action: "set" | "resume" | "clear"): string => {
  const header =
    'Invalid arguments for tool manage-goal: { readonly action: "blocked" | "complete" | "get" | "pause"; readonly evidence?: string | undefined; readonly reason?: string | undefined }';
  return action === "set"
    ? `${header}\n└─ ["objective"]\n   └─ is unexpected, expected: "action" | "evidence" | "reason"`
    : `${header}\n└─ ["action"]\n   └─ "blocked" | "complete" | "get" | "pause"\n      ├─ Expected "blocked", actual "${action}"\n      ├─ Expected "complete", actual "${action}"\n      ├─ Expected "get", actual "${action}"\n      └─ Expected "pause", actual "${action}"`;
};
const mutations = [
  { action: "pause" },
  { action: "blocked", reason: "Waiting for the user" },
  { action: "complete", evidence: "Focused checks passed" },
] as const;
const goalSetups: ReadonlyArray<{
  readonly name: string;
  readonly actions: ReadonlyArray<GoalAction>;
}> = [
  { name: "missing", actions: [] },
  { name: "active", actions: [{ action: "set", objective: OBJECTIVE }] },
  { name: "paused", actions: [{ action: "set", objective: OBJECTIVE }, { action: "pause" }] },
  {
    name: "blocked",
    actions: [
      { action: "set", objective: OBJECTIVE },
      { action: "blocked", reason: "Need input" },
    ],
  },
  {
    name: "complete",
    actions: [
      { action: "set", objective: OBJECTIVE },
      { action: "complete", evidence: "Verified" },
    ],
  },
  { name: "cancelled", actions: [{ action: "set", objective: OBJECTIVE }, { action: "clear" }] },
];

const executeGoalDirectly = (input: unknown, setup: ReadonlyArray<GoalAction>) =>
  Effect.gen(function* () {
    const driver = yield* Driver;
    const session = yield* driver.createSession();
    yield* Effect.forEach(setup, (action) => driver.invokeCommand(session.id, "goal", action));
    const before = yield* driver.getSnapshot(session.id);
    const calls: Array<GoalAction> = [];
    const context = {
      changeGoal: (action: GoalAction) =>
        Effect.sync(() => calls.push(action)).pipe(
          Effect.zipRight(driver.invokeCommand(session.id, "goal", action)),
          Effect.zipRight(driver.getSnapshot(session.id)),
          Effect.map((snapshot) => snapshot.goal),
        ),
      getGoal: () => driver.getSnapshot(session.id).pipe(Effect.map((snapshot) => snapshot.goal)),
      sessionId: session.id,
    };
    // Exercise runtime rejection even when the declaration's TypeScript type excludes the input.
    const result = yield* manageGoal.execute(input as never, context);
    return { before, calls, result, after: yield* driver.getSnapshot(session.id) };
  }).pipe(Effect.provide(driverLayer));

const runGoalToolTurn = (input: unknown, setup: ReadonlyArray<GoalAction>, abortFirst = false) => {
  let requests = 0;
  let sawAbortedPrompt = false;
  const countingPrompt = "Count upward from 1, one integer per line, until interrupted.";
  const started = Effect.runSync(Deferred.make<void>());
  const layer = FirstPartyDriverDefault().pipe(
    Layer.provide(
      Layer.mergeAll(
        JournalMemory(createMemoryJournalBacking()),
        ToolRegistryLive([manageGoalTool]),
        Layer.succeed(Provider, {
          streamAssistant: (context) => {
            requests += 1;
            if (abortFirst && requests === 1) {
              return Stream.fromEffect(
                Deferred.succeed(started, undefined).pipe(Effect.zipRight(Effect.never)),
              );
            }
            const round = requests - (abortFirst ? 1 : 0);
            if (round === 1) {
              sawAbortedPrompt = context.some(
                (item) => item.role === "user" && item.content === countingPrompt,
              );
            }
            // Bound the baseline defect: stop an unexpected continuation instead of running 40.
            if (round === 1 || round === 3) {
              return Stream.fromIterable([
                {
                  _tag: "toolCall" as const,
                  argumentsJson: JSON.stringify(round === 1 ? input : { action: "pause" }),
                  id: round === 1 ? "model-goal-call" : "safety-pause",
                  name: "manage-goal",
                },
                { _tag: "done" as const, stopReason: "toolCalls" as const },
              ]);
            }
            return Stream.fromIterable([
              { _tag: "textDelta" as const, text: "Normal answer." },
              { _tag: "done" as const, stopReason: "done" as const },
            ]);
          },
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const driver = yield* Driver;
    const session = yield* driver.createSession();
    yield* Effect.forEach(setup, (action) => driver.invokeCommand(session.id, "goal", action));
    const firstTurn = abortFirst
      ? yield* Effect.gen(function* () {
          const first = yield* Effect.fork(driver.prompt(session.id, countingPrompt));
          yield* Deferred.await(started);
          const aborted = yield* driver.abortTurn(session.id);
          return { aborted, settlement: yield* Fiber.join(first) };
        })
      : undefined;
    const before = yield* driver.getSnapshot(session.id);
    const settled = yield* driver.prompt(session.id, "Reply with only SESSION-USABLE.");
    const after = yield* driver.getSnapshot(session.id);
    const toolResult = after.entries.find(
      (entry) =>
        entry.kind === "message" &&
        (entry.payload as { readonly toolCallId?: unknown }).toolCallId === "model-goal-call",
    )?.payload;
    return {
      aborted: firstTurn?.aborted,
      after,
      before,
      firstSettlement: firstTurn?.settlement,
      requests,
      sawAbortedPrompt,
      settled,
      toolResult,
    };
  }).pipe(Effect.provide(layer), Effect.timeout("2 seconds"));
};

test("manage-goal advertises only reporting actions and no objective", () => {
  const parameters = JSONSchema.make(manageGoal.parameters) as unknown as Record<string, unknown>;
  expect(parameters.type).toBe("object");
  expect(parameters).not.toHaveProperty("$defs");
  expect(JSON.stringify(parameters)).not.toContain('"$ref"');
  expect(parameters.required).toEqual(["action"]);
  expect(parameters.additionalProperties).toBe(false);
  expect(Object.keys(parameters.properties as Record<string, unknown>).sort()).toEqual([
    "action",
    "evidence",
    "reason",
  ]);
  expect(parameters).toHaveProperty("properties.action.enum", [
    "blocked",
    "complete",
    "get",
    "pause",
  ]);
  expect(manageGoal.executionMode).toBe("sequential");
  expect(manageGoal.replay).toBe("never");
});

test("manage-goal description states user-owned activation and active-only reporting", () => {
  expect(manageGoal.description).toBe(GOAL_DESCRIPTION);
});

for (const action of ["set", "replace", "resume", "clear"] as const) {
  for (const setup of goalSetups) {
    test(`manage-goal rejects user-only ${action} with a ${setup.name} Goal without calling changeGoal`, async () => {
      const input =
        action === "set" || action === "replace"
          ? { action, objective: "Unauthorized" }
          : { action };
      const outcome = await Effect.runPromise(executeGoalDirectly(input, setup.actions));
      expect.soft(outcome.result).toEqual({ content: USER_ONLY_ERROR, isError: true });
      expect.soft(outcome.calls).toEqual([]);
      expect.soft(outcome.after.entries).toEqual(outcome.before.entries);
      expect.soft(outcome.after.goal).toEqual(outcome.before.goal);
    });
  }
}

for (const setup of goalSetups) {
  test(`manage-goal get reads a ${setup.name} Goal without mutation`, async () => {
    const outcome = await Effect.runPromise(executeGoalDirectly({ action: "get" }, setup.actions));
    expect(outcome.result).toEqual({
      content: JSON.stringify({ goal: outcome.before.goal ?? null }),
    });
    expect(outcome.calls).toEqual([]);
    expect(outcome.after.entries).toEqual(outcome.before.entries);
  });
  if (setup.name === "active") continue;
  for (const mutation of mutations) {
    test(`manage-goal ${mutation.action} rejects a ${setup.name} Goal without an Entry or continuation`, async () => {
      const outcome = await Effect.runPromise(runGoalToolTurn(mutation, setup.actions));
      expect.soft(outcome.toolResult).toMatchObject({ content: NO_ACTIVE_ERROR, isError: true });
      expect.soft(outcome.after.goal).toEqual(outcome.before.goal);
      expect
        .soft(outcome.after.entries.filter((entry) => entry.kind === "goal_change"))
        .toEqual(outcome.before.entries.filter((entry) => entry.kind === "goal_change"));
      expect
        .soft(outcome.after.entries.filter((entry) => entry.kind === "goal_continuation"))
        .toHaveLength(0);
      expect.soft(outcome.requests).toBe(2);
      expect.soft(outcome.settled).toEqual({ stopReason: "done" });
    });
  }
}

for (const mutation of mutations) {
  test(`manage-goal ${mutation.action} reports on an active user-created Goal`, async () => {
    const outcome = await Effect.runPromise(
      runGoalToolTurn(mutation, [{ action: "set", objective: OBJECTIVE }]),
    );
    const status =
      mutation.action === "blocked"
        ? "blocked"
        : mutation.action === "complete"
          ? "complete"
          : "paused";
    const expectedGoal = {
      continuations: 0,
      objective: OBJECTIVE,
      status,
      ...(mutation.action === "blocked" ? { reason: mutation.reason } : {}),
      ...(mutation.action === "complete" ? { evidence: mutation.evidence } : {}),
    };
    const toolResult = Schema.decodeUnknownSync(
      Schema.Struct({ content: Schema.String, isError: Schema.Boolean }),
    )(outcome.toolResult);
    expect(toolResult.isError).toBe(false);
    expect(JSON.parse(toolResult.content)).toEqual({ goal: expectedGoal });
    expect(outcome.after.goal).toEqual(expectedGoal);
    expect(outcome.after.entries.filter((entry) => entry.kind === "goal_change")).toHaveLength(2);
    expect(
      outcome.after.entries.filter((entry) => entry.kind === "goal_continuation"),
    ).toHaveLength(0);
    expect(outcome.requests).toBe(2);
    expect(outcome.settled).toEqual({ stopReason: "done" });
  });
}

for (const action of ["blocked", "complete"] as const) {
  test(`manage-goal ${action} accepts text at the shared Goal length limit`, async () => {
    const text = ` ${"x".repeat(GOAL_TEXT_MAX_LENGTH - 2)} `;
    const input = action === "blocked" ? { action, reason: text } : { action, evidence: text };
    const outcome = await Effect.runPromise(
      executeGoalDirectly(input, [{ action: "set", objective: OBJECTIVE }]),
    );
    expect(outcome.result.isError).not.toBe(true);
    expect(outcome.calls).toEqual([input]);
    expect(outcome.after.goal).toMatchObject(
      action === "blocked"
        ? { status: "blocked", reason: text }
        : { status: "complete", evidence: text },
    );
  });
}

const malformedInputs: ReadonlyArray<{ readonly name: string; readonly input: unknown }> = [
  { name: "null", input: null },
  { name: "string", input: "pause" },
  { name: "array", input: [] },
  { name: "missing action", input: {} },
  { name: "unknown action", input: { action: "restart" } },
  { name: "objective on get", input: { action: "get", objective: OBJECTIVE } },
  { name: "objective on pause", input: { action: "pause", objective: OBJECTIVE } },
  { name: "reason on pause", input: { action: "pause", reason: "Unexpected" } },
  { name: "evidence on get", input: { action: "get", evidence: "Unexpected" } },
  { name: "missing reason", input: { action: "blocked" } },
  { name: "empty reason", input: { action: "blocked", reason: "" } },
  { name: "whitespace reason", input: { action: "blocked", reason: " \t\n" } },
  { name: "non-string reason", input: { action: "blocked", reason: 42 } },
  {
    name: "overlong reason",
    input: { action: "blocked", reason: "x".repeat(GOAL_TEXT_MAX_LENGTH + 1) },
  },
  {
    name: "evidence on blocked",
    input: { action: "blocked", reason: "Needed", evidence: "Unexpected" },
  },
  { name: "missing evidence", input: { action: "complete" } },
  { name: "empty evidence", input: { action: "complete", evidence: "" } },
  { name: "whitespace evidence", input: { action: "complete", evidence: " \t\n" } },
  { name: "non-string evidence", input: { action: "complete", evidence: 42 } },
  {
    name: "overlong evidence",
    input: { action: "complete", evidence: "x".repeat(GOAL_TEXT_MAX_LENGTH + 1) },
  },
  {
    name: "reason on complete",
    input: { action: "complete", evidence: "Verified", reason: "Unexpected" },
  },
];
for (const { name, input } of malformedInputs) {
  test(`manage-goal rejects malformed ${name} before mutation`, async () => {
    const outcome = await Effect.runPromise(
      executeGoalDirectly(input, [{ action: "set", objective: OBJECTIVE }]),
    );
    expect.soft(outcome.result).toEqual({ content: INVALID_ARGUMENTS_ERROR, isError: true });
    expect.soft(outcome.calls).toEqual([]);
    expect.soft(outcome.after.entries).toEqual(outcome.before.entries);
  });
}

for (const action of ["set", "resume", "clear"] as const) {
  test(`scripted Provider manage-goal ${action} cannot create or restart autonomous work`, async () => {
    const setup: ReadonlyArray<GoalAction> =
      action === "set" ? [] : [{ action: "set", objective: OBJECTIVE }, { action: "pause" }];
    const input = action === "set" ? { action, objective: OBJECTIVE } : { action };
    const outcome = await Effect.runPromise(runGoalToolTurn(input, setup));
    expect
      .soft(outcome.toolResult)
      .toMatchObject({ content: runtimeForbiddenError(action), isError: true });
    expect
      .soft(outcome.after.entries.filter((entry) => entry.kind === "goal_change"))
      .toEqual(outcome.before.entries.filter((entry) => entry.kind === "goal_change"));
    expect
      .soft(outcome.after.entries.filter((entry) => entry.kind === "goal_continuation"))
      .toHaveLength(0);
    expect.soft(outcome.after.goal).toEqual(outcome.before.goal);
    expect.soft(outcome.requests).toBe(2);
    expect.soft(outcome.settled).toEqual({ stopReason: "done" });
  });
}

test("aborted counting request cannot be re-created as a Goal by a later Turn", async () => {
  const objective = "Count upward from 1, one integer per line, until interrupted.";
  const outcome = await Effect.runPromise(runGoalToolTurn({ action: "set", objective }, [], true));
  expect.soft(outcome.aborted).toEqual({ aborted: true, turnOrdinal: 1 });
  expect.soft(outcome.firstSettlement).toEqual({ stopReason: "aborted" });
  expect.soft(outcome.before.goal).toBeUndefined();
  expect.soft(outcome.sawAbortedPrompt).toBe(true);
  expect
    .soft(outcome.toolResult)
    .toMatchObject({ content: runtimeForbiddenError("set"), isError: true });
  expect
    .soft(outcome.after.entries.filter((entry) => entry.kind === "goal_change"))
    .toHaveLength(0);
  expect
    .soft(outcome.after.entries.filter((entry) => entry.kind === "goal_continuation"))
    .toHaveLength(0);
  expect.soft(outcome.after.goal).toBeUndefined();
  expect.soft(outcome.requests).toBe(3);
  expect.soft(outcome.settled).toEqual({ stopReason: "done" });
  expect
    .soft(outcome.after.entries.at(-1)?.payload)
    .toMatchObject({ role: "assistant", content: "Normal answer.", stopReason: "done" });
});

test("/goal text Commands run through the plugin without calling the Provider", async () => {
  let providerCalls = 0;
  const layer = FirstPartyDriverDefault().pipe(
    Layer.provide(
      Layer.mergeAll(
        JournalMemory(createMemoryJournalBacking()),
        Layer.succeed(Provider, {
          streamAssistant: () => {
            providerCalls += 1;
            return Stream.fromIterable([{ _tag: "done" as const, stopReason: "done" as const }]);
          },
        }),
        ToolRegistryLive([]),
      ),
    ),
  );
  const printed = captureWriter();
  const printExit = await Effect.runPromise(
    runPrintHead({
      prompts: [
        "/goal Finish Popeye issue 39",
        "/goal",
        "/goal pause",
        "/goal resume",
        "/goal blocked Waiting for input",
        "/goal resume",
        "/goal complete All checks passed",
      ],
      writer: printed.writer,
    }).pipe(Effect.provide(layer)),
  );
  const lines = printed
    .output()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(printExit).toBe(0);
  expect(lines.map((line) => line.goal?.status)).toEqual([
    "active",
    "active",
    "paused",
    "active",
    "blocked",
    "active",
    "complete",
  ]);

  const json = captureWriter();
  const jsonExit = await Effect.runPromise(
    runJsonHead({ prompts: ["/goal set Check the JSON Snapshot"], writer: json.writer }).pipe(
      Effect.provide(layer),
    ),
  );
  expect(jsonExit).toBe(0);
  const jsonLines = json
    .output()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(jsonLines.at(-1)).toMatchObject({ goal: { objective: "Check the JSON Snapshot" } });

  const hcn = captureWriter();
  const hcnExit = await Effect.runPromise(
    runHcnHead({ prompts: ["/goal Check the HCN output"], writer: hcn.writer }).pipe(
      Effect.provide(layer),
    ),
  );
  expect(hcnExit).toBe(0);
  const hcnLines = hcn
    .output()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(hcnLines.map((line) => line.kind)).toEqual(["identity", "message", "done"]);
  expect(JSON.parse(hcnLines[1]?.text)).toMatchObject({
    goal: { objective: "Check the HCN output", status: "active" },
  });

  const malformed = captureWriter();
  const malformedExit = await Effect.runPromise(
    runPrintHead({
      errorWriter: malformed.writer,
      prompts: ["/Goal set Incorrect syntax"],
      writer: malformed.writer,
    }).pipe(Effect.provide(layer)),
  );
  expect(malformedExit).not.toBe(0);
  expect(malformed.output()).toContain("SlashCommandSyntaxError");
  expect(providerCalls).toBe(0);
});

test("one-shot Heads wait for the Goal continuation and retain Progress from both Turns", async () => {
  let requests = 0;
  const finishGoal = defineTool({
    description: "Finish the explicit Goal.",
    execute: (_input, context) =>
      context
        .changeGoal({ action: "complete", evidence: "Continuation finished the task." })
        .pipe(Effect.orDie, Effect.as({ content: "Goal complete." })),
    name: "finish-goal",
    parameters: Schema.Struct({}),
  });
  const layer = FirstPartyDriverDefault().pipe(
    Layer.provide(
      Layer.mergeAll(
        JournalMemory(createMemoryJournalBacking()),
        Layer.succeed(Provider, {
          streamAssistant: () => {
            requests += 1;
            return requests === 1
              ? Stream.fromIterable([
                  { _tag: "textDelta" as const, text: "Stopped early." },
                  { _tag: "done" as const, stopReason: "done" as const },
                ])
              : requests === 2
                ? Stream.fromIterable([
                    {
                      _tag: "toolCall" as const,
                      argumentsJson: "{}",
                      id: "finish-goal-call",
                      name: "finish-goal",
                    },
                    { _tag: "done" as const, stopReason: "toolCalls" as const },
                  ])
                : Stream.fromIterable([
                    { _tag: "textDelta" as const, text: "Final answer." },
                    { _tag: "done" as const, stopReason: "done" as const },
                  ]);
          },
        }),
        ToolRegistryLive([finishGoal]),
      ),
    ),
  );
  const output = captureWriter();
  const jsonOutput = captureWriter();
  const resumedOutput = captureWriter();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      yield* driver.invokeCommand(session.id, "goal", "Finish the assigned task");
      const exit = yield* runPrintHead({
        prompts: ["Start work"],
        sessionId: session.id,
        writer: output.writer,
      });
      const snapshot = yield* driver.getSnapshot(session.id);
      const printRequests = requests;
      requests = 0;
      const jsonSession = yield* driver.createSession();
      yield* driver.invokeCommand(jsonSession.id, "goal", "Finish the JSON task");
      const jsonExit = yield* runJsonHead({
        prompts: ["Start JSON work"],
        sessionId: jsonSession.id,
        writer: jsonOutput.writer,
      });
      const jsonRequests = requests;
      requests = 0;
      const resumedSession = yield* driver.createSession();
      yield* driver.invokeCommand(resumedSession.id, "goal", "Finish after resume");
      const resumeExit = yield* runPrintHead({
        prompts: [],
        sessionId: resumedSession.id,
        writer: resumedOutput.writer,
      });
      return { exit, jsonExit, jsonRequests, printRequests, resumeExit, snapshot };
    }).pipe(Effect.provide(layer)),
  );
  expect(result.exit).toBe(0);
  expect(output.output()).toBe("Final answer.\n");
  expect(result.snapshot.goal?.status).toBe("complete");
  expect(result.printRequests).toBe(3);
  expect(result.jsonExit).toBe(0);
  expect(result.jsonRequests).toBe(3);
  const frames = jsonOutput
    .output()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(frames.filter((frame) => frame._tag === "turnSettled")).toHaveLength(2);
  expect(frames.at(-1)).toMatchObject({ goal: { status: "complete" } });
  expect(result.resumeExit).toBe(0);
  expect(resumedOutput.output()).toBe("Final answer.\n");
  expect(requests).toBe(3);
});

test("queued Goal pause does not strand JSON Progress waiting for a later settlement", async () => {
  const started = Effect.runSync(Deferred.make<void>());
  const release = Effect.runSync(Deferred.make<void>());
  const layer = FirstPartyDriverDefault().pipe(
    Layer.provide(
      Layer.mergeAll(
        JournalMemory(createMemoryJournalBacking()),
        Layer.succeed(Provider, {
          streamAssistant: () =>
            Stream.fromEffect(
              Deferred.succeed(started, undefined).pipe(
                Effect.zipRight(Deferred.await(release)),
                Effect.as({ _tag: "done" as const, stopReason: "done" as const }),
              ),
            ),
        }),
        ToolRegistryLive([]),
      ),
    ),
  );
  const output = captureWriter();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      yield* driver.invokeCommand(session.id, "goal", "Finish this task");
      const head = yield* Effect.fork(
        runJsonHead({ prompts: ["Start"], sessionId: session.id, writer: output.writer }),
      );
      yield* Deferred.await(started);
      const pause = yield* Effect.fork(
        driver.invokeCommand(session.id, "goal", { action: "pause" }),
      );
      yield* Effect.yieldNow();
      yield* Deferred.succeed(release, undefined);
      const exit = yield* Fiber.join(head).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(pause);
      return { exit, snapshot: yield* driver.getSnapshot(session.id) };
    }).pipe(Effect.provide(layer)),
  );
  expect(result.exit).toBe(0);
  expect(result.snapshot.goal?.status).toBe("paused");
  const frames = output
    .output()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(frames.filter((frame) => frame._tag === "turnSettled")).toHaveLength(1);
});

test("a sole /goal resume restarts the paused Goal and returns its final answer", async () => {
  let requests = 0;
  const finishGoal = defineTool({
    description: "Finish the Goal.",
    execute: (_input, context) =>
      context
        .changeGoal({ action: "complete", evidence: "Resume finished the task." })
        .pipe(Effect.orDie, Effect.as({ content: "Complete." })),
    name: "finish-goal",
    parameters: Schema.Struct({}),
  });
  const layer = FirstPartyDriverDefault().pipe(
    Layer.provide(
      Layer.mergeAll(
        JournalMemory(createMemoryJournalBacking()),
        Layer.succeed(Provider, {
          streamAssistant: () => {
            requests += 1;
            return requests === 1
              ? Stream.fromIterable([
                  {
                    _tag: "toolCall" as const,
                    argumentsJson: "{}",
                    id: "resume-finish",
                    name: "finish-goal",
                  },
                  { _tag: "done" as const, stopReason: "toolCalls" as const },
                ])
              : Stream.fromIterable([
                  { _tag: "textDelta" as const, text: "Resumed and done." },
                  { _tag: "done" as const, stopReason: "done" as const },
                ]);
          },
        }),
        ToolRegistryLive([finishGoal]),
      ),
    ),
  );
  const output = captureWriter();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      yield* driver.invokeCommand(session.id, "goal", "Finish after pause");
      yield* driver.invokeCommand(session.id, "goal", "pause");
      const exit = yield* runPrintHead({
        prompts: ["/goal resume"],
        sessionId: session.id,
        writer: output.writer,
      });
      return { exit, snapshot: yield* driver.getSnapshot(session.id) };
    }).pipe(Effect.provide(layer)),
  );
  expect(result.exit).toBe(0);
  expect(output.output()).toBe("Resumed and done.\n");
  expect(result.snapshot.goal?.status).toBe("complete");
  expect(requests).toBe(2);
});
