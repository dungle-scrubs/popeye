/**
 * Issue #88: Session Turn options. A host binds a Session's own Turn options (persona, model,
 * thinking level, and the other per-Turn knobs) in the Kernel once, and every Turn the Session
 * opens resolves over them: a prompt, a resume-goal continuation, a Goal continuation after a
 * prompt, and a steer that becomes a detached Follow-up. Precedence, the same for every opener:
 * model = journaled set-model > request > binding > process default; thinking level = request >
 * binding > journaled set-thinking; every other field = request > binding.
 * Each case records the Provider request the opened Turn sends.
 */
import {
  createMemoryJournalBacking,
  Journal,
  type JournalError,
  JournalMemory,
  type JournalService,
  type SessionId,
} from "@dungle-scrubs/popeye-journal";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Ref, Schema, Stream } from "effect";
import { describe, expect, test } from "vitest";

import { Driver, DriverDefault, type DriverService } from "./driver.js";
import { makeGoalAccess } from "./goal.js";
import {
  type AssistantItem,
  type ContextItem,
  Provider,
  type ProviderService,
  type ThinkingLevel,
} from "./provider.js";
import { defineTool, ToolRegistryLive } from "./tool.js";

const PERSONA = "Bound persona body.";
const GUARD = "5 seconds";

interface RecordedRequest {
  readonly lastUser: string;
  readonly model: string | undefined;
  readonly purpose: string | undefined;
  readonly sessionId: SessionId | undefined;
  readonly system: string;
  readonly thinkingLevel: string | undefined;
}

const lastUser = (context: ReadonlyArray<ContextItem>): string =>
  [...context].reverse().find((item) => item.role === "user")?.content ?? "";

const answer = (text: string): Stream.Stream<AssistantItem> =>
  Stream.make(
    { _tag: "textDelta" as const, text },
    { _tag: "done" as const, stopReason: "done" as const },
  );

const finishGoalCall: Stream.Stream<AssistantItem> = Stream.make(
  { _tag: "toolCall" as const, argumentsJson: "{}", id: "finish", name: "finish-goal" },
  { _tag: "done" as const, stopReason: "toolCalls" as const },
);

/** Completes the Session Goal, so a Goal chain ends after the Turn that calls it. */
const finishGoal = defineTool({
  description: "Completes the Goal.",
  execute: (_arguments, context) =>
    context
      .changeGoal({ action: "complete", evidence: "Finished." })
      .pipe(Effect.orDie, Effect.as({ content: "Goal complete." })),
  name: "finish-goal",
  parameters: Schema.Struct({}),
});

/**
 * Records every request. While a Goal is active (its instruction is in the system content) and
 * the Turn has no Tool result yet, it calls finish-goal; otherwise it answers "ok".
 */
const recordingProvider = () => {
  const requests: Array<RecordedRequest> = [];
  const service: ProviderService = {
    streamAssistant: (context, options) => {
      const system = context
        .filter((item) => item.role === "system")
        .map((item) => item.content)
        .join("\n");
      requests.push({
        lastUser: lastUser(context),
        model: options.model,
        purpose: options.purpose,
        sessionId: options.accountingScope?.sessionId,
        system,
        thinkingLevel: options.thinkingLevel,
      });
      if (options.purpose === "compaction") {
        return answer("summary");
      }
      return system.includes("Active Goal:") && context.at(-1)?.role !== "toolResult"
        ? finishGoalCall
        : answer("ok");
    },
  };
  return { requests, service };
};

/**
 * Memory Journal whose next readBranch, once armed, blocks until released. Armed right before a
 * prompt, it holds that Turn's option resolution inside its Mailbox command: the Turn is
 * registered but not running, so a steer becomes a detached Follow-up.
 */
