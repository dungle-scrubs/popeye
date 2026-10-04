/**
 * Acceptance tests for issue #67: RPC Steering admission while a Turn runs.
 * Every race is ordered by latches: a Provider that blocks its first request, Journal reads
 * that block on demand, Driver calls that block on demand, and Progress waits. No wait has its
 * own timeout. The only clock is DEADLOCK_GUARD around each whole scenario: when it fires, the
 * scenario stops, its latches are released, and the test fails naming the wait that hung.
 */

import { PassThrough } from "node:stream";

import {
  createMemoryJournalBacking,
  type EntryDraft,
  Journal,
  type JournalError,
  JournalMemory,
  type SessionId,
} from "@dungle-scrubs/popeye-journal";
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { expect, test } from "vitest";

import {
  Driver,
  type DriverService,
  defineTool,
  FirstPartyDriverDefault,
  type Progress,
  Provider,
  type ProviderService,
  type Tool,
  ToolRegistryLive,
} from "../compose.js";
import type { HeadWriter } from "./head-wire.js";
import { RpcInteractionsLive, runRpcHead } from "./rpc.js";

/** Bounds a whole scenario so a deadlock fails the test instead of hanging the run. */
const DEADLOCK_GUARD = "5 seconds";
const TEST_TIMEOUT_MS = 20_000;
/** Mirrors the dispatcher's bound for steer-mode prompts that bypass the Session queue. */
const STEER_FORK_CAPACITY = 64;

type Frame = Readonly<Record<string, unknown>>;

interface ProviderCall {
  readonly messages: ReadonlyArray<string>;
  readonly model: string | undefined;
  readonly turnOrdinal: number;
}

/** First request emits "reply 1" and blocks until release; later requests answer at once. */
const blockingProvider = () => {
  const entered = Effect.runSync(Deferred.make<void>());
  const release = Effect.runSync(Deferred.make<void>());
  const calls: Array<ProviderCall> = [];
  const service: ProviderService = {
    streamAssistant: (context, options) => {
      calls.push({
        messages: context
          .filter((item) => item.role !== "system")
          .map((item) => `${item.role}:${item.content}`),
        model: options.model,
        turnOrdinal: options.turnOrdinal,
      });
      const reply = { _tag: "textDelta" as const, text: `reply ${calls.length}` };
      const done = { _tag: "done" as const, stopReason: "done" as const };
      if (calls.length > 1) {
        return Stream.make(reply, done);
      }
      return Stream.fromEffect(Deferred.succeed(entered, undefined).pipe(Effect.as(reply))).pipe(
        Stream.concat(Stream.fromEffect(Deferred.await(release).pipe(Effect.as(done)))),
      );
    },
  };
  return { calls, entered, release, service };
};

/**
 * Provider for Goal continuation scenarios. Request `blockAt` (the first request of a Goal
 * continuation Turn) emits "reply <n>" and blocks until release; the next request (the round
 * that applies the Steering) calls the finish-goal Tool; every other request answers at once.
 */
const goalProvider = (blockAt: number) => {
  const entered = Effect.runSync(Deferred.make<void>());
  const release = Effect.runSync(Deferred.make<void>());
  const calls: Array<ProviderCall> = [];
  const service: ProviderService = {
    streamAssistant: (context, options) => {
      calls.push({
        messages: context
          .filter((item) => item.role !== "system")
          .map((item) => `${item.role}:${item.content}`),
        model: options.model,
        turnOrdinal: options.turnOrdinal,
      });
      const reply = { _tag: "textDelta" as const, text: `reply ${calls.length}` };
      const done = { _tag: "done" as const, stopReason: "done" as const };
      if (calls.length === blockAt) {
        return Stream.fromEffect(Deferred.succeed(entered, undefined).pipe(Effect.as(reply))).pipe(
          Stream.concat(Stream.fromEffect(Deferred.await(release).pipe(Effect.as(done)))),
        );
      }
      if (calls.length === blockAt + 1) {
        return Stream.make(
          { _tag: "toolCall" as const, argumentsJson: "{}", id: "finish", name: "finish-goal" },
          { _tag: "done" as const, stopReason: "toolCalls" as const },
        );
      }
      return Stream.make(reply, done);
    },
  };
  return { calls, entered, release, service };
};

/** Completes the Session Goal, so the Goal chain ends after the Turn that calls it. */
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
 * Memory Journal with two optional latches:
 * - armBranchRead(): the next readBranch blocks (a prompt's Turn is registered, not yet running).
 * - armSettlement(): the first countDurableLines after an assistant entry blocks; the Kernel
 *   calls it in finishSettlement, after it has closed Steering for the Turn.
 */
const latchedJournal = () => {
  const branchReadEntered = Effect.runSync(Deferred.make<void>());
  const releaseBranchRead = Effect.runSync(Deferred.make<void>());
  const settlementEntered = Effect.runSync(Deferred.make<void>());
  const releaseSettlement = Effect.runSync(Deferred.make<void>());
  const state = {
    assistantAppended: false,
    branchReadArmed: false,
    settlementArmed: false,
  };
  const layer = Layer.effect(
    Journal,
    Effect.gen(function* () {
      const journal = yield* Journal;
      return {
        ...journal,
        appendEntry: (sessionId: SessionId, entry: EntryDraft) =>
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
            if (state.settlementArmed && state.assistantAppended) {
              state.settlementArmed = false;
              return Deferred.succeed(settlementEntered, undefined).pipe(
                Effect.zipRight(Deferred.await(releaseSettlement)),
                Effect.zipRight(journal.countDurableLines(sessionId)),
              );
            }
            return journal.countDurableLines(sessionId);
          }),
        readBranch: (sessionId: SessionId) =>
          Effect.suspend(() => {
            if (state.branchReadArmed) {
              state.branchReadArmed = false;
              return Deferred.succeed(branchReadEntered, undefined).pipe(
                Effect.zipRight(Deferred.await(releaseBranchRead)),
                Effect.zipRight(journal.readBranch(sessionId)),
              );
            }
            return journal.readBranch(sessionId);
          }),
      };
    }),
  ).pipe(Layer.provide(JournalMemory(createMemoryJournalBacking())));
  return {
    armBranchRead: Effect.sync(() => {
      state.branchReadArmed = true;
    }),
    armSettlement: Effect.sync(() => {
      state.settlementArmed = true;
    }),
    branchReadEntered,
    layer,
    releaseBranchRead,
    releaseSettlement,
    settlementEntered,
  };
};

/**
 * Latch for the Driver's first prompt call: wrap(driver) blocks that call before it reaches the
 * Kernel, so the RPC prompt frame is running in its Session queue but no Turn is registered yet.
 */
const promptGate = () => {
  const entered = Effect.runSync(Deferred.make<void>());
  const release = Effect.runSync(Deferred.make<void>());
  const state = { armed: true };
  const wrap = (driver: DriverService): DriverService => ({
    ...driver,
    prompt: (...args: Parameters<DriverService["prompt"]>) =>
      Effect.suspend(() => {
        if (!state.armed) {
          return driver.prompt(...args);
        }
        state.armed = false;
        return Deferred.succeed(entered, undefined).pipe(
          Effect.zipRight(Deferred.await(release)),
          Effect.zipRight(driver.prompt(...args)),
        );
      }),
  });
  return { entered, release, wrap };
};

