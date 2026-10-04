/**
 * Issue #88: Turns the Kernel opens on its own carry the Session's persona and model.
 * An rpc Agent Session (#55) and a plain Session with a journaled set-model and set-thinking run
 * every opener through the real rpc Head, bridge, and Driver: a prompt, a resume-goal
 * continuation, a Goal restart (invoke-command goal resume, then resume-goal), and a steer that
 * becomes a detached Follow-up. The print Head's turn options (--agent body, --effort) reach a
 * sole /goal resume restart and a resumed Goal the same way. An automatic Goal continuation after
 * an rpc prompt is a regression guard. The Head session loop binds only the Session fields of its
 * turn options, forwards the delivery fields with each prompt, and releases the binding on every
 * exit, interruption at the bind included. A recording Provider captures the
 * request each opened Turn sends. The Agent resolver is a stub returning a plan with no tools
 * list, so no Tool grant filter is involved.
 */
import { PassThrough } from "node:stream";

import {
  createMemoryJournalBacking,
  Journal,
  type JournalError,
  JournalMemory,
  type SessionId,
} from "@dungle-scrubs/popeye-journal";
import { Deferred, Effect, Exit, Fiber, Layer, Ref, Schema, Stream } from "effect";
import { describe, expect, test } from "vitest";

import type { AgentSessionPlan, AgentSessionResolver } from "../agents/session-agent.js";
import {
  type AssistantItem,
  Driver,
  type DriverService,
  defineTool,
  FirstPartyDriverDefault,
  Provider,
  ProviderError,
  type ProviderService,
  ToolRegistryLive,
} from "../compose.js";
import { captureWriter } from "../test-support/writer.js";
import type { HeadWriter } from "./head-wire.js";
import { runPrintHead } from "./print.js";
import { RpcInteractionsLive, runRpcHead } from "./rpc.js";
import { runSessionLoop } from "./session-loop.js";

const PERSONA = "Reviewer persona body.";
const AGENT_MODEL = "agent-model";
const DEADLOCK_GUARD = "5 seconds";
const TEST_TIMEOUT_MS = 20_000;

type Frame = Readonly<Record<string, unknown>>;

interface RecordedRequest {
  readonly lastUser: string;
  readonly model: string | undefined;
  readonly purpose: string | undefined;
  readonly system: string;
  readonly thinkingLevel: string | undefined;
}

const answer = (text: string): Stream.Stream<AssistantItem> =>
  Stream.make(
    { _tag: "textDelta" as const, text },
    { _tag: "done" as const, stopReason: "done" as const },
  );

/**
 * Records every request. While a Goal is active (its instruction is in the system content) and
 * the Turn has no Tool result yet, it calls finish-goal, so each Goal chain is one Turn long;
 * otherwise it answers "ok". With `holdGoalTurns` set, the first that many Goal Turns answer "ok"
 * and leave the Goal active, so the Kernel schedules a Goal continuation after them.
 */
const recordingProvider = (config: { readonly holdGoalTurns?: number } = {}) => {
  const requests: Array<RecordedRequest> = [];
  let heldGoalTurns = 0;
  const service: ProviderService = {
    streamAssistant: (context, options) => {
      const system = context
        .filter((item) => item.role === "system")
        .map((item) => item.content)
        .join("\n");
      requests.push({
        lastUser: [...context].reverse().find((item) => item.role === "user")?.content ?? "",
        model: options.model,
        purpose: options.purpose,
        system,
        thinkingLevel: options.thinkingLevel,
      });
      if (options.purpose === "compaction") {
        return answer("summary");
      }
      const goalTurn = system.includes("Active Goal:") && context.at(-1)?.role !== "toolResult";
      if (goalTurn && heldGoalTurns < (config.holdGoalTurns ?? 0)) {
        heldGoalTurns += 1;
        return answer("ok");
      }
      return goalTurn
        ? Stream.make(
            { _tag: "toolCall" as const, argumentsJson: "{}", id: "finish", name: "finish-goal" },
            { _tag: "done" as const, stopReason: "toolCalls" as const },
          )
        : answer("ok");
    },
  };
  return { requests, service };
};

