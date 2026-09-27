import {
  createMemoryJournalBacking,
  type Goal,
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

test("manage-goal Tool shares the Goal action contract and reports update errors", async () => {
  const tool = goalPlugin.contributions.find(
    (contribution) => contribution.kind === "tool" && contribution.name === "manage-goal",
  );
  if (tool?.kind !== "tool") throw new Error("Goal Tool is missing.");

  let goal: Goal | undefined;
  const context = {
    changeGoal: (action: GoalAction) =>
      Effect.gen(function* () {
        if (action.action === "set") {
          goal = { continuations: 0, objective: action.objective, status: "active" };
        } else if (action.action === "complete") {
          if (goal === undefined) return yield* Effect.fail(new Error("No Goal is set."));
          goal = { ...goal, evidence: action.evidence, status: "complete" };
        }
        return goal;
      }),
    getGoal: () => Effect.succeed(goal),
    sessionId: Schema.decodeSync(Schema.String.pipe(Schema.brand("SessionId")))("goal-test"),
  };

  const missing = await Effect.runPromise(
    tool.payload.execute({ action: "complete", evidence: "None" }, context),
  );
  const invalid = await Effect.runPromise(tool.payload.execute({ action: "complete" }, context));
  const set = await Effect.runPromise(
    tool.payload.execute({ action: "set", objective: "Finish issue 39" }, context),
  );
  const read = await Effect.runPromise(tool.payload.execute({ action: "get" }, context));

  expect(missing).toMatchObject({ isError: true });
  expect(invalid).toMatchObject({ isError: true });
  expect(set.content).toContain('"status":"active"');
  expect(read.content).toBe(set.content);
  expect(tool.payload.executionMode).toBe("sequential");
  expect(tool.payload.replay).toBe("never");
  const parameters = JSONSchema.make(tool.payload.parameters) as unknown as Record<string, unknown>;
  expect(parameters.type).toBe("object");
  expect(parameters).not.toHaveProperty("$defs");
  expect(JSON.stringify(parameters)).not.toContain('"$ref"');
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