/** Latch for the Driver's next getSnapshot call after arm: wrap(driver) blocks that call. */
const snapshotGate = () => {
  const entered = Effect.runSync(Deferred.make<void>());
  const release = Effect.runSync(Deferred.make<void>());
  const state = { armed: false };
  const wrap = (driver: DriverService): DriverService => ({
    ...driver,
    getSnapshot: (...args: Parameters<DriverService["getSnapshot"]>) =>
      Effect.suspend(() => {
        if (!state.armed) {
          return driver.getSnapshot(...args);
        }
        state.armed = false;
        return Deferred.succeed(entered, undefined).pipe(
          Effect.zipRight(Deferred.await(release)),
          Effect.zipRight(driver.getSnapshot(...args)),
        );
      }),
  });
  return {
    arm: Effect.sync(() => {
      state.armed = true;
    }),
    entered,
    release,
    wrap,
  };
};

const steeringLayer = (
  provider: ProviderService,
  journal: Layer.Layer<Journal, JournalError> = JournalMemory(createMemoryJournalBacking()),
  tools: ReadonlyArray<Tool.Any> = [],
) =>
  Layer.merge(
    FirstPartyDriverDefault().pipe(
      Layer.provide(
        Layer.mergeAll(journal, Layer.succeed(Provider, provider), ToolRegistryLive(tools)),
      ),
    ),
    RpcInteractionsLive,
  );

/** Runs the RPC Head against a decorated Driver. */
const headWith = (driver: DriverService, rpc: ReturnType<typeof rpcHarness>) =>
  runRpcHead({ input: rpc.input, writer: rpc.writer }).pipe(
    Effect.provide(Layer.merge(Layer.succeed(Driver, driver), RpcInteractionsLive)),
    Effect.fork,
  );

type HarnessEvent =
  | { readonly _tag: "frame"; readonly frame: Frame }
  | { readonly _tag: "marker"; readonly name: string };

/** LF-delimited RPC input plus a writer that records output order and resolves per-id waits. */
const rpcHarness = () => {
  const input = new PassThrough();
  const events: Array<HarnessEvent> = [];
  const responses = new Map<string, Deferred.Deferred<Frame>>();
  const state = { waiting: "the scenario to start" };
  const responseLatch = (id: string): Deferred.Deferred<Frame> => {
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
        events.push({ _tag: "frame", frame });
        return typeof frame.id === "string"
          ? Deferred.succeed(responseLatch(frame.id), frame).pipe(Effect.asVoid)
          : Effect.void;
      }),
  };
  /** Names the wait for the deadlock report, then waits. Never times out on its own. */
  const until = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      state.waiting = label;
      return effect;
    });
  return {
    /** Waits for the response correlated to id. */
    awaitResponse: (id: string): Effect.Effect<Frame> =>
      until(`the response to ${id}`, Deferred.await(responseLatch(id))),
    end: Effect.sync(() => {
      input.end();
    }),
    /**
     * Fails the whole scenario when it has not finished within DEADLOCK_GUARD. disconnect lets
     * the failure (and the caller's latch-releasing cleanup) run without first waiting for the
     * hung scenario to finish interrupting, which a closed latch would otherwise block forever.
     */
    guard: <A, E, R>(scenario: Effect.Effect<A, E, R>): Effect.Effect<A, E | Error, R> =>
      scenario.pipe(
        Effect.disconnect,
        Effect.timeoutFail({
          duration: DEADLOCK_GUARD,
          onTimeout: () =>
            new Error(
              `Deadlock guard: the scenario was still waiting for ${state.waiting} after ${DEADLOCK_GUARD}.`,
            ),
        }),
      ),
    input,
    mark: (name: string) =>
      Effect.sync(() => {
        events.push({ _tag: "marker", name });
      }),
    /** Output ids (or tags) and markers, in write order. */
    order: (): ReadonlyArray<string> =>
      events.map((event) =>
        event._tag === "marker"
          ? `#${event.name}`
          : String(event.frame.id ?? event.frame._tag ?? "untagged"),
      ),
    responses: (): ReadonlyArray<Frame> =>
      events.flatMap((event) => (event._tag === "frame" ? [event.frame] : [])),
    send: (frame: Frame) =>
      Effect.sync(() => {
        input.write(`${JSON.stringify(frame)}\n`);
      }),
    until,
    writer,
  };
};

/** Subscribes to a Session's Progress and resolves once the subscription is registered. */
const watchProgress = (
  driver: DriverService,
  sessionId: SessionId,
  rpc: ReturnType<typeof rpcHarness>,
) =>
  Effect.gen(function* () {
    const seen: Array<Progress> = [];
    const subscribed = yield* Deferred.make<void>();
    const waiters: Array<{
      readonly count: number;
      readonly deferred: Deferred.Deferred<void>;
      readonly tag: Progress["_tag"];
    }> = [];
    const settleWaiters = Effect.forEach(
      waiters,
      (waiter) =>
        seen.filter((item) => item._tag === waiter.tag).length >= waiter.count
          ? Deferred.succeed(waiter.deferred, undefined)
          : Effect.void,
      { discard: true },
    );
    const fiber = yield* driver.subscribeProgress(sessionId).pipe(
      Stream.runForEach((item) =>
        Effect.sync(() => seen.push(item)).pipe(
          Effect.zipRight(Deferred.succeed(subscribed, undefined)),
          Effect.zipRight(settleWaiters),
        ),
      ),
      Effect.fork,
    );
    // ProgressHub offers the current phase to every new subscriber, so this resolves on registration.
    yield* Deferred.await(subscribed);
    const awaitTag = (tag: Progress["_tag"], count = 1): Effect.Effect<void> =>
      rpc.until(
        `Progress ${tag} number ${count}`,
        Effect.gen(function* () {
          const deferred = yield* Deferred.make<void>();
          waiters.push({ count, deferred, tag });
          yield* settleWaiters;
          yield* Deferred.await(deferred);
        }),
      );
    return { awaitTag, seen, stop: Fiber.interrupt(fiber) };
  });

const messages = (frame: Frame | undefined): ReadonlyArray<string> => {
  const result = frame?.result as
    | { readonly entries?: ReadonlyArray<{ readonly kind: string; readonly payload: Frame }> }
    | undefined;
  return (result?.entries ?? [])
    .filter((entry) => entry.kind === "message")
    .map((entry) => `${String(entry.payload.role)}:${String(entry.payload.content)}`);
};

const deliveryModeOf = (frame: Frame | undefined, content: string): unknown => {
  const result = frame?.result as
    | { readonly entries?: ReadonlyArray<{ readonly kind: string; readonly payload: Frame }> }
    | undefined;
  return result?.entries?.find((entry) => entry.payload.content === content)?.payload.deliveryMode;
};

const runningTurnSteerError = {
  error: {
    code: "protocol_error",
    details: { reason: "phase_invalid_command", tag: "ProtocolError" },
    message: "Steering requires a running turn.",
  },
};