/** Completes the Session Goal, so a Goal chain ends after the Turn that calls it. */
const finishGoalTool = defineTool({
  description: "Completes the Goal.",
  execute: (_arguments, context) =>
    context
      .changeGoal({ action: "complete", evidence: "The work finished." })
      .pipe(Effect.orDie, Effect.as({ content: "Goal complete." })),
  name: "finish-goal",
  parameters: Schema.Struct({}),
});

/**
 * Memory Journal whose first countDurableLines after an assistant Entry, once armed, blocks
 * until released. The Kernel calls it in finishSettlement, after it has closed Steering for the
 * Turn, so a steer sent then becomes a detached Follow-up.
 */
const settlementLatchedJournal = () => {
  const entered = Effect.runSync(Deferred.make<void>());
  const release = Effect.runSync(Deferred.make<void>());
  const state = { armed: false, assistantAppended: false };
  const layer: Layer.Layer<Journal, JournalError> = Layer.effect(
    Journal,
    Effect.gen(function* () {
      const journal = yield* Journal;
      return {
        ...journal,
        appendEntry: (sessionId: SessionId, entry: Parameters<typeof journal.appendEntry>[1]) =>
          journal.appendEntry(sessionId, entry).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if ((entry.payload as { readonly role?: unknown }).role === "assistant") {
                  state.assistantAppended = true;
                }
              }),
            ),
          ),
        countDurableLines: (sessionId: SessionId) =>
          Effect.suspend(() => {
            if (state.armed && state.assistantAppended) {
              state.armed = false;
              return Deferred.succeed(entered, undefined).pipe(
                Effect.zipRight(Deferred.await(release)),
                Effect.zipRight(journal.countDurableLines(sessionId)),
              );
            }
            return journal.countDurableLines(sessionId);
          }),
      };
    }),
  ).pipe(Layer.provide(JournalMemory(createMemoryJournalBacking())));
  return {
    arm: Effect.sync(() => {
      state.armed = true;
      state.assistantAppended = false;
    }),
    entered,
    layer,
    release,
  };
};

/** A resolver for one Agent, "reviewer": persona and model, no tools list. */
const stubAgents: AgentSessionResolver = {
  resolve: (name) =>
    Effect.succeed({
      filePath: `/agents/${name}.md`,
      grantedTools: [],
      name,
      toolFilter: undefined,
      turnOptions: { appendSystemPrompt: PERSONA, model: AGENT_MODEL },
      ungrantedTools: [],
    } satisfies AgentSessionPlan),
};

const driverLayer = (provider: ProviderService, journal: Layer.Layer<Journal, JournalError>) =>
  Layer.merge(
    FirstPartyDriverDefault().pipe(
      Layer.provide(
        Layer.mergeAll(
          journal,
          Layer.succeed(Provider, provider),
          ToolRegistryLive([finishGoalTool]),
        ),
      ),
    ),
    RpcInteractionsLive,
  );

/** LF-delimited rpc input plus a writer that resolves per-id response waits. */
const rpcHarness = () => {
  const input = new PassThrough();
  const responses = new Map<string, Deferred.Deferred<Frame>>();
  const latch = (id: string): Deferred.Deferred<Frame> => {
    const existing = responses.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const created = Effect.runSync(Deferred.make<Frame>());
    responses.set(id, created);
    return created;
  };
  const writer: HeadWriter = {
    write: (text) =>
      Effect.suspend(() => {
        const frame = JSON.parse(text) as Frame;
        return typeof frame.id === "string"
          ? Deferred.succeed(latch(frame.id), frame).pipe(Effect.asVoid)
          : Effect.void;
      }),
  };
  const send = (frame: Frame) =>
    Effect.sync(() => {
      input.write(`${JSON.stringify(frame)}\n`);
    });
  const awaitResponse = (id: string) => Deferred.await(latch(id));
  return {
    awaitResponse,
    end: Effect.sync(() => {
      if (!input.writableEnded) input.end();
    }),
    input,
    /** Sends a frame and waits for its response; fails the scenario on an error response. */
    request: (frame: Frame & { readonly id: string }) =>
      send(frame).pipe(
        Effect.zipRight(awaitResponse(frame.id)),
        Effect.flatMap((response) =>
          response.error === undefined
            ? Effect.succeed(response)
            : Effect.dieMessage(`${frame.id} failed: ${JSON.stringify(response.error)}`),
        ),
      ),
    send,
    writer,
  };
};