const latchedJournal = () => {
  const entered = Effect.runSync(Deferred.make<void>());
  const release = Effect.runSync(Deferred.make<void>());
  const state = { armed: false };
  const wrap = (journal: JournalService): JournalService => ({
    ...journal,
    readBranch: (sessionId) =>
      Effect.suspend(() => {
        if (!state.armed) {
          return journal.readBranch(sessionId);
        }
        state.armed = false;
        return Deferred.succeed(entered, undefined).pipe(
          Effect.zipRight(Deferred.await(release)),
          Effect.zipRight(journal.readBranch(sessionId)),
        );
      }),
  });
  const layer: Layer.Layer<Journal, JournalError> = Layer.effect(
    Journal,
    Effect.map(Journal, wrap),
  ).pipe(Layer.provide(JournalMemory(createMemoryJournalBacking())));
  return {
    arm: Effect.sync(() => {
      state.armed = true;
    }),
    entered,
    layer,
    release,
  };
};

const layerWith = (provider: ProviderService, journal: ReturnType<typeof latchedJournal>) =>
  DriverDefault().pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        journal.layer,
        Layer.succeed(Provider, provider),
        ToolRegistryLive([finishGoal]),
      ),
    ),
  );

/** Resolves once the Session has published `count` turnSettled Progress items. */
const awaitSettled = (driver: DriverService, sessionId: SessionId) =>
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

/** The Driver surface issue #88 adds; absent before it, so a call fails the test as a defect. */
interface SessionTurnOptionsDriver {
  readonly bindSessionTurnOptions: (
    sessionId: SessionId,
    options: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void>;
  readonly releaseSessionTurnOptions: (sessionId: SessionId) => Effect.Effect<void>;
  readonly sessionTurnOptions: (
    sessionId: SessionId,
  ) => Effect.Effect<Readonly<Record<string, unknown>> | undefined>;
}

const seam = (driver: DriverService): SessionTurnOptionsDriver =>
  driver as unknown as SessionTurnOptionsDriver;

type Opener = "detached Follow-up" | "prompt" | "resume-goal";

/**
 * Opens one Turn of the given kind and returns the first Provider request it sent. The Session
 * already holds its binding and journaled settings.
 */
const openTurn = (
  opener: Opener,
  driver: DriverService,
  sessionId: SessionId,
  journal: ReturnType<typeof latchedJournal>,
  requests: ReadonlyArray<RecordedRequest>,
) =>
  Effect.gen(function* () {
    const settled = yield* awaitSettled(driver, sessionId);
    const before = requests.length;
    if (opener === "prompt") {
      yield* driver.prompt(sessionId, "Prompt opener.");
      yield* settled.stop;
      return requests.slice(before).find((request) => request.lastUser === "Prompt opener.");
    }
    if (opener === "resume-goal") {
      const goals = makeGoalAccess(yield* Journal);
      yield* goals.changeGoal(sessionId, { action: "set", objective: "Finish the work." });
      yield* driver.resumeGoal(sessionId);
      yield* settled.stop;
      return requests.slice(before).find((request) => request.purpose === "turn");
    }
    yield* journal.arm;
    const first = yield* Effect.fork(driver.prompt(sessionId, "Registered first."));
    yield* Deferred.await(journal.entered);
    yield* driver.steer(sessionId, "Steered late.");
    yield* Deferred.succeed(journal.release, undefined);
    yield* Fiber.join(first);
    yield* settled.until(2);
    yield* settled.stop;
    return requests.slice(before).find((request) => request.lastUser === "Steered late.");
  });

interface PrecedenceCase {
  readonly bind?: {
    readonly appendSystemPrompt?: string;
    readonly model?: string;
    readonly thinkingLevel?: ThinkingLevel;
  };
  readonly expected: {
    readonly model: string | undefined;
    readonly persona: boolean;
    readonly thinkingLevel: string | undefined;
  };
  readonly journaled: { readonly model?: string; readonly thinkingLevel?: ThinkingLevel };
  readonly name: string;
}

const PRECEDENCE: ReadonlyArray<PrecedenceCase> = [
  {
    bind: { appendSystemPrompt: PERSONA, model: "bound-model", thinkingLevel: "low" },
    expected: { model: "bound-model", persona: true, thinkingLevel: "low" },
    journaled: {},
    name: "the bound persona, model, and thinking level",
  },
  {
    expected: { model: "journal-model", persona: false, thinkingLevel: "high" },
    journaled: { model: "journal-model", thinkingLevel: "high" },
    name: "the journaled set-model and set-thinking of a Session with no binding",
  },
  {
    bind: { appendSystemPrompt: PERSONA, model: "bound-model" },
    expected: { model: "journal-model", persona: true, thinkingLevel: "high" },
    journaled: { model: "journal-model", thinkingLevel: "high" },
    name: "the journaled model over the bound model, with the bound persona and the journaled thinking level",
  },
  {
    bind: { thinkingLevel: "low" },
    expected: { model: undefined, persona: false, thinkingLevel: "low" },
    journaled: { thinkingLevel: "high" },
    name: "the bound thinking level over the journaled one",
  },
];

const OPENERS: ReadonlyArray<Opener> = ["prompt", "resume-goal", "detached Follow-up"];

describe.each(OPENERS)("a %s Turn", (opener) => {
  test.each(PRECEDENCE)("runs with $name", async (precedence) => {
    const provider = recordingProvider();
    const journal = latchedJournal();

    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const session = yield* driver.createSession();
        if (precedence.bind !== undefined) {
          yield* seam(driver).bindSessionTurnOptions(session.id, precedence.bind);
        }
        if (precedence.journaled.model !== undefined) {
          yield* driver.setModel(session.id, precedence.journaled.model);
        }
        if (precedence.journaled.thinkingLevel !== undefined) {
          yield* driver.setThinkingLevel(session.id, precedence.journaled.thinkingLevel);
        }
        return yield* openTurn(opener, driver, session.id, journal, provider.requests);
      }).pipe(
        Effect.timeout(GUARD),
        Effect.ensuring(Deferred.succeed(journal.release, undefined)),
        Effect.provide(layerWith(provider.service, journal)),
      ),
    );

    expect(observed, `no Provider request for the ${opener} Turn`).toBeDefined();
    expect(observed?.model).toBe(precedence.expected.model);
    expect(observed?.thinkingLevel).toBe(precedence.expected.thinkingLevel);
    if (precedence.expected.persona) {
      expect(observed?.system).toContain(PERSONA);
    } else {
      expect(observed?.system).not.toContain(PERSONA);
    }
  });
});