test(
  "rpc steer reaches a running Turn and acknowledges before the Turn settles",
  async () => {
    const provider = blockingProvider();
    const rpc = rpcHarness();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const session = yield* driver.createSession();
        const head = yield* runRpcHead({ input: rpc.input, writer: rpc.writer }).pipe(Effect.fork);
        yield* rpc.send({
          _tag: "prompt",
          content: "Start a long answer.",
          id: "prompt-running",
          sessionId: session.id,
        });
        yield* rpc.until("Provider request 1", Deferred.await(provider.entered));
        yield* rpc.send({
          _tag: "steer",
          content: "Steer mid-Turn.",
          id: "steer-running",
          sessionId: session.id,
        });
        const steer = yield* rpc.awaitResponse("steer-running");
        yield* rpc.mark("provider-released");
        yield* Deferred.succeed(provider.release, undefined);
        const prompt = yield* rpc.awaitResponse("prompt-running");
        yield* rpc.end;
        const exitCode = yield* Fiber.join(head);
        return { exitCode, prompt, steer };
      }).pipe(
        rpc.guard,
        Effect.ensuring(
          Deferred.succeed(provider.release, undefined).pipe(Effect.zipRight(rpc.end)),
        ),
        Effect.provide(steeringLayer(provider.service)),
      ),
    );

    expect(result.steer).toEqual({ id: "steer-running", result: { _tag: "ack" } });
    expect(rpc.order().indexOf("steer-running")).toBeLessThan(
      rpc.order().indexOf("#provider-released"),
    );
    expect(provider.calls.map((call) => call.turnOrdinal)).toEqual([1, 1]);
    expect(provider.calls[1]?.messages).toEqual([
      "user:Start a long answer.",
      "assistant:reply 1",
      "user:Steer mid-Turn.",
    ]);
    expect(messages(result.prompt)).toEqual([
      "user:Start a long answer.",
      "assistant:reply 1",
      "user:Steer mid-Turn.",
      "assistant:reply 2",
    ]);
    expect(deliveryModeOf(result.prompt, "Steer mid-Turn.")).toBe("steer");
    expect(result.exitCode).toBe(0);
  },
  TEST_TIMEOUT_MS,
);

test(
  "rpc prompt with deliveryMode steer joins the running Turn instead of opening the next one",
  async () => {
    const provider = blockingProvider();
    const rpc = rpcHarness();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const session = yield* driver.createSession();
        const progress = yield* watchProgress(driver, session.id, rpc);
        const head = yield* runRpcHead({ input: rpc.input, writer: rpc.writer }).pipe(Effect.fork);
        yield* rpc.send({
          _tag: "prompt",
          content: "Start a long answer.",
          id: "prompt-running",
          sessionId: session.id,
        });
        yield* rpc.until("Provider request 1", Deferred.await(provider.entered));
        yield* rpc.send({
          _tag: "prompt",
          content: "Steer through prompt.",
          deliveryMode: "steer",
          id: "prompt-steer",
          sessionId: session.id,
        });
        yield* progress.awaitTag("steeringQueued");
        yield* rpc.mark("provider-released");
        yield* Deferred.succeed(provider.release, undefined);
        const prompt = yield* rpc.awaitResponse("prompt-running");
        const steered = yield* rpc.awaitResponse("prompt-steer");
        yield* progress.stop;
        yield* rpc.end;
        const exitCode = yield* Fiber.join(head);
        return { exitCode, prompt, steered };
      }).pipe(
        rpc.guard,
        Effect.ensuring(
          Deferred.succeed(provider.release, undefined).pipe(Effect.zipRight(rpc.end)),
        ),
        Effect.provide(steeringLayer(provider.service)),
      ),
    );

    expect(provider.calls.map((call) => call.turnOrdinal)).toEqual([1, 1]);
    expect(messages(result.prompt)).toEqual([
      "user:Start a long answer.",
      "assistant:reply 1",
      "user:Steer through prompt.",
      "assistant:reply 2",
    ]);
    expect(deliveryModeOf(result.prompt, "Steer through prompt.")).toBe("steer");
    expect(result.steered).toMatchObject({ id: "prompt-steer", result: { _tag: "snapshot" } });
    expect(messages(result.steered)).toEqual(messages(result.prompt));
    expect(rpc.order().indexOf("#provider-released")).toBeLessThan(
      rpc.order().indexOf("prompt-steer"),
    );
    expect(result.exitCode).toBe(0);
  },
  TEST_TIMEOUT_MS,
);

test(
  "rpc steer that arrives before its prompt reaches the Driver is rejected at once",
  async () => {
    const provider = blockingProvider();
    const rpc = rpcHarness();
    const setModelStarted = Effect.runSync(Deferred.make<void>());
    const releaseSetModel = Effect.runSync(Deferred.make<void>());

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const session = yield* driver.createSession();
        const blockedDriver = {
          ...driver,
          setModel: (...args: Parameters<typeof driver.setModel>) =>
            Deferred.succeed(setModelStarted, undefined).pipe(
              Effect.zipRight(Deferred.await(releaseSetModel)),
              Effect.zipRight(driver.setModel(...args)),
            ),
        } satisfies typeof driver;
        const head = yield* headWith(blockedDriver, rpc);
        yield* rpc.send({
          _tag: "set-model",
          id: "model-blocker",
          model: "provider/blocked",
          sessionId: session.id,
        });
        yield* rpc.until("set-model to start", Deferred.await(setModelStarted));
        yield* rpc.send({
          _tag: "prompt",
          content: "Queued behind set-model.",
          id: "prompt-queued",
          sessionId: session.id,
        });
        yield* rpc.send({
          _tag: "steer",
          content: "Too early.",
          id: "steer-early",
          sessionId: session.id,
        });
        const steer = yield* rpc.awaitResponse("steer-early");
        yield* rpc.mark("set-model-released");
        yield* Deferred.succeed(releaseSetModel, undefined);
        yield* rpc.until("Provider request 1", Deferred.await(provider.entered));
        yield* Deferred.succeed(provider.release, undefined);
        const prompt = yield* rpc.awaitResponse("prompt-queued");
        yield* rpc.end;
        const exitCode = yield* Fiber.join(head);
        return { exitCode, prompt, steer };
      }).pipe(
        rpc.guard,
        Effect.ensuring(
          Deferred.succeed(releaseSetModel, undefined).pipe(
            Effect.zipRight(Deferred.succeed(provider.release, undefined)),
            Effect.zipRight(rpc.end),
          ),
        ),
        Effect.provide(steeringLayer(provider.service)),
      ),
    );

    expect(result.steer).toEqual({ id: "steer-early", ...runningTurnSteerError });
    expect(rpc.order()).toEqual([
      "steer-early",
      "#set-model-released",
      "model-blocker",
      "prompt-queued",
    ]);
    expect(messages(result.prompt)).toEqual(["user:Queued behind set-model.", "assistant:reply 1"]);
    expect(provider.calls).toHaveLength(1);
    expect(result.exitCode).toBe(0);
  },
  TEST_TIMEOUT_MS,
);