/** Resolves once the Session has published `count` turnSettled Progress items. */
const watchSettlements = (driver: DriverService, sessionId: SessionId) =>
  Effect.gen(function* () {
    const subscribed = yield* Deferred.make<void>();
    const counted = yield* Ref.make(0);
    const waiters: Array<{ readonly count: number; readonly done: Deferred.Deferred<void> }> = [];
    const fiber = yield* driver.subscribeProgress(sessionId).pipe(
      Stream.runForEach((item) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(subscribed, undefined);
          if (item._tag !== "turnSettled") return;
          const now = yield* Ref.updateAndGet(counted, (current) => current + 1);
          for (const waiter of waiters) {
            if (now >= waiter.count) yield* Deferred.succeed(waiter.done, undefined);
          }
        }),
      ),
      Effect.fork,
    );
    yield* Deferred.await(subscribed);
    return {
      stop: Fiber.interrupt(fiber),
      until: (count: number) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(counted)) >= count) return;
          const done = yield* Deferred.make<void>();
          waiters.push({ count, done });
          if ((yield* Ref.get(counted)) >= count) return;
          yield* Deferred.await(done);
        }),
    };
  });

const goalFrame = (sessionId: string, id: string, args: Readonly<Record<string, unknown>>) => ({
  _tag: "invoke-command",
  args,
  id,
  name: "goal",
  sessionId,
});

type Opener = "Goal restart" | "detached Follow-up" | "prompt" | "resume-goal";

interface SessionKind {
  readonly expected: {
    readonly model: string | undefined;
    readonly persona: boolean;
    readonly thinkingLevel: string | undefined;
  };
  readonly name: string;
  readonly setup: {
    readonly agent: boolean;
    readonly model?: string;
    readonly thinkingLevel?: string;
  };
}

const SESSIONS: ReadonlyArray<SessionKind> = [
  {
    expected: { model: AGENT_MODEL, persona: true, thinkingLevel: undefined },
    name: "an rpc Agent Session runs it with the Agent persona and model",
    setup: { agent: true },
  },
  {
    expected: { model: "journal-model", persona: false, thinkingLevel: "high" },
    name: "a plain rpc Session runs it with its journaled set-model and set-thinking",
    setup: { agent: false, model: "journal-model", thinkingLevel: "high" },
  },
  {
    expected: { model: "journal-model", persona: true, thinkingLevel: undefined },
    name: "an rpc Agent Session after set-model runs it with the journaled model and the Agent persona",
    setup: { agent: true, model: "journal-model" },
  },
];

const OPENERS: ReadonlyArray<Opener> = [
  "prompt",
  "resume-goal",
  "Goal restart",
  "detached Follow-up",
];