test("a request option beats the bound option field by field; an absent request field keeps the bound one", async () => {
  const provider = recordingProvider();
  const journal = latchedJournal();

  await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      yield* seam(driver).bindSessionTurnOptions(session.id, {
        appendSystemPrompt: PERSONA,
        model: "bound-model",
        thinkingLevel: "low",
      });
      yield* driver.prompt(session.id, "Bound only.");
      yield* driver.prompt(session.id, "Request overrides.", {
        appendSystemPrompt: "Request persona body.",
        model: "request-model",
        thinkingLevel: "high",
      });
      yield* driver.prompt(session.id, "Request model only.", { model: "request-model" });
    }).pipe(Effect.timeout(GUARD), Effect.provide(layerWith(provider.service, journal))),
  );

  const byPrompt = (prompt: string) =>
    provider.requests.find((request) => request.lastUser === prompt);
  expect(byPrompt("Bound only.")).toMatchObject({ model: "bound-model", thinkingLevel: "low" });
  expect(byPrompt("Bound only.")?.system).toContain(PERSONA);
  expect(byPrompt("Request overrides.")).toMatchObject({
    model: "request-model",
    thinkingLevel: "high",
  });
  expect(byPrompt("Request overrides.")?.system).toContain("Request persona body.");
  expect(byPrompt("Request overrides.")?.system).not.toContain(PERSONA);
  expect(byPrompt("Request model only.")).toMatchObject({
    model: "request-model",
    thinkingLevel: "low",
  });
  expect(byPrompt("Request model only.")?.system).toContain(PERSONA);
});