test(
  "rpc steer that arrives while its prompt runs but before the Kernel admits it is rejected at once",
  async () => {
    const provider = blockingProvider();
    const rpc = rpcHarness();
    const gate = promptGate();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const session = yield* driver.createSession();
        const head = yield* headWith(gate.wrap(driver), rpc);
        yield* rpc.send({
          _tag: "prompt",
          content: "Not admitted yet.",
          id: "prompt-unadmitted",
          sessionId: session.id,
        });
        yield* rpc.until("the prompt to reach the Driver", Deferred.await(gate.entered));
        yield* rpc.send({
          _tag: "steer",
          content: "Before admission.",
          id: "steer-unadmitted",
          sessionId: session.id,
        });
        const steer = yield* rpc.awaitResponse("steer-unadmitted");
        yield* rpc.mark("prompt-admission-released");
        yield* Deferred.succeed(gate.release, undefined);
        yield* rpc.until("Provider request 1", Deferred.await(provider.entered));
        yield* Deferred.succeed(provider.release, undefined);
        const prompt = yield* rpc.awaitResponse("prompt-unadmitted");
        yield* rpc.end;
        const exitCode = yield* Fiber.join(head);
        return { exitCode, prompt, steer };
      }).pipe(
        rpc.guard,
        Effect.ensuring(
          Deferred.succeed(gate.release, undefined).pipe(
            Effect.zipRight(Deferred.succeed(provider.release, undefined)),
            Effect.zipRight(rpc.end),
          ),
        ),
        Effect.provide(steeringLayer(provider.service)),
      ),
    );

    expect(result.steer).toEqual({ id: "steer-unadmitted", ...runningTurnSteerError });
    expect(rpc.order()).toEqual([
      "steer-unadmitted",
      "#prompt-admission-released",
      "prompt-unadmitted",
    ]);
    expect(messages(result.prompt)).toEqual(["user:Not admitted yet.", "assistant:reply 1"]);
    expect(provider.calls).toHaveLength(1);
    expect(result.exitCode).toBe(0);
  },
  TEST_TIMEOUT_MS,
);

test(
  "rpc steer that arrives while its Turn is registered but not yet running becomes a Follow-up",
  async () => {
    const provider = blockingProvider();
    const journal = latchedJournal();
    const rpc = rpcHarness();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const session = yield* driver.createSession();
        const progress = yield* watchProgress(driver, session.id, rpc);
        const head = yield* runRpcHead({ input: rpc.input, writer: rpc.writer }).pipe(Effect.fork);
        yield* journal.armBranchRead;
        yield* rpc.send({
          _tag: "prompt",
          content: "Registered first.",
          id: "prompt-registered",
          sessionId: session.id,
        });
        yield* rpc.until("the Turn's branch read", Deferred.await(journal.branchReadEntered));
        yield* rpc.send({
          _tag: "steer",
          content: "Arrives before the Turn runs.",
          id: "steer-registered",
          sessionId: session.id,
        });
        const steer = yield* rpc.awaitResponse("steer-registered");
        yield* rpc.mark("turn-start-released");
        yield* Deferred.succeed(journal.releaseBranchRead, undefined);
        yield* rpc.until("Provider request 1", Deferred.await(provider.entered));
        yield* Deferred.succeed(provider.release, undefined);
        const prompt = yield* rpc.awaitResponse("prompt-registered");
        yield* progress.awaitTag("turnSettled", 2);
        const settled = yield* driver.getSnapshot(session.id);
        yield* progress.stop;
        yield* rpc.end;
        const exitCode = yield* Fiber.join(head);
        return { exitCode, progress: progress.seen, prompt, settled, steer };
      }).pipe(
        rpc.guard,
        Effect.ensuring(
          Deferred.succeed(journal.releaseBranchRead, undefined).pipe(
            Effect.zipRight(Deferred.succeed(provider.release, undefined)),
            Effect.zipRight(rpc.end),
          ),
        ),
        Effect.provide(steeringLayer(provider.service, journal.layer)),
      ),
    );

    expect(result.steer).toEqual({ id: "steer-registered", result: { _tag: "ack" } });
    expect(result.prompt).toMatchObject({ id: "prompt-registered", result: { _tag: "snapshot" } });
    expect(rpc.order().indexOf("steer-registered")).toBeLessThan(
      rpc.order().indexOf("#turn-start-released"),
    );
    expect(result.progress).toContainEqual({
      _tag: "followUpQueued",
      content: "Arrives before the Turn runs.",
    });
    expect(provider.calls.map((call) => call.turnOrdinal)).toEqual([1, 2]);
    expect(
      result.settled.entries
        .filter((entry) => entry.kind === "message")
        .map((entry) => (entry.payload as { readonly content?: unknown }).content),
    ).toEqual(["Registered first.", "reply 1", "Arrives before the Turn runs.", "reply 2"]);
    expect(result.exitCode).toBe(0);
  },
  TEST_TIMEOUT_MS,
);

test(
  "rpc prompt with deliveryMode steer that arrives while the Turn is registered but not yet running is admitted at once as the next Turn",
  async () => {
    const provider = blockingProvider();
    const journal = latchedJournal();
    const rpc = rpcHarness();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const session = yield* driver.createSession();
        const progress = yield* watchProgress(driver, session.id, rpc);
        const head = yield* runRpcHead({ input: rpc.input, writer: rpc.writer }).pipe(Effect.fork);
        yield* journal.armBranchRead;
        yield* rpc.send({
          _tag: "prompt",
          content: "Registered first.",
          id: "prompt-registered",
          sessionId: session.id,
        });
        yield* rpc.until("the Turn's branch read", Deferred.await(journal.branchReadEntered));
        yield* rpc.send({
          _tag: "prompt",
          content: "Steer before the Turn runs.",
          deliveryMode: "steer",
          id: "prompt-steer-registered",
          sessionId: session.id,
        });
        yield* progress.awaitTag("turnQueued");
        yield* rpc.mark("turn-start-released");
        yield* Deferred.succeed(journal.releaseBranchRead, undefined);
        yield* rpc.until("Provider request 1", Deferred.await(provider.entered));
        yield* Deferred.succeed(provider.release, undefined);
        const prompt = yield* rpc.awaitResponse("prompt-registered");
        const steered = yield* rpc.awaitResponse("prompt-steer-registered");
        yield* progress.stop;
        yield* rpc.end;
        const exitCode = yield* Fiber.join(head);
        return { exitCode, progress: progress.seen, prompt, steered };
      }).pipe(
        rpc.guard,
        Effect.ensuring(
          Deferred.succeed(journal.releaseBranchRead, undefined).pipe(
            Effect.zipRight(Deferred.succeed(provider.release, undefined)),
            Effect.zipRight(rpc.end),
          ),
        ),
        Effect.provide(steeringLayer(provider.service, journal.layer)),
      ),
    );

    expect(result.progress).toContainEqual({
      _tag: "turnQueued",
      content: "Steer before the Turn runs.",
    });
    expect(provider.calls.map((call) => call.turnOrdinal)).toEqual([1, 2]);
    expect(provider.calls[0]?.messages).toEqual(["user:Registered first."]);
    expect(result.prompt).toMatchObject({ id: "prompt-registered", result: { _tag: "snapshot" } });
    expect(messages(result.steered)).toEqual([
      "user:Registered first.",
      "assistant:reply 1",
      "user:Steer before the Turn runs.",
      "assistant:reply 2",
    ]);
    expect(result.exitCode).toBe(0);
  },
  TEST_TIMEOUT_MS,
);