describe.each(OPENERS)("a %s Turn", (opener) => {
  test.each(SESSIONS)(
    "$name",
    async (kind) => {
      const provider = recordingProvider();
      const journal = settlementLatchedJournal();
      const rpc = rpcHarness();

      const observed = await Effect.runPromise(
        Effect.gen(function* () {
          const driver = yield* Driver;
          const head = yield* runRpcHead({
            agents: stubAgents,
            input: rpc.input,
            writer: rpc.writer,
          }).pipe(Effect.fork);
          const created = yield* rpc.request({
            _tag: "create",
            id: "create",
            ...(kind.setup.agent ? { agent: "reviewer" } : {}),
          });
          const sessionId = (created.result as { readonly sessionId: string }).sessionId;
          if (kind.setup.model !== undefined) {
            yield* rpc.request({
              _tag: "set-model",
              id: "set-model",
              model: kind.setup.model,
              sessionId,
            });
          }
          if (kind.setup.thinkingLevel !== undefined) {
            yield* rpc.request({
              _tag: "set-thinking",
              id: "set-thinking",
              sessionId,
              thinkingLevel: kind.setup.thinkingLevel,
            });
          }
          const settled = yield* watchSettlements(driver, sessionId as unknown as SessionId);
          let request: RecordedRequest | undefined;
          if (opener === "prompt") {
            yield* rpc.request({
              _tag: "prompt",
              content: "Prompt opener.",
              id: "prompt",
              sessionId,
            });
            request = provider.requests.find((item) => item.lastUser === "Prompt opener.");
          } else if (opener === "resume-goal" || opener === "Goal restart") {
            yield* rpc.request(
              goalFrame(sessionId, "goal-set", { action: "set", objective: "Ship it." }),
            );
            if (opener === "Goal restart") {
              yield* rpc.request(goalFrame(sessionId, "goal-pause", { action: "pause" }));
              yield* rpc.request(goalFrame(sessionId, "goal-resume", { action: "resume" }));
            }
            const before = provider.requests.length;
            yield* rpc.request({ _tag: "resume-goal", id: "resume-goal", sessionId });
            request = provider.requests.slice(before).find((item) => item.purpose === "turn");
          } else {
            yield* journal.arm;
            yield* rpc.send({
              _tag: "prompt",
              content: "Settle soon.",
              id: "prompt-settling",
              sessionId,
            });
            yield* Deferred.await(journal.entered);
            const steer = yield* rpc.request({
              _tag: "steer",
              content: "Too late for this Turn.",
              id: "steer",
              sessionId,
            });
            expect(steer.result).toEqual({ _tag: "ack" });
            yield* Deferred.succeed(journal.release, undefined);
            yield* rpc.awaitResponse("prompt-settling");
            yield* settled.until(2);
            request = provider.requests.find((item) => item.lastUser === "Too late for this Turn.");
          }
          yield* settled.stop;
          yield* rpc.end;
          const exitCode = yield* Fiber.join(head);
          return { exitCode, request };
        }).pipe(
          Effect.timeout(DEADLOCK_GUARD),
          Effect.ensuring(
            Deferred.succeed(journal.release, undefined).pipe(Effect.zipRight(rpc.end)),
          ),
          Effect.provide(driverLayer(provider.service, journal.layer)),
        ),
      );

      expect(observed.exitCode).toBe(0);
      expect(observed.request, `no Provider request for the ${opener} Turn`).toBeDefined();
      expect(observed.request?.model).toBe(kind.expected.model);
      expect(observed.request?.thinkingLevel).toBe(kind.expected.thinkingLevel);
      if (kind.expected.persona) {
        expect(observed.request?.system).toContain(PERSONA);
      } else {
        expect(observed.request?.system).not.toContain(PERSONA);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

test(
  "a control steer converted after an errored rpc Agent Turn carries the Agent persona and model",
  async () => {
    const provider = recordingProvider();
    const rpc = rpcHarness();
    const entered = Effect.runSync(Deferred.make<void>());
    const release = Effect.runSync(Deferred.make<void>());
    let failFirstTurn = true;
    const service: ProviderService = {
      streamAssistant: (context, options) => {
        const recorded = provider.service.streamAssistant(context, options);
        if (options.purpose !== "turn" || !failFirstTurn) return recorded;
        failFirstTurn = false;
        return Stream.fromEffect(
          Deferred.succeed(entered, undefined).pipe(
            Effect.zipRight(Deferred.await(release)),
            Effect.zipRight(
              Effect.fail(
                new ProviderError({ message: "Injected Provider failure.", transient: false }),
              ),
            ),
          ),
        );
      },
    };

    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const head = yield* runRpcHead({
          agents: stubAgents,
          input: rpc.input,
          writer: rpc.writer,
        }).pipe(Effect.fork);
        const created = yield* rpc.request({ _tag: "create", agent: "reviewer", id: "create" });
        const sessionId = (created.result as { readonly sessionId: string }).sessionId;
        const settled = yield* watchSettlements(driver, sessionId as unknown as SessionId);
        yield* rpc.send({
          _tag: "prompt",
          content: "This Turn will error.",
          id: "prompt",
          sessionId,
        });
        yield* Deferred.await(entered);
        const steer = yield* rpc.request({
          _tag: "steer",
          content: "Converted control steer.",
          id: "steer",
          sessionId,
        });
        expect(steer.result).toEqual({ _tag: "ack" });
        yield* Deferred.succeed(release, undefined);
        yield* rpc.awaitResponse("prompt");
        yield* settled.until(2);
        yield* settled.stop;
        const snapshot = yield* driver.getSnapshot(sessionId as unknown as SessionId);
        yield* rpc.end;
        const exitCode = yield* Fiber.join(head);
        return { exitCode, snapshot };
      }).pipe(
        Effect.timeout(DEADLOCK_GUARD),
        Effect.ensuring(Deferred.succeed(release, undefined).pipe(Effect.zipRight(rpc.end))),
        Effect.provide(driverLayer(service, JournalMemory(createMemoryJournalBacking()))),
      ),
    );

    expect(observed.exitCode).toBe(0);
    const assistants = observed.snapshot.entries
      .filter((entry) => entry.kind === "message")
      .map((entry) => entry.payload)
      .filter((payload) => (payload as { readonly role?: unknown }).role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0]).toMatchObject({ stopReason: "error" });
    expect(assistants[1]).toMatchObject({ stopReason: "done" });
    const followUp = provider.requests.find((item) => item.lastUser === "Converted control steer.");
    expect(
      followUp,
      "no Provider request for the converted control Steering Follow-up",
    ).toBeDefined();
    expect(followUp?.model).toBe(AGENT_MODEL);
    expect(followUp?.system).toContain(PERSONA);
  },
  TEST_TIMEOUT_MS,
);

test(
  "rpc close drops the Agent binding: a Kernel-opened Turn after a plain resume runs with the process defaults",
  async () => {
    const provider = recordingProvider();
    const journal = settlementLatchedJournal();
    const rpc = rpcHarness();

    const request = await Effect.runPromise(
      Effect.gen(function* () {
        const head = yield* runRpcHead({
          agents: stubAgents,
          input: rpc.input,
          writer: rpc.writer,
        }).pipe(Effect.fork);
        const created = yield* rpc.request({ _tag: "create", agent: "reviewer", id: "create" });
        const sessionId = (created.result as { readonly sessionId: string }).sessionId;
        yield* rpc.request({ _tag: "close", id: "close", sessionId });
        yield* rpc.request({ _tag: "resume", id: "resume", sessionId });
        yield* rpc.request(
          goalFrame(sessionId, "goal-set", { action: "set", objective: "Ship it." }),
        );
        const before = provider.requests.length;
        yield* rpc.request({ _tag: "resume-goal", id: "resume-goal", sessionId });
        yield* rpc.end;
        yield* Fiber.join(head);
        return provider.requests.slice(before).find((item) => item.purpose === "turn");
      }).pipe(
        Effect.timeout(DEADLOCK_GUARD),
        Effect.ensuring(rpc.end),
        Effect.provide(driverLayer(provider.service, journal.layer)),
      ),
    );

    expect(request).toBeDefined();
    expect(request?.model).toBeUndefined();
    expect(request?.system).not.toContain(PERSONA);
  },
  TEST_TIMEOUT_MS,
);

describe("print Head turn options reach Kernel-opened Turns", () => {
  test.each([
    { name: "a sole /goal resume restart", paused: true, prompts: ["/goal resume"] },
    { name: "a resumed Session that continues its active Goal", paused: false, prompts: [] },
  ])(
    "$name runs with the --agent body and --effort, and the binding ends with the Head",
    async ({ paused, prompts }) => {
      const provider = recordingProvider();
      const output = captureWriter();

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const driver = yield* Driver;
          const session = yield* driver.createSession();
          yield* driver.invokeCommand(session.id, "goal", "Finish the work");
          if (paused) {
            yield* driver.invokeCommand(session.id, "goal", "pause");
          }
          const exit = yield* runPrintHead({
            prompts,
            sessionId: session.id,
            turnOptions: { appendSystemPrompt: PERSONA, thinkingLevel: "low" },
            writer: output.writer,
          });
          const bound = yield* Effect.exit(
            Effect.suspend(() =>
              (
                driver as unknown as {
                  readonly sessionTurnOptions: (id: SessionId) => Effect.Effect<unknown>;
                }
              ).sessionTurnOptions(session.id),
            ),
          );
          return { bound, exit, snapshot: yield* driver.getSnapshot(session.id) };
        }).pipe(
          Effect.timeout(DEADLOCK_GUARD),
          Effect.provide(
            driverLayer(provider.service, JournalMemory(createMemoryJournalBacking())),
          ),
        ),
      );

      const continuation = provider.requests.find((item) => item.purpose === "turn");
      expect(result.exit).toBe(0);
      expect(result.snapshot.goal?.status).toBe("complete");
      expect(continuation, "no Goal continuation request").toBeDefined();
      expect(continuation?.system).toContain(PERSONA);
      expect(continuation?.thinkingLevel).toBe("low");
      // The Head releases the Session's binding when it finishes.
      expect(Exit.isSuccess(result.bound) ? result.bound.value : "no sessionTurnOptions").toBe(
        undefined,
      );
    },
    TEST_TIMEOUT_MS,
  );
});