test("a binding is read back as the same object, replaced by a later bind, and dropped by release", async () => {
  const provider = recordingProvider();
  const journal = latchedJournal();
  const first = { appendSystemPrompt: PERSONA, model: "first-model" };
  const second = { model: "second-model" };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      const other = yield* driver.createSession();
      const options = seam(driver);
      const unbound = yield* options.sessionTurnOptions(session.id);
      yield* options.bindSessionTurnOptions(session.id, first);
      const afterFirst = yield* options.sessionTurnOptions(session.id);
      const otherSession = yield* options.sessionTurnOptions(other.id);
      yield* options.bindSessionTurnOptions(session.id, second);
      const afterSecond = yield* options.sessionTurnOptions(session.id);
      yield* driver.prompt(session.id, "While second is bound.");
      yield* options.releaseSessionTurnOptions(session.id);
      yield* options.releaseSessionTurnOptions(session.id);
      const afterRelease = yield* options.sessionTurnOptions(session.id);
      yield* driver.prompt(session.id, "After release.");
      yield* driver.prompt(other.id, "Other Session.");
      return { afterFirst, afterRelease, afterSecond, otherSession, unbound };
    }).pipe(Effect.timeout(GUARD), Effect.provide(layerWith(provider.service, journal))),
  );

  expect(result.unbound).toBeUndefined();
  expect(result.afterFirst).toBe(first);
  expect(result.otherSession).toBeUndefined();
  expect(result.afterSecond).toBe(second);
  expect(result.afterRelease).toBeUndefined();
  const byPrompt = (prompt: string) =>
    provider.requests.find((request) => request.lastUser === prompt);
  expect(byPrompt("While second is bound.")?.model).toBe("second-model");
  expect(byPrompt("While second is bound.")?.system).not.toContain(PERSONA);
  expect(byPrompt("After release.")?.model).toBeUndefined();
  expect(byPrompt("Other Session.")?.model).toBeUndefined();
});

test("binding options that fail Turn option validation is a defect and binds nothing", async () => {
  const provider = recordingProvider();
  const journal = latchedJournal();

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      const options = seam(driver);
      const exit = yield* Effect.exit(
        options.bindSessionTurnOptions(session.id, { maxAttempts: 0, model: "bound-model" }),
      );
      return { bound: yield* options.sessionTurnOptions(session.id), exit };
    }).pipe(Effect.timeout(GUARD), Effect.provide(layerWith(provider.service, journal))),
  );

  expect(Exit.isFailure(result.exit)).toBe(true);
  if (Exit.isFailure(result.exit)) {
    expect(Cause.isDie(result.exit.cause)).toBe(true);
    expect(Cause.pretty(result.exit.cause)).toContain(
      "Maximum attempts must be a positive safe integer.",
    );
  }
  expect(result.bound).toBeUndefined();
});

test("a set-thinking journaled while a Goal Turn runs applies to the Goal continuation that follows it", async () => {
  const entered = Effect.runSync(Deferred.make<void>());
  const release = Effect.runSync(Deferred.make<void>());
  const requests: Array<RecordedRequest> = [];
  const provider: ProviderService = {
    streamAssistant: (context, options) => {
      requests.push({
        lastUser: lastUser(context),
        model: options.model,
        purpose: options.purpose,
        sessionId: options.accountingScope?.sessionId,
        system: "",
        thinkingLevel: options.thinkingLevel,
      });
      if (requests.length === 1) {
        // The prompt's Turn: blocks, then ends with the Goal still active.
        return Stream.fromEffect(
          Deferred.succeed(entered, undefined).pipe(
            Effect.zipRight(Deferred.await(release)),
            Effect.as({ _tag: "textDelta" as const, text: "working" }),
          ),
        ).pipe(Stream.concat(Stream.make({ _tag: "done" as const, stopReason: "done" as const })));
      }
      return context.at(-1)?.role === "toolResult" ? answer("done") : finishGoalCall;
    },
  };
  const journal = latchedJournal();

  await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      yield* driver.setThinkingLevel(session.id, "low");
      yield* makeGoalAccess(yield* Journal).changeGoal(session.id, {
        action: "set",
        objective: "Finish the work.",
      });
      const prompt = yield* Effect.fork(driver.prompt(session.id, "Start the Goal."));
      yield* Deferred.await(entered);
      // Queued behind the running Turn, ahead of the continuation its settlement schedules.
      const setThinking = yield* Effect.fork(driver.setThinkingLevel(session.id, "high"));
      yield* Effect.yieldNow();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(setThinking);
      yield* Fiber.join(prompt);
    }).pipe(
      Effect.timeout(GUARD),
      Effect.ensuring(Deferred.succeed(release, undefined)),
      Effect.provide(layerWith(provider, journal)),
    ),
  );

  expect(requests.map((request) => request.thinkingLevel)).toEqual(["low", "high", "high"]);
});