test(
  "rpc steer that arrives as the Turn settles becomes a Follow-up and still acknowledges at once",
  async () => {
    const provider = blockingProvider();
    const journal = latchedJournal();
    const rpc = rpcHarness();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const session = yield* driver.createSession();
        const progress = yield* watchProgress(driver, session.id, rpc);
        const head = yield* runRpcHead({ input: rpc.input, writer: rpc.writer }).pipe(Effect.fork);
        yield* journal.armSettlement;
        yield* rpc.send({
          _tag: "prompt",
          content: "Settle soon.",
          id: "prompt-settling",
          sessionId: session.id,
        });
        yield* rpc.until("Provider request 1", Deferred.await(provider.entered));
        yield* Deferred.succeed(provider.release, undefined);
        yield* rpc.until("the Turn's settlement", Deferred.await(journal.settlementEntered));
        yield* rpc.send({
          _tag: "steer",
          content: "Too late for this Turn.",
          id: "steer-settling",
          sessionId: session.id,
        });
        const steer = yield* rpc.awaitResponse("steer-settling");
        yield* rpc.mark("settlement-released");
        yield* Deferred.succeed(journal.releaseSettlement, undefined);
        const prompt = yield* rpc.awaitResponse("prompt-settling");
        yield* progress.awaitTag("turnSettled", 2);
        const settled = yield* driver.getSnapshot(session.id);
        yield* progress.stop;
        yield* rpc.end;
        const exitCode = yield* Fiber.join(head);
        return { exitCode, progress: progress.seen, prompt, settled, steer };
      }).pipe(
        rpc.guard,
        Effect.ensuring(
          Deferred.succeed(journal.releaseSettlement, undefined).pipe(
            Effect.zipRight(Deferred.succeed(provider.release, undefined)),
            Effect.zipRight(rpc.end),
          ),
        ),
        Effect.provide(steeringLayer(provider.service, journal.layer)),
      ),
    );

    expect(result.steer).toEqual({ id: "steer-settling", result: { _tag: "ack" } });
    expect(result.prompt).toMatchObject({ id: "prompt-settling", result: { _tag: "snapshot" } });
    expect(rpc.order().indexOf("steer-settling")).toBeLessThan(
      rpc.order().indexOf("#settlement-released"),
    );
    expect(result.progress).toContainEqual({
      _tag: "followUpQueued",
      content: "Too late for this Turn.",
    });
    expect(provider.calls.map((call) => call.turnOrdinal)).toEqual([1, 2]);
    expect(
      result.settled.entries
        .filter((entry) => entry.kind === "message")
        .map((entry) => (entry.payload as { readonly content?: unknown }).content),
    ).toEqual(["Settle soon.", "reply 1", "Too late for this Turn.", "reply 2"]);
    expect(result.exitCode).toBe(0);
  },
  TEST_TIMEOUT_MS,
);

test(
  "rpc prompt with deliveryMode steer that arrives before the running prompt reaches the Driver opens the next Turn in order",
  async () => {
    const provider = blockingProvider();
    const rpc = rpcHarness();
    const setModelStarted = Effect.runSync(Deferred.make<void>());
    const releaseSetModel = Effect.runSync(Deferred.make<void>());

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const session = yield* driver.createSession();
        const blockedDriver = {
          ...driver,
          setModel: (...args: Parameters<typeof driver.setModel>) =>
            Deferred.succeed(setModelStarted, undefined).pipe(
              Effect.zipRight(Deferred.await(releaseSetModel)),
              Effect.zipRight(driver.setModel(...args)),
            ),
        } satisfies typeof driver;
        const head = yield* headWith(blockedDriver, rpc);
        yield* rpc.send({
          _tag: "set-model",
          id: "model-blocker",
          model: "provider/in-order",
          sessionId: session.id,
        });
        yield* rpc.until("set-model to start", Deferred.await(setModelStarted));
        yield* rpc.send({
          _tag: "prompt",
          content: "Queued first.",
          id: "prompt-queued",
          sessionId: session.id,
        });
        yield* rpc.send({
          _tag: "prompt",
          content: "Queued steer-mode prompt.",
          deliveryMode: "steer",
          id: "prompt-steer-queued",
          sessionId: session.id,
        });
        // The reader dispatches frames in arrival order, so this control response proves both
        // prompts were dispatched while set-model still blocked the Session queue.
        yield* rpc.send({ _tag: "abort", id: "dispatch-sentinel", sessionId: session.id });
        yield* rpc.awaitResponse("dispatch-sentinel");
        yield* Deferred.succeed(releaseSetModel, undefined);
        yield* rpc.until("Provider request 1", Deferred.await(provider.entered));
        yield* Deferred.succeed(provider.release, undefined);
        const prompt = yield* rpc.awaitResponse("prompt-queued");
        const steered = yield* rpc.awaitResponse("prompt-steer-queued");
        yield* rpc.end;
        const exitCode = yield* Fiber.join(head);
        return { exitCode, prompt, steered };
      }).pipe(
        rpc.guard,
        Effect.ensuring(
          Deferred.succeed(releaseSetModel, undefined).pipe(
            Effect.zipRight(Deferred.succeed(provider.release, undefined)),
            Effect.zipRight(rpc.end),
          ),
        ),
        Effect.provide(steeringLayer(provider.service)),
      ),
    );

    expect(rpc.order()).toEqual([
      "dispatch-sentinel",
      "model-blocker",
      "prompt-queued",
      "prompt-steer-queued",
    ]);
    expect(provider.calls.map((call) => call.turnOrdinal)).toEqual([1, 2]);
    expect(messages(result.prompt)).toEqual(["user:Queued first.", "assistant:reply 1"]);
    expect(messages(result.steered)).toEqual([
      "user:Queued first.",
      "assistant:reply 1",
      "user:Queued steer-mode prompt.",
      "assistant:reply 2",
    ]);
    expect(result.exitCode).toBe(0);
  },
  TEST_TIMEOUT_MS,
);

test(
  "rpc prompt with deliveryMode steer that arrives while the running prompt is not yet admitted by the Kernel queues behind it",
  async () => {
    const provider = blockingProvider();
    const rpc = rpcHarness();
    const gate = promptGate();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const session = yield* driver.createSession();
        const head = yield* headWith(gate.wrap(driver), rpc);
        yield* rpc.send({
          _tag: "prompt",
          content: "Admitted first.",
          id: "prompt-unadmitted",
          sessionId: session.id,
        });
        yield* rpc.until("the prompt to reach the Driver", Deferred.await(gate.entered));
        yield* rpc.send({
          _tag: "prompt",
          content: "Steer-mode prompt before admission.",
          deliveryMode: "steer",
          id: "prompt-steer-unadmitted",
          sessionId: session.id,
        });
        // The reader dispatches frames in arrival order, so this control response proves the
        // steer-mode prompt was dispatched while the running prompt was still unadmitted.
        yield* rpc.send({ _tag: "abort", id: "dispatch-sentinel", sessionId: session.id });
        yield* rpc.awaitResponse("dispatch-sentinel");
        yield* Deferred.succeed(gate.release, undefined);
        yield* rpc.until("Provider request 1", Deferred.await(provider.entered));
        yield* Deferred.succeed(provider.release, undefined);
        const prompt = yield* rpc.awaitResponse("prompt-unadmitted");
        const steered = yield* rpc.awaitResponse("prompt-steer-unadmitted");
        yield* rpc.end;
        const exitCode = yield* Fiber.join(head);
        return { exitCode, prompt, steered };
      }).pipe(
        rpc.guard,
        Effect.ensuring(
          Deferred.succeed(gate.release, undefined).pipe(
            Effect.zipRight(Deferred.succeed(provider.release, undefined)),
            Effect.zipRight(rpc.end),
          ),
        ),
        Effect.provide(steeringLayer(provider.service)),
      ),
    );

    expect(rpc.order()).toEqual([
      "dispatch-sentinel",
      "prompt-unadmitted",
      "prompt-steer-unadmitted",
    ]);
    expect(provider.calls.map((call) => call.turnOrdinal)).toEqual([1, 2]);
    expect(provider.calls[0]?.messages).toEqual(["user:Admitted first."]);
    expect(messages(result.prompt)).toEqual(["user:Admitted first.", "assistant:reply 1"]);
    expect(messages(result.steered)).toEqual([
      "user:Admitted first.",
      "assistant:reply 1",
      "user:Steer-mode prompt before admission.",
      "assistant:reply 2",
    ]);
    expect(result.exitCode).toBe(0);
  },
  TEST_TIMEOUT_MS,
);