describe("an automatic Goal continuation after a prompt", () => {
  test.each(SESSIONS)(
    "$name",
    async (kind) => {
      // The prompt's Turn leaves the Goal active; the Kernel schedules the continuation itself.
      const provider = recordingProvider({ holdGoalTurns: 1 });
      const rpc = rpcHarness();

      const observed = await Effect.runPromise(
        Effect.gen(function* () {
          const driver = yield* Driver;
          const head = yield* runRpcHead({
            agents: stubAgents,
            input: rpc.input,
            writer: rpc.writer,
          }).pipe(Effect.fork);
          const created = yield* rpc.request({
            _tag: "create",
            id: "create",
            ...(kind.setup.agent ? { agent: "reviewer" } : {}),
          });
          const sessionId = (created.result as { readonly sessionId: string }).sessionId;
          if (kind.setup.model !== undefined) {
            yield* rpc.request({
              _tag: "set-model",
              id: "set-model",
              model: kind.setup.model,
              sessionId,
            });
          }
          if (kind.setup.thinkingLevel !== undefined) {
            yield* rpc.request({
              _tag: "set-thinking",
              id: "set-thinking",
              sessionId,
              thinkingLevel: kind.setup.thinkingLevel,
            });
          }
          yield* rpc.request(
            goalFrame(sessionId, "goal-set", { action: "set", objective: "Ship it." }),
          );
          const settled = yield* watchSettlements(driver, sessionId as unknown as SessionId);
          const before = provider.requests.length;
          yield* rpc.request({
            _tag: "prompt",
            content: "Work on the Goal.",
            id: "prompt",
            sessionId,
          });
          yield* settled.until(2);
          yield* settled.stop;
          const snapshot = yield* driver.getSnapshot(sessionId as unknown as SessionId);
          yield* rpc.end;
          const exitCode = yield* Fiber.join(head);
          const turns = provider.requests.slice(before).filter((item) => item.purpose === "turn");
          return { exitCode, snapshot, turns };
        }).pipe(
          Effect.timeout(DEADLOCK_GUARD),
          Effect.ensuring(rpc.end),
          Effect.provide(
            driverLayer(provider.service, JournalMemory(createMemoryJournalBacking())),
          ),
        ),
      );

      expect(observed.exitCode).toBe(0);
      // The second Turn is the Kernel's own: a goal_continuation Entry proves the opener.
      expect(observed.snapshot.entries.map((entry) => entry.kind)).toContain("goal_continuation");
      expect(observed.snapshot.goal?.status).toBe("complete");
      expect(observed.turns.length, "prompt Turn plus its Goal continuation").toBeGreaterThan(1);
      const continuation = observed.turns[1];
      expect(continuation?.model).toBe(kind.expected.model);
      expect(continuation?.thinkingLevel).toBe(kind.expected.thinkingLevel);
      if (kind.expected.persona) {
        expect(continuation?.system).toContain(PERSONA);
      } else {
        expect(continuation?.system).not.toContain(PERSONA);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/** The issue 88 Driver seam, reached through a cast so this file compiles before it exists. */
interface TurnOptionsSeam {
  readonly bindSessionTurnOptions: (
    sessionId: SessionId,
    options: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void>;
  readonly releaseSessionTurnOptions: (sessionId: SessionId) => Effect.Effect<void>;
  readonly sessionTurnOptions: (sessionId: SessionId) => Effect.Effect<unknown>;
}

const seam = (driver: DriverService): TurnOptionsSeam => driver as unknown as TurnOptionsSeam;

/** The Session's binding now, or a marker when the Driver has no seam. */
const boundNow = (driver: DriverService, sessionId: SessionId) =>
  Effect.exit(Effect.suspend(() => seam(driver).sessionTurnOptions(sessionId))).pipe(
    Effect.map((exit) => (Exit.isSuccess(exit) ? exit.value : "no sessionTurnOptions")),
  );

interface DriverCalls {
  readonly binds: Array<Readonly<Record<string, unknown>>>;
  readonly prompts: Array<unknown>;
}

/**
 * The first-party Driver with its bind and prompt calls recorded. With `interruptOnBind`, the
 * bind interrupts its own fiber right after the binding lands: the Head loop's acquisition
 * boundary.
 */
const recordedDriverLayer = (
  provider: ProviderService,
  calls: DriverCalls,
  options: { readonly interruptOnBind?: boolean } = {},
) =>
  Layer.effect(
    Driver,
    Effect.map(Driver, (real) => {
      const wrapped = {
        ...real,
        bindSessionTurnOptions: (sessionId: SessionId, bound: Readonly<Record<string, unknown>>) =>
          Effect.sync(() => void calls.binds.push(bound)).pipe(
            Effect.zipRight(
              Effect.suspend(() => seam(real).bindSessionTurnOptions(sessionId, bound)),
            ),
            Effect.zipRight(
              options.interruptOnBind === true
                ? Effect.withFiberRuntime((fiber) =>
                    Effect.sync(() => fiber.unsafeInterruptAsFork(fiber.id())),
                  )
                : Effect.void,
            ),
          ),
        prompt: (...args: Parameters<DriverService["prompt"]>) =>
          Effect.suspend(() => {
            calls.prompts.push(args[2]);
            return real.prompt(...args);
          }),
      };
      return wrapped as unknown as DriverService;
    }),
  ).pipe(
    Layer.provide(
      FirstPartyDriverDefault().pipe(
        Layer.provide(
          Layer.mergeAll(
            JournalMemory(createMemoryJournalBacking()),
            Layer.succeed(Provider, provider),
            ToolRegistryLive([finishGoalTool]),
          ),
        ),
      ),
    ),
  );

describe("the Head session loop splits and releases its turn options (issue 88)", () => {
  test(
    "the print Head binds only Session fields and forwards only delivery fields with each prompt",
    async () => {
      const provider = recordingProvider();
      const output = captureWriter();
      const calls: DriverCalls = { binds: [], prompts: [] };

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const driver = yield* Driver;
          const session = yield* driver.createSession();
          const exit = yield* runPrintHead({
            prompts: ["Split the options."],
            sessionId: session.id,
            turnOptions: {
              appendSystemPrompt: PERSONA,
              deliveryMode: "followUp",
              thinkingLevel: "low",
            },
            writer: output.writer,
          });
          return { bound: yield* boundNow(driver, session.id), exit };
        }).pipe(
          Effect.timeout(DEADLOCK_GUARD),
          Effect.provide(recordedDriverLayer(provider.service, calls)),
        ),
      );

      const request = provider.requests.find((item) => item.lastUser === "Split the options.");
      expect(result.exit).toBe(0);
      expect(calls.binds).toEqual([{ appendSystemPrompt: PERSONA, thinkingLevel: "low" }]);
      expect(calls.prompts).toEqual([{ deliveryMode: "followUp" }]);
      expect(request?.system).toContain(PERSONA);
      expect(request?.thinkingLevel).toBe("low");
      expect(result.bound).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a stale expectedRevision in the print Head's turn options still rejects the prompt",
    async () => {
      const provider = recordingProvider();
      const output = captureWriter();
      const errors = captureWriter();

      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const driver = yield* Driver;
          const session = yield* driver.createSession();
          return yield* runPrintHead({
            errorWriter: errors.writer,
            prompts: ["Stale prompt."],
            sessionId: session.id,
            turnOptions: { appendSystemPrompt: PERSONA, expectedRevision: 999 },
            writer: output.writer,
          });
        }).pipe(
          Effect.timeout(DEADLOCK_GUARD),
          Effect.provide(
            driverLayer(provider.service, JournalMemory(createMemoryJournalBacking())),
          ),
        ),
      );

      expect(exit).not.toBe(0);
      expect(errors.output()).toContain("StaleRevision");
      expect(provider.requests.filter((item) => item.lastUser === "Stale prompt.")).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an interruption as the bind lands still releases the binding",
    async () => {
      const provider = recordingProvider();
      const calls: DriverCalls = { binds: [], prompts: [] };

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const driver = yield* Driver;
          const session = yield* driver.createSession();
          // Its own fiber: the bind interrupts the fiber it runs on, not this test's.
          const loop = yield* Effect.fork(
            runSessionLoop({
              onTurnSettled: () => Effect.succeed(0),
              prompts: ["Never reached."],
              sessionId: session.id,
              turnOptions: { appendSystemPrompt: PERSONA },
            }),
          ).pipe(Effect.flatMap(Fiber.await));
          return { bound: yield* boundNow(driver, session.id), loop };
        }).pipe(
          Effect.timeout(DEADLOCK_GUARD),
          Effect.provide(recordedDriverLayer(provider.service, calls, { interruptOnBind: true })),
        ),
      );

      expect(calls.binds).toEqual([{ appendSystemPrompt: PERSONA }]);
      expect(Exit.isInterrupted(result.loop)).toBe(true);
      expect(provider.requests.filter((item) => item.lastUser === "Never reached.")).toEqual([]);
      expect(result.bound).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a failing onSession releases the binding",
    async () => {
      const provider = recordingProvider();
      const calls: DriverCalls = { binds: [], prompts: [] };

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const driver = yield* Driver;
          const session = yield* driver.createSession();
          const loop = yield* Effect.exit(
            runSessionLoop({
              onSession: () => Effect.fail(new Error("onSession failed")),
              onTurnSettled: () => Effect.succeed(0),
              prompts: ["Never reached."],
              sessionId: session.id,
              turnOptions: { appendSystemPrompt: PERSONA },
            }),
          );
          return { bound: yield* boundNow(driver, session.id), loop };
        }).pipe(
          Effect.timeout(DEADLOCK_GUARD),
          Effect.provide(recordedDriverLayer(provider.service, calls)),
        ),
      );

      expect(calls.binds).toEqual([{ appendSystemPrompt: PERSONA }]);
      expect(Exit.isFailure(result.loop) && !Exit.isInterrupted(result.loop)).toBe(true);
      expect(result.bound).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an interruption inside the loop releases the binding",
    async () => {
      const provider = recordingProvider();
      const calls: DriverCalls = { binds: [], prompts: [] };

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const driver = yield* Driver;
          const session = yield* driver.createSession();
          const entered = yield* Deferred.make<void>();
          const running = yield* Effect.fork(
            runSessionLoop({
              onSession: () =>
                Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Effect.never)),
              onTurnSettled: () => Effect.succeed(0),
              prompts: ["Never reached."],
              sessionId: session.id,
              turnOptions: { appendSystemPrompt: PERSONA },
            }),
          );
          yield* Deferred.await(entered);
          const bindDuringLoop = yield* boundNow(driver, session.id);
          const loop = yield* Fiber.interrupt(running);
          return { bindDuringLoop, bound: yield* boundNow(driver, session.id), loop };
        }).pipe(
          Effect.timeout(DEADLOCK_GUARD),
          Effect.provide(recordedDriverLayer(provider.service, calls)),
        ),
      );

      expect(calls.binds).toEqual([{ appendSystemPrompt: PERSONA }]);
      expect(result.bindDuringLoop).toEqual({ appendSystemPrompt: PERSONA });
      expect(Exit.isInterrupted(result.loop)).toBe(true);
      expect(result.bound).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );
});