test(
  "rpc prompt with deliveryMode steer that arrives as the Turn settles is admitted at once as the next Turn",
  async () => {
    const provider = blockingProvider();
    const journal = latchedJournal();
    const rpc = rpcHarness();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const session = yield* driver.createSession();
        const progress = yield* watchProgress(driver, session.id, rpc);
        const head = yield* runRpcHead({ input: rpc.input, writer: rpc.writer }).pipe(Effect.fork);
        yield* journal.armSettlement;
        yield* rpc.send({
          _tag: "prompt",
          content: "Settle soon.",
          id: "prompt-settling",
          sessionId: session.id,
        });
        yield* rpc.until("Provider request 1", Deferred.await(provider.entered));
        yield* Deferred.succeed(provider.release, undefined);
        yield* rpc.until("the Turn's settlement", Deferred.await(journal.settlementEntered));
        yield* rpc.send({
          _tag: "prompt",
          content: "Late steer-mode prompt.",
          deliveryMode: "steer",
          id: "prompt-steer-settling",
          sessionId: session.id,
        });
        yield* progress.awaitTag("followUpQueued");
        yield* Deferred.succeed(journal.releaseSettlement, undefined);
        const prompt = yield* rpc.awaitResponse("prompt-settling");
        const steered = yield* rpc.awaitResponse("prompt-steer-settling");
        yield* progress.stop;
        yield* rpc.end;
        const exitCode = yield* Fiber.join(head);
        return { exitCode, progress: progress.seen, prompt, steered };
      }).pipe(
        rpc.guard,
        Effect.ensuring(
          Deferred.succeed(journal.releaseSettlement, undefined).pipe(
            Effect.zipRight(Deferred.succeed(provider.release, undefined)),
            Effect.zipRight(rpc.end),
          ),
        ),
        Effect.provide(steeringLayer(provider.service, journal.layer)),
      ),
    );

    expect(result.progress).toContainEqual({
      _tag: "followUpQueued",
      content: "Late steer-mode prompt.",
    });
    expect(result.prompt).toMatchObject({ id: "prompt-settling", result: { _tag: "snapshot" } });
    expect(provider.calls.map((call) => call.turnOrdinal)).toEqual([1, 2]);
    expect(messages(result.steered)).toEqual([
      "user:Settle soon.",
      "assistant:reply 1",
      "user:Late steer-mode prompt.",
      "assistant:reply 2",
    ]);
    expect(result.exitCode).toBe(0);
  },
  TEST_TIMEOUT_MS,
);

test(
  "rpc prompt with deliveryMode steer that arrives after the Turn settled keeps its place behind earlier frames",
  async () => {
    const provider = blockingProvider();
    const rpc = rpcHarness();
    const gate = snapshotGate();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const session = yield* driver.createSession();
        const head = yield* headWith(gate.wrap(driver), rpc);
        yield* rpc.send({
          _tag: "prompt",
          content: "Run first.",
          id: "prompt-settled",
          sessionId: session.id,
        });
        yield* rpc.until("Provider request 1", Deferred.await(provider.entered));
        yield* rpc.send({
          _tag: "set-model",
          id: "model-queued",
          model: "provider/queued",
          sessionId: session.id,
        });
        yield* gate.arm;
        yield* Deferred.succeed(provider.release, undefined);
        // The Turn has settled and the prompt frame is reading its response Snapshot.
        yield* rpc.until("the prompt's response Snapshot", Deferred.await(gate.entered));
        yield* rpc.send({
          _tag: "prompt",
          content: "After the Turn settled.",
          deliveryMode: "steer",
          id: "prompt-steer-settled",
          sessionId: session.id,
        });
        // The reader dispatches frames in arrival order, so this control response proves the
        // steer-mode prompt was dispatched while the response Snapshot was still blocked.
        yield* rpc.send({ _tag: "abort", id: "dispatch-sentinel", sessionId: session.id });
        yield* rpc.awaitResponse("dispatch-sentinel");
        yield* Deferred.succeed(gate.release, undefined);
        const prompt = yield* rpc.awaitResponse("prompt-settled");
        const model = yield* rpc.awaitResponse("model-queued");
        const steered = yield* rpc.awaitResponse("prompt-steer-settled");
        yield* rpc.end;
        const exitCode = yield* Fiber.join(head);
        return { exitCode, model, prompt, steered };
      }).pipe(
        rpc.guard,
        Effect.ensuring(
          Deferred.succeed(gate.release, undefined).pipe(
            Effect.zipRight(Deferred.succeed(provider.release, undefined)),
            Effect.zipRight(rpc.end),
          ),
        ),
        Effect.provide(steeringLayer(provider.service)),
      ),
    );

    expect(rpc.order()).toEqual([
      "dispatch-sentinel",
      "prompt-settled",
      "model-queued",
      "prompt-steer-settled",
    ]);
    expect(result.model).toMatchObject({ result: { model: "provider/queued" } });
    expect(provider.calls.map((call) => call.turnOrdinal)).toEqual([1, 2]);
    expect(provider.calls[0]?.model).not.toBe("provider/queued");
    expect(provider.calls[1]?.model).toBe("provider/queued");
    expect(messages(result.prompt)).toEqual(["user:Run first.", "assistant:reply 1"]);
    expect(messages(result.steered)).toEqual([
      "user:Run first.",
      "assistant:reply 1",
      "user:After the Turn settled.",
      "assistant:reply 2",
    ]);
    expect(result.exitCode).toBe(0);
  },
  TEST_TIMEOUT_MS,
);

test(
  "rpc steer bypass keeps other frames of the same Session and of other Sessions in order",
  async () => {
    const provider = blockingProvider();
    const rpc = rpcHarness();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const sessionA = yield* driver.createSession();
        const sessionB = yield* driver.createSession();
        const head = yield* runRpcHead({ input: rpc.input, writer: rpc.writer }).pipe(Effect.fork);
        yield* rpc.send({
          _tag: "prompt",
          content: "Session A runs.",
          id: "prompt-a",
          sessionId: sessionA.id,
        });
        yield* rpc.until("Provider request 1", Deferred.await(provider.entered));
        yield* rpc.send({ _tag: "get-snapshot", id: "snapshot-a", sessionId: sessionA.id });
        yield* rpc.send({
          _tag: "steer",
          content: "Steer Session A.",
          id: "steer-a",
          sessionId: sessionA.id,
        });
        yield* rpc.send({
          _tag: "set-model",
          id: "model-b",
          model: "provider/session-b",
          sessionId: sessionB.id,
        });
        yield* rpc.send({ _tag: "get-snapshot", id: "snapshot-b", sessionId: sessionB.id });
        yield* rpc.awaitResponse("steer-a");
        const snapshotB = yield* rpc.awaitResponse("snapshot-b");
        yield* rpc.mark("provider-released");
        yield* Deferred.succeed(provider.release, undefined);
        const prompt = yield* rpc.awaitResponse("prompt-a");
        const snapshotA = yield* rpc.awaitResponse("snapshot-a");
        yield* rpc.end;
        const exitCode = yield* Fiber.join(head);
        return { exitCode, prompt, snapshotA, snapshotB };
      }).pipe(
        rpc.guard,
        Effect.ensuring(
          Deferred.succeed(provider.release, undefined).pipe(Effect.zipRight(rpc.end)),
        ),
        Effect.provide(steeringLayer(provider.service)),
      ),
    );

    const order = rpc.order();
    expect(order.indexOf("steer-a")).toBeLessThan(order.indexOf("#provider-released"));
    expect(order.indexOf("model-b")).toBeLessThan(order.indexOf("snapshot-b"));
    expect(order.indexOf("snapshot-b")).toBeLessThan(order.indexOf("#provider-released"));
    expect(order.indexOf("prompt-a")).toBeLessThan(order.indexOf("snapshot-a"));
    expect(order.indexOf("#provider-released")).toBeLessThan(order.indexOf("prompt-a"));
    expect(result.snapshotB).toMatchObject({ result: { model: "provider/session-b" } });
    expect(messages(result.snapshotA)).toEqual(messages(result.prompt));
    expect(messages(result.prompt)).toEqual([
      "user:Session A runs.",
      "assistant:reply 1",
      "user:Steer Session A.",
      "assistant:reply 2",
    ]);
    expect(result.exitCode).toBe(0);
  },
  TEST_TIMEOUT_MS,
);

test(
  "rpc steer-mode prompts waiting on a running Turn have their own bound and leave control frames available",
  async () => {
    const provider = blockingProvider();
    const rpc = rpcHarness();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const session = yield* driver.createSession();
        const progress = yield* watchProgress(driver, session.id, rpc);
        const head = yield* runRpcHead({ input: rpc.input, writer: rpc.writer }).pipe(Effect.fork);
        yield* rpc.send({
          _tag: "prompt",
          content: "Hold the Turn.",
          id: "prompt-holding",
          sessionId: session.id,
        });
        yield* rpc.until("Provider request 1", Deferred.await(provider.entered));
        // One steer-mode prompt at a time: each admission is observed before the next is sent,
        // so no Progress item can be dropped by the subscriber's sliding queue.
        for (let index = 0; index < STEER_FORK_CAPACITY; index += 1) {
          yield* rpc.send({
            _tag: "prompt",
            content: `Steer ${index}.`,
            deliveryMode: "steer",
            id: `prompt-steer-${index}`,
            sessionId: session.id,
          });
          yield* progress.awaitTag("steeringQueued", index + 1);
        }
        yield* rpc.send({
          _tag: "prompt",
          content: "One steer too many.",
          deliveryMode: "steer",
          id: "prompt-steer-excess",
          sessionId: session.id,
        });
        const excess = yield* rpc.awaitResponse("prompt-steer-excess");
        yield* rpc.send({
          _tag: "steer",
          content: "Explicit steer while saturated.",
          id: "steer-saturated",
          sessionId: session.id,
        });
        const steer = yield* rpc.awaitResponse("steer-saturated");
        yield* rpc.send({
          _tag: "interaction-response",
          id: "interaction-saturated",
          kind: "confirm",
          value: true,
        });
        const interaction = yield* rpc.awaitResponse("interaction-saturated");
        yield* rpc.send({ _tag: "abort", id: "abort-saturated", sessionId: session.id });
        const abort = yield* rpc.awaitResponse("abort-saturated");
        const prompt = yield* rpc.awaitResponse("prompt-holding");
        const waiters: Array<Frame> = [];
        for (let index = 0; index < STEER_FORK_CAPACITY; index += 1) {
          waiters.push(yield* rpc.awaitResponse(`prompt-steer-${index}`));
        }
        yield* progress.stop;
        yield* rpc.end;
        const exitCode = yield* Fiber.join(head);
        return { abort, excess, exitCode, interaction, prompt, steer, waiters };
      }).pipe(
        rpc.guard,
        Effect.ensuring(
          Deferred.succeed(provider.release, undefined).pipe(Effect.zipRight(rpc.end)),
        ),
        Effect.provide(steeringLayer(provider.service)),
      ),
    );

    expect(result.excess).toEqual({
      error: {
        code: "protocol_error",
        details: {
          bound: "steer_forks",
          limit: STEER_FORK_CAPACITY,
          tag: "RpcDispatchBoundExceeded",
        },
        message: `RPC steer_forks bound exceeded its limit of ${STEER_FORK_CAPACITY}.`,
      },
      id: "prompt-steer-excess",
    });
    // Each control frame ran and reached its handler instead of failing the control_forks bound.
    expect(result.steer).toMatchObject({
      error: { code: "turn_queue_full", details: { queue: "steering" } },
      id: "steer-saturated",
    });
    expect(result.interaction).toMatchObject({
      error: { code: "protocol_error", details: { tag: "ProtocolError" } },
      id: "interaction-saturated",
    });
    expect(result.abort).toMatchObject({
      id: "abort-saturated",
      result: { _tag: "abortTurnAborted", aborted: true, turnOrdinal: 1 },
    });
    expect(result.prompt).toMatchObject({ id: "prompt-holding", result: { _tag: "snapshot" } });
    expect(result.waiters).toHaveLength(STEER_FORK_CAPACITY);
    for (const waiter of result.waiters) {
      expect(waiter).toMatchObject({ result: { _tag: "snapshot" } });
    }
    expect(provider.calls[0]?.turnOrdinal).toBe(1);
    expect(result.exitCode).toBe(0);
  },
  TEST_TIMEOUT_MS,
);

test(
  "rpc EOF interrupts a steer-mode prompt waiting on the running Turn without dropping its Steering",
  async () => {
    const provider = blockingProvider();
    const rpc = rpcHarness();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const session = yield* driver.createSession();
        const progress = yield* watchProgress(driver, session.id, rpc);
        const head = yield* runRpcHead({ input: rpc.input, writer: rpc.writer }).pipe(Effect.fork);
        yield* rpc.send({
          _tag: "prompt",
          content: "Keep running after EOF.",
          id: "prompt-before-eof",
          sessionId: session.id,
        });
        yield* rpc.until("Provider request 1", Deferred.await(provider.entered));
        yield* rpc.send({
          _tag: "prompt",
          content: "Steer before EOF.",
          deliveryMode: "steer",
          id: "prompt-steer-before-eof",
          sessionId: session.id,
        });
        yield* progress.awaitTag("steeringQueued");
        yield* rpc.end;
        const exitCode = yield* rpc.until("the Head to exit", Fiber.join(head));
        yield* Deferred.succeed(provider.release, undefined);
        yield* progress.awaitTag("turnSettled");
        const settled = yield* driver.getSnapshot(session.id);
        yield* progress.stop;
        return { exitCode, settled };
      }).pipe(
        rpc.guard,
        Effect.ensuring(
          Deferred.succeed(provider.release, undefined).pipe(Effect.zipRight(rpc.end)),
        ),
        Effect.provide(steeringLayer(provider.service)),
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(rpc.responses()).toEqual([]);
    expect(provider.calls.map((call) => call.turnOrdinal)).toEqual([1, 1]);
    expect(
      result.settled.entries
        .filter((entry) => entry.kind === "message")
        .map((entry) => (entry.payload as { readonly content?: unknown }).content),
    ).toEqual(["Keep running after EOF.", "reply 1", "Steer before EOF.", "reply 2"]);
  },
  TEST_TIMEOUT_MS,
);

const goalSetFrame = (sessionId: SessionId): Frame => ({
  _tag: "invoke-command",
  args: { action: "set", objective: "Finish the report." },
  id: "goal-set",
  name: "goal",
  sessionId,
});

test(
  "rpc steer reaches a Goal continuation Turn started by resume-goal and acknowledges before it settles",
  async () => {
    const provider = goalProvider(1);
    const rpc = rpcHarness();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const session = yield* driver.createSession();
        const head = yield* runRpcHead({ input: rpc.input, writer: rpc.writer }).pipe(Effect.fork);
        yield* rpc.send(goalSetFrame(session.id));
        yield* rpc.awaitResponse("goal-set");
        yield* rpc.send({ _tag: "resume-goal", id: "resume-goal", sessionId: session.id });
        yield* rpc.until("Provider request 1", Deferred.await(provider.entered));
        yield* rpc.send({
          _tag: "steer",
          content: "Steer the Goal.",
          id: "steer-goal",
          sessionId: session.id,
        });
        const steer = yield* rpc.awaitResponse("steer-goal");
        yield* rpc.mark("provider-released");
        yield* Deferred.succeed(provider.release, undefined);
        const resumed = yield* rpc.awaitResponse("resume-goal");
        yield* rpc.end;
        const exitCode = yield* Fiber.join(head);
        return { exitCode, resumed, steer };
      }).pipe(
        rpc.guard,
        Effect.ensuring(
          Deferred.succeed(provider.release, undefined).pipe(Effect.zipRight(rpc.end)),
        ),
        Effect.provide(steeringLayer(provider.service, undefined, [finishGoalTool])),
      ),
    );

    expect(result.steer).toEqual({ id: "steer-goal", result: { _tag: "ack" } });
    expect(rpc.order().indexOf("steer-goal")).toBeLessThan(
      rpc.order().indexOf("#provider-released"),
    );
    expect(provider.calls.map((call) => call.turnOrdinal)).toEqual([1, 1, 1]);
    expect(provider.calls[0]?.messages).not.toContain("user:Steer the Goal.");
    expect(provider.calls[1]?.messages).toContain("user:Steer the Goal.");
    expect(deliveryModeOf(result.resumed, "Steer the Goal.")).toBe("steer");
    expect(result.resumed).toMatchObject({ id: "resume-goal", result: { _tag: "snapshot" } });
    expect(result.exitCode).toBe(0);
  },
  TEST_TIMEOUT_MS,
);

test(
  "rpc steer reaches the Goal continuation Turn of a running prompt and acknowledges before it settles",
  async () => {
    const provider = goalProvider(2);
    const rpc = rpcHarness();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const session = yield* driver.createSession();
        const head = yield* runRpcHead({ input: rpc.input, writer: rpc.writer }).pipe(Effect.fork);
        yield* rpc.send(goalSetFrame(session.id));
        yield* rpc.awaitResponse("goal-set");
        yield* rpc.send({
          _tag: "prompt",
          content: "Work on the Goal.",
          id: "prompt-goal",
          sessionId: session.id,
        });
        yield* rpc.until(
          "Provider request 2 (the Goal continuation Turn)",
          Deferred.await(provider.entered),
        );
        yield* rpc.send({
          _tag: "steer",
          content: "Steer the Goal.",
          id: "steer-goal",
          sessionId: session.id,
        });
        const steer = yield* rpc.awaitResponse("steer-goal");
        yield* rpc.mark("provider-released");
        yield* Deferred.succeed(provider.release, undefined);
        const prompt = yield* rpc.awaitResponse("prompt-goal");
        yield* rpc.end;
        const exitCode = yield* Fiber.join(head);
        return { exitCode, prompt, steer };
      }).pipe(
        rpc.guard,
        Effect.ensuring(
          Deferred.succeed(provider.release, undefined).pipe(Effect.zipRight(rpc.end)),
        ),
        Effect.provide(steeringLayer(provider.service, undefined, [finishGoalTool])),
      ),
    );

    expect(result.steer).toEqual({ id: "steer-goal", result: { _tag: "ack" } });
    expect(rpc.order().indexOf("steer-goal")).toBeLessThan(
      rpc.order().indexOf("#provider-released"),
    );
    expect(provider.calls.map((call) => call.turnOrdinal)).toEqual([1, 2, 2, 2]);
    expect(provider.calls[1]?.messages).not.toContain("user:Steer the Goal.");
    expect(provider.calls[2]?.messages).toContain("user:Steer the Goal.");
    expect(deliveryModeOf(result.prompt, "Steer the Goal.")).toBe("steer");
    expect(result.prompt).toMatchObject({ id: "prompt-goal", result: { _tag: "snapshot" } });
    expect(result.exitCode).toBe(0);
  },
  TEST_TIMEOUT_MS,
);

test(
  "rpc prompt with deliveryMode steer joins the Goal continuation Turn of a running prompt",
  async () => {
    const provider = goalProvider(2);
    const rpc = rpcHarness();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const session = yield* driver.createSession();
        const progress = yield* watchProgress(driver, session.id, rpc);
        const head = yield* runRpcHead({ input: rpc.input, writer: rpc.writer }).pipe(Effect.fork);
        yield* rpc.send(goalSetFrame(session.id));
        yield* rpc.awaitResponse("goal-set");
        yield* rpc.send({
          _tag: "prompt",
          content: "Work on the Goal.",
          id: "prompt-goal",
          sessionId: session.id,
        });
        yield* rpc.until(
          "Provider request 2 (the Goal continuation Turn)",
          Deferred.await(provider.entered),
        );
        yield* rpc.send({
          _tag: "prompt",
          content: "Steer through prompt.",
          deliveryMode: "steer",
          id: "prompt-steer",
          sessionId: session.id,
        });
        yield* progress.awaitTag("steeringQueued");
        yield* rpc.mark("provider-released");
        yield* Deferred.succeed(provider.release, undefined);
        const prompt = yield* rpc.awaitResponse("prompt-goal");
        const steered = yield* rpc.awaitResponse("prompt-steer");
        yield* progress.stop;
        yield* rpc.end;
        const exitCode = yield* Fiber.join(head);
        return { exitCode, prompt, steered };
      }).pipe(
        rpc.guard,
        Effect.ensuring(
          Deferred.succeed(provider.release, undefined).pipe(Effect.zipRight(rpc.end)),
        ),
        Effect.provide(steeringLayer(provider.service, undefined, [finishGoalTool])),
      ),
    );

    expect(provider.calls.map((call) => call.turnOrdinal)).toEqual([1, 2, 2, 2]);
    expect(provider.calls[1]?.messages).not.toContain("user:Steer through prompt.");
    expect(provider.calls[2]?.messages).toContain("user:Steer through prompt.");
    expect(deliveryModeOf(result.prompt, "Steer through prompt.")).toBe("steer");
    expect(result.steered).toMatchObject({ id: "prompt-steer", result: { _tag: "snapshot" } });
    expect(messages(result.steered)).toEqual(messages(result.prompt));
    expect(rpc.order().indexOf("#provider-released")).toBeLessThan(
      rpc.order().indexOf("prompt-steer"),
    );
    expect(result.exitCode).toBe(0);
  },
  TEST_TIMEOUT_MS,
);
