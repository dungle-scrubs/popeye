import {
  createMemoryJournalBacking,
  type EntryDraft,
  EntryDraftSchema,
  Journal,
  JournalError,
  JournalMemory,
} from "@pop-eye/journal";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
  type Scope,
  Stream,
  Tracer,
} from "effect";
import { expect, test } from "vitest";
import { Compaction, CompactionLive, type CompactionPolicyOptions } from "./compaction-policy.js";
import { ProviderError } from "./errors.js";
import { MailboxLive } from "./mailbox.js";
import { PluginHostNone } from "./plugin-host.js";
import { type Progress, ProgressHubLive } from "./progress.js";
import {
  type AssistantItem,
  type ContextItem,
  Provider,
  type ProviderService,
} from "./provider.js";
import { appendOperationStarted, createOperationId } from "./records.js";
import { Sessions, SessionsLive } from "./sessions.js";
import { defineTool, type Tool, ToolRegistryLive } from "./tool.js";
import {
  TURN_INPUT_QUEUE_CAPACITY,
  TurnOrchestrator,
  TurnOrchestratorLive,
} from "./turn-orchestrator.js";

const providerLayer = (service: ProviderService): Layer.Layer<Provider> =>
  Layer.succeed(Provider, service);

const testLayer = (
  service: ProviderService,
  journalLayer = JournalMemory(createMemoryJournalBacking()),
  toolLayer = ToolRegistryLive([]),
  compactionOptions: CompactionPolicyOptions = {},
) => {
  const mailboxLayer = MailboxLive().pipe(Layer.provide(journalLayer));
  const sessionsLayer = SessionsLive().pipe(
    Layer.provide(Layer.mergeAll(journalLayer, mailboxLayer, toolLayer)),
  );
  const dependencies = Layer.mergeAll(
    journalLayer,
    mailboxLayer,
    ProgressHubLive(),
    providerLayer(service),
    toolLayer,
  );
  const compactionLayer = CompactionLive(compactionOptions).pipe(Layer.provide(dependencies));
  const turnDependencies = Layer.mergeAll(dependencies, compactionLayer, PluginHostNone);
  return Layer.mergeAll(
    turnDependencies,
    sessionsLayer,
    TurnOrchestratorLive().pipe(Layer.provide(turnDependencies)),
  );
};

const scriptedProvider = (items: ReadonlyArray<AssistantItem>): ProviderService => ({
  streamAssistant: () => Stream.fromIterable(items),
});

const failSecondBranchRead = () => {
  const backing = createMemoryJournalBacking();
  const base = JournalMemory(backing);
  return Layer.effect(
    Journal,
    Effect.gen(function* () {
      const journal = yield* Journal;
      const reads = yield* Ref.make(0);
      return {
        ...journal,
        readBranch: (sessionId) =>
          Ref.updateAndGet(reads, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 2
                ? Effect.fail(
                    new JournalError({
                      corruptionClass: "io_failure",
                      message: "Injected branch read failure.",
                    }),
                  )
                : journal.readBranch(sessionId),
            ),
          ),
      };
    }),
  ).pipe(Layer.provide(base));
};

const failToolStartedRecord = () => {
  const base = JournalMemory(createMemoryJournalBacking());
  return Layer.effect(
    Journal,
    Effect.gen(function* () {
      const journal = yield* Journal;
      return {
        ...journal,
        appendRecord: (sessionId, record) =>
          record.kind === "tool_started"
            ? Effect.fail(
                new JournalError({
                  corruptionClass: "io_failure",
                  message: "Injected tool_started Record failure.",
                }),
              )
            : journal.appendRecord(sessionId, record),
      };
    }),
  ).pipe(Layer.provide(base));
};

const pauseAfterOperationStarted = (
  entered: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
) => {
  const base = JournalMemory(createMemoryJournalBacking());
  return Layer.effect(
    Journal,
    Effect.gen(function* () {
      const journal = yield* Journal;
      return {
        ...journal,
        appendRecord: (sessionId, record) =>
          journal
            .appendRecord(sessionId, record)
            .pipe(
              Effect.flatMap((appended) =>
                record.kind === "operation_started"
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.zipRight(Deferred.await(release)),
                      Effect.as(appended),
                    )
                  : Effect.succeed(appended),
              ),
            ),
      };
    }),
  ).pipe(Layer.provide(base));
};

const pauseBranchRead = (
  readNumber: number,
  entered: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
) => {
  const backing = createMemoryJournalBacking();
  const base = JournalMemory(backing);
  return Layer.effect(
    Journal,
    Effect.gen(function* () {
      const journal = yield* Journal;
      const reads = yield* Ref.make(0);
      return {
        ...journal,
        readBranch: (sessionId) =>
          Ref.updateAndGet(reads, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === readNumber
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.zipRight(Deferred.await(release)),
                    Effect.zipRight(journal.readBranch(sessionId)),
                  )
                : journal.readBranch(sessionId),
            ),
          ),
      };
    }),
  ).pipe(Layer.provide(base));
};

const pauseSecondBranchRead = (
  entered: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
) => pauseBranchRead(2, entered, release);

const pauseAssistantAppend = (
  entered: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
) => {
  const backing = createMemoryJournalBacking();
  const base = JournalMemory(backing);
  return Layer.effect(
    Journal,
    Effect.gen(function* () {
      const journal = yield* Journal;
      return {
        ...journal,
        appendEntry: (sessionId, entry: EntryDraft) => {
          const payload = entry.payload as { readonly role?: unknown };
          return payload.role === "assistant"
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.zipRight(Deferred.await(release)),
                Effect.zipRight(journal.appendEntry(sessionId, entry)),
              )
            : journal.appendEntry(sessionId, entry);
        },
      };
    }),
  ).pipe(Layer.provide(base));
};

const pauseSettlementCount = (
  entered: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
) => {
  const backing = createMemoryJournalBacking();
  const base = JournalMemory(backing);
  return Layer.effect(
    Journal,
    Effect.gen(function* () {
      const journal = yield* Journal;
      const assistantAppended = yield* Ref.make(false);
      const paused = yield* Ref.make(false);
      return {
        ...journal,
        appendEntry: (sessionId, entry: EntryDraft) => {
          const payload = entry.payload as { readonly role?: unknown };
          return journal
            .appendEntry(sessionId, entry)
            .pipe(
              Effect.tap(() =>
                payload.role === "assistant" ? Ref.set(assistantAppended, true) : Effect.void,
              ),
            );
        },
        countDurableLines: (sessionId) =>
          Effect.all([Ref.get(assistantAppended), Ref.get(paused)]).pipe(
            Effect.flatMap(([hasAssistant, alreadyPaused]) =>
              hasAssistant && !alreadyPaused
                ? Ref.set(paused, true).pipe(
                    Effect.zipRight(Deferred.succeed(entered, undefined)),
                    Effect.zipRight(Deferred.await(release)),
                    Effect.zipRight(journal.countDurableLines(sessionId)),
                  )
                : journal.countDurableLines(sessionId),
            ),
          ),
      };
    }),
  ).pipe(Layer.provide(base));
};

interface CapturedSpan {
  readonly attributes: Map<string, unknown>;
  exit: Exit.Exit<unknown, unknown> | undefined;
  readonly name: string;
}

const tracerLayer = (spans: Array<CapturedSpan>): Layer.Layer<never> => {
  const tracer = Tracer.make({
    context: (evaluate) => evaluate(),
    span: (name, parent, context, links, startTime, kind, options) => {
      const captured: CapturedSpan = {
        attributes: new Map(Object.entries(options?.attributes ?? {})),
        exit: undefined,
        name,
      };
      spans.push(captured);
      return {
        _tag: "Span",
        addLinks: () => undefined,
        attribute: (key, value) => captured.attributes.set(key, value),
        attributes: captured.attributes,
        context,
        end: (_endTime, exit) => {
          captured.exit = exit;
        },
        event: () => undefined,
        kind,
        links,
        name,
        parent,
        sampled: true,
        spanId: `${spans.length}`,
        status: { _tag: "Started", startTime },
        traceId: "captured",
      } satisfies Tracer.Span;
    },
  });
  return Layer.merge(Layer.setTracer(tracer), Layer.setTracerEnabled(true));
};

test("tool-free turn walks IDLE through SETTLING to IDLE and persists final stop reason done", async () => {
  const observed: Array<Progress> = [];
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(orchestrator.subscribeProgress(session.id), (item) =>
          Effect.sync(() => observed.push(item)),
        ),
      );
      yield* Effect.yieldNow();

      yield* orchestrator.openTurn(session.id, "Hello");

      yield* Fiber.interrupt(progress);
      return {
        branch: yield* journal.readBranch(session.id),
        progress: observed,
      };
    }).pipe(
      Effect.provide(
        testLayer(
          scriptedProvider([
            { _tag: "textDelta", text: "Hello back." },
            { _tag: "done", stopReason: "done" },
          ]),
        ),
      ),
    ),
  );

  expect(result.progress.filter((item) => item._tag === "phaseChanged")).toEqual([
    { _tag: "phaseChanged", phase: "IDLE" },
    { _tag: "phaseChanged", phase: "ASSEMBLING" },
    { _tag: "phaseChanged", phase: "STREAMING" },
    { _tag: "phaseChanged", phase: "SETTLING" },
    { _tag: "phaseChanged", phase: "IDLE" },
  ]);
  expect(result.branch).toMatchObject([
    { kind: "session_root", parentId: null },
    { kind: "message", payload: { content: "Hello", role: "user" } },
    {
      kind: "message",
      payload: { content: "Hello back.", role: "assistant", stopReason: "done" },
    },
  ]);
  expect(result.branch[1]?.parentId).toBe(result.branch[0]?.id);
  expect(result.branch[2]?.parentId).toBe(result.branch[1]?.id);
});

test("truncated provider output settles the turn and progress without degrading to done", async () => {
  const observed: Array<Progress> = [];
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(orchestrator.subscribeProgress(session.id), (item) =>
          Effect.sync(() => observed.push(item)),
        ),
      );
      yield* Effect.yieldNow();

      const settled = yield* orchestrator.openTurn(session.id, "Long answer");

      yield* Fiber.interrupt(progress);
      return { branch: yield* journal.readBranch(session.id), settled };
    }).pipe(
      Effect.provide(
        testLayer(
          scriptedProvider([
            { _tag: "textDelta", text: "Partial answer." },
            { _tag: "done", stopReason: "truncated" },
          ]),
        ),
      ),
    ),
  );

  expect(result.settled).toEqual({ stopReason: "truncated" });
  expect(result.branch.at(-1)?.payload).toMatchObject({
    content: "Partial answer.",
    role: "assistant",
    stopReason: "truncated",
  });
  expect(observed).toContainEqual({ _tag: "turnSettled", revision: 5, stopReason: "truncated" });
});

test("assistant text and thinking deltas stream only during STREAMING and persist their concatenation", async () => {
  const observed: Array<Progress> = [];
  const branch = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(orchestrator.subscribeProgress(session.id), (item) =>
          Effect.sync(() => observed.push(item)),
        ),
      );
      yield* Effect.yieldNow();
      yield* orchestrator.openTurn(session.id, "Explain this");
      yield* Fiber.interrupt(progress);
      return yield* journal.readBranch(session.id);
    }).pipe(
      Effect.provide(
        testLayer(
          scriptedProvider([
            { _tag: "thinkingDelta", text: "Considering context." },
            { _tag: "textDelta", text: "It " },
            { _tag: "textDelta", text: "works." },
            { _tag: "done", stopReason: "done" },
          ]),
        ),
      ),
    ),
  );

  const deltaIndexes = observed.flatMap((item, index) =>
    item._tag === "assistantText" || item._tag === "assistantThinking" ? [index] : [],
  );
  expect(deltaIndexes).not.toHaveLength(0);
  for (const index of deltaIndexes) {
    const before = observed.slice(0, index + 1).findLast((item) => item._tag === "phaseChanged");
    expect(before).toEqual({ _tag: "phaseChanged", phase: "STREAMING" });
  }
  expect(observed.filter((item) => item._tag === "assistantText")).toEqual([
    { _tag: "assistantText", text: "It " },
    { _tag: "assistantText", text: "works." },
  ]);
  expect(branch.at(-1)).toMatchObject({
    payload: { content: "It works.", role: "assistant", stopReason: "done" },
  });
});

test("steer during a tool-free turn drains at SETTLING and loops before settlement", async () => {
  const enteredSettling = await Effect.runPromise(Deferred.make<void>());
  const releaseSettling = await Effect.runPromise(Deferred.make<void>());
  const contexts: Array<ReadonlyArray<ContextItem>> = [];
  const observed: Array<Progress> = [];
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: (context) => {
      contexts.push(context);
      requests += 1;
      return Stream.fromIterable([
        { _tag: "textDelta" as const, text: requests === 1 ? "First reply." : "Second reply." },
        { _tag: "done" as const, stopReason: "done" as const },
      ]);
    },
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(orchestrator.subscribeProgress(session.id), (item) =>
          Effect.sync(() => observed.push(item)),
        ),
      );
      yield* Effect.yieldNow();
      const running = yield* Effect.fork(orchestrator.openTurn(session.id, "Initial prompt"));
      yield* Deferred.await(enteredSettling);
      yield* orchestrator.steer(session.id, "Steer at settle");
      yield* Deferred.succeed(releaseSettling, undefined);
      const settled = yield* Fiber.join(running);
      yield* Fiber.interrupt(progress);
      return { branch: yield* journal.readBranch(session.id), settled };
    }).pipe(
      Effect.provide(testLayer(provider, pauseAssistantAppend(enteredSettling, releaseSettling))),
    ),
  );

  expect(requests).toBe(2);
  expect(contexts[1]).toEqual([
    { content: "Initial prompt", role: "user" },
    { content: "First reply.", role: "assistant" },
    { content: "Steer at settle", role: "user" },
  ]);
  expect(observed.findIndex((item) => item._tag === "steeringQueued")).toBeLessThan(
    observed.findIndex((item) => item._tag === "steeringApplied"),
  );
  expect(result.settled).toEqual({ stopReason: "done" });
  expect(result.branch.map((entry) => entry.payload)).toMatchObject([
    {},
    { content: "Initial prompt", role: "user" },
    { content: "First reply.", role: "assistant", stopReason: "done" },
    { content: "Steer at settle", role: "user" },
    { content: "Second reply.", role: "assistant", stopReason: "done" },
  ]);
});

test("permanent ProviderError never retries and converts queued steering to FIFO follow-up turns", async () => {
  const firstProviderEntered = await Effect.runPromise(Deferred.make<void>());
  const releaseFirstProvider = await Effect.runPromise(Deferred.make<void>());
  const convertedTurnsSettled = await Effect.runPromise(Deferred.make<void>());
  const contexts: Array<ReadonlyArray<ContextItem>> = [];
  const observed: Array<Progress> = [];
  let settlements = 0;
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: (context) => {
      contexts.push(context);
      requests += 1;
      if (requests === 1) {
        return Stream.fromEffect(
          Deferred.succeed(firstProviderEntered, undefined).pipe(
            Effect.zipRight(Deferred.await(releaseFirstProvider)),
            Effect.zipRight(
              Effect.fail(
                new ProviderError({ message: "Permanent Provider failure.", transient: false }),
              ),
            ),
          ),
        );
      }
      return Stream.fromIterable([
        { _tag: "textDelta" as const, text: `Follow-up answer ${requests}.` },
        { _tag: "done" as const, stopReason: "done" as const },
      ]);
    },
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(orchestrator.subscribeProgress(session.id), (item) =>
          Effect.sync(() => observed.push(item)).pipe(
            Effect.zipRight(
              item._tag === "turnSettled" && ++settlements === 3
                ? Deferred.succeed(convertedTurnsSettled, undefined)
                : Effect.void,
            ),
          ),
        ),
      );
      yield* Effect.yieldNow();
      const running = yield* Effect.fork(orchestrator.openTurn(session.id, "Initial"));
      yield* Deferred.await(firstProviderEntered);
      yield* orchestrator.steer(session.id, "Recover first");
      yield* orchestrator.steer(session.id, "Recover second");
      yield* Deferred.succeed(releaseFirstProvider, undefined);
      const settled = yield* Fiber.join(running);
      const followUpsSettled = yield* Deferred.await(convertedTurnsSettled).pipe(
        Effect.timeoutOption("100 millis"),
      );
      yield* Fiber.interrupt(progress);
      return {
        branch: yield* journal.readBranch(session.id),
        followUpsSettled,
        settled,
      };
    }).pipe(Effect.provide(testLayer(provider))),
  );

  expect(result.settled).toEqual({ stopReason: "error" });
  expect(Option.isSome(result.followUpsSettled)).toBe(true);
  expect(requests).toBe(3);
  expect(observed.filter((item) => item._tag === "providerRetryScheduled")).toEqual([]);
  expect(
    observed.filter((item) => item._tag === "followUpQueued").map((item) => item.content),
  ).toEqual(["Recover first", "Recover second"]);
  expect(contexts[1]).toEqual([
    { content: "Initial", role: "user" },
    { content: "", role: "assistant" },
    { content: "Recover first", role: "user" },
  ]);
  expect(contexts[2]?.at(-1)).toEqual({ content: "Recover second", role: "user" });
  expect(result.branch.at(-1)).toMatchObject({
    payload: { content: "Follow-up answer 3.", role: "assistant", stopReason: "done" },
  });
});

test("abort in the settlement drain window prevents a queued steering loop", async () => {
  const enteredSettling = await Effect.runPromise(Deferred.make<void>());
  const releaseSettling = await Effect.runPromise(Deferred.make<void>());
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: () => {
      requests += 1;
      return Stream.fromIterable([
        { _tag: "textDelta" as const, text: "Completed round." },
        { _tag: "done" as const, stopReason: "done" as const },
      ]);
    },
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const running = yield* Effect.fork(orchestrator.openTurn(session.id, "Initial"));
      yield* Deferred.await(enteredSettling);
      yield* orchestrator.steer(session.id, "Do not loop");
      const aborted = yield* orchestrator.abortTurn(session.id);
      yield* Deferred.succeed(releaseSettling, undefined);
      const settled = yield* Fiber.join(running);
      return {
        aborted,
        branch: yield* journal.readBranch(session.id),
        settled,
      };
    }).pipe(
      Effect.provide(testLayer(provider, pauseAssistantAppend(enteredSettling, releaseSettling))),
    ),
  );

  expect(result.aborted).toEqual({ aborted: true, note: "loop-prevented", turnOrdinal: 1 });
  expect(result.settled).toEqual({ stopReason: "done" });
  expect(requests).toBe(1);
  expect(result.branch.map((entry) => entry.payload)).toMatchObject([
    {},
    { content: "Initial", role: "user" },
    { content: "Completed round.", role: "assistant", stopReason: "done" },
  ]);
  expect(result.branch).not.toContainEqual(
    expect.objectContaining({ payload: expect.objectContaining({ content: "Do not loop" }) }),
  );
});

test("abort during looped ASSEMBLING does not reuse text from the completed round", async () => {
  const firstProviderEntered = await Effect.runPromise(Deferred.make<void>());
  const releaseFirstProvider = await Effect.runPromise(Deferred.make<void>());
  const loopAssembling = await Effect.runPromise(Deferred.make<void>());
  const releaseLoopAssembling = await Effect.runPromise(Deferred.make<void>());
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: () => {
      requests += 1;
      return Stream.fromEffect(
        Deferred.succeed(firstProviderEntered, undefined).pipe(
          Effect.zipRight(Deferred.await(releaseFirstProvider)),
          Effect.as({ _tag: "textDelta" as const, text: "reply 1 text" }),
        ),
      ).pipe(Stream.concat(Stream.fromIterable([{ _tag: "done", stopReason: "done" }] as const)));
    },
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const running = yield* Effect.fork(orchestrator.openTurn(session.id, "Initial"));
      yield* Deferred.await(firstProviderEntered);
      yield* orchestrator.steer(session.id, "Loop once");
      yield* Deferred.succeed(releaseFirstProvider, undefined);
      yield* Deferred.await(loopAssembling);
      const aborted = yield* orchestrator.abortTurn(session.id);
      yield* Deferred.succeed(releaseLoopAssembling, undefined);
      return {
        aborted,
        branch: yield* journal.readBranch(session.id),
        settled: yield* Fiber.join(running),
      };
    }).pipe(
      Effect.provide(
        testLayer(provider, pauseBranchRead(3, loopAssembling, releaseLoopAssembling)),
      ),
    ),
  );

  expect(requests).toBe(1);
  expect(result.aborted).toEqual({ aborted: true, turnOrdinal: 1 });
  expect(result.settled).toEqual({ stopReason: "aborted" });
  expect(result.branch.at(-1)).toMatchObject({
    payload: { content: "", role: "assistant", stopReason: "aborted" },
  });
});

test("prompt during a running turn routes steer mode to steering and defaults to follow-up", async () => {
  const providerEntered = await Effect.runPromise(Deferred.make<void>());
  const releaseProvider = await Effect.runPromise(Deferred.make<void>());
  const observed: Array<Progress> = [];
  const ordinals: Array<number> = [];
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: (_context, options) => {
      ordinals.push(options.turnOrdinal);
      requests += 1;
      if (requests === 1) {
        return Stream.fromEffect(
          Deferred.succeed(providerEntered, undefined).pipe(
            Effect.zipRight(Deferred.await(releaseProvider)),
            Effect.as({ _tag: "done" as const, stopReason: "done" as const }),
          ),
        );
      }
      return Stream.fromIterable([
        {
          _tag: "textDelta" as const,
          text: requests === 2 ? "Steered reply." : "Follow-up reply.",
        },
        { _tag: "done" as const, stopReason: "done" as const },
      ]);
    },
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(orchestrator.subscribeProgress(session.id), (item) =>
          Effect.sync(() => observed.push(item)),
        ),
      );
      yield* Effect.yieldNow();
      const initial = yield* Effect.fork(orchestrator.openTurn(session.id, "Initial"));
      yield* Deferred.await(providerEntered);
      const steered = yield* Effect.fork(
        orchestrator.openTurn(session.id, "Steer mode", undefined, { deliveryMode: "steer" }),
      );
      yield* Effect.yieldNow();
      const followed = yield* Effect.fork(orchestrator.openTurn(session.id, "Default follow-up"));
      yield* Effect.yieldNow();
      yield* Deferred.succeed(releaseProvider, undefined);
      const results = yield* Effect.all(
        [Fiber.join(initial), Fiber.join(steered), Fiber.join(followed)],
        { concurrency: "unbounded" },
      );
      yield* Fiber.interrupt(progress);
      return { branch: yield* journal.readBranch(session.id), results };
    }).pipe(Effect.provide(testLayer(provider))),
  );

  expect(result.results).toEqual([
    { stopReason: "done" },
    { stopReason: "done" },
    { stopReason: "done" },
  ]);
  expect(ordinals).toEqual([1, 1, 2]);
  expect(observed).toContainEqual({ _tag: "steeringQueued", content: "Steer mode" });
  expect(observed).toContainEqual({ _tag: "followUpQueued", content: "Default follow-up" });
  expect(result.branch.map((entry) => entry.payload)).toMatchObject([
    {},
    { content: "Initial", role: "user" },
    { role: "assistant", stopReason: "done" },
    { content: "Steer mode", role: "user" },
    { content: "Steered reply.", role: "assistant", stopReason: "done" },
    { content: "Default follow-up", role: "user" },
    { content: "Follow-up reply.", role: "assistant", stopReason: "done" },
  ]);
});

test("follow-up opens the next turn automatically after the running turn settles", async () => {
  const providerEntered = await Effect.runPromise(Deferred.make<void>());
  const releaseProvider = await Effect.runPromise(Deferred.make<void>());
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: () => {
      requests += 1;
      if (requests === 1) {
        return Stream.fromEffect(
          Deferred.succeed(providerEntered, undefined).pipe(
            Effect.zipRight(Deferred.await(releaseProvider)),
            Effect.as({ _tag: "done" as const, stopReason: "done" as const }),
          ),
        );
      }
      return Stream.fromIterable([
        { _tag: "textDelta" as const, text: "Second turn." },
        { _tag: "done" as const, stopReason: "done" as const },
      ]);
    },
  };

  const branch = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const initial = yield* Effect.fork(orchestrator.openTurn(session.id, "First turn"));
      yield* Deferred.await(providerEntered);
      const followUp = yield* Effect.fork(orchestrator.openTurn(session.id, "Second turn"));
      yield* Effect.yieldNow();
      yield* Deferred.succeed(releaseProvider, undefined);
      yield* Fiber.join(initial);
      yield* Fiber.join(followUp);
      return yield* journal.readBranch(session.id);
    }).pipe(Effect.provide(testLayer(provider))),
  );

  expect(branch.map((entry) => entry.payload)).toMatchObject([
    {},
    { content: "First turn", role: "user" },
    { role: "assistant", stopReason: "done" },
    { content: "Second turn", role: "user" },
    { content: "Second turn.", role: "assistant", stopReason: "done" },
  ]);
});

test("abort discards queued steering and retains follow-ups for the next turn", async () => {
  const followUpQueued = await Effect.runPromise(Deferred.make<void>());
  const providerEntered = await Effect.runPromise(Deferred.make<void>());
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: () => {
      requests += 1;
      return requests === 1
        ? Stream.fromEffect(
            Deferred.succeed(providerEntered, undefined).pipe(Effect.zipRight(Effect.never)),
          )
        : Stream.fromIterable([
            { _tag: "textDelta" as const, text: "Follow-up survived." },
            { _tag: "done" as const, stopReason: "done" as const },
          ]);
    },
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(orchestrator.subscribeProgress(session.id), (item) =>
          item._tag === "followUpQueued"
            ? Deferred.succeed(followUpQueued, undefined)
            : Effect.void,
        ),
      );
      const initial = yield* Effect.fork(orchestrator.openTurn(session.id, "Initial"));
      yield* Deferred.await(providerEntered);
      yield* orchestrator.steer(session.id, "Discard this steering");
      const followUp = yield* Effect.fork(orchestrator.openTurn(session.id, "Keep this follow-up"));
      yield* Deferred.await(followUpQueued);
      const aborted = yield* orchestrator.abortTurn(session.id);
      const initialResult = yield* Fiber.join(initial);
      const followUpResult = yield* Fiber.join(followUp);
      yield* Fiber.interrupt(progress);
      return {
        aborted,
        branch: yield* journal.readBranch(session.id),
        followUpResult,
        initialResult,
      };
    }).pipe(Effect.provide(testLayer(provider))),
  );

  expect(result.aborted).toEqual({ aborted: true, turnOrdinal: 1 });
  expect(result.initialResult).toEqual({ stopReason: "aborted" });
  expect(result.followUpResult).toEqual({ stopReason: "done" });
  expect(result.branch.map((entry) => entry.payload)).toMatchObject([
    {},
    { content: "Initial", role: "user" },
    { role: "assistant", stopReason: "aborted" },
    { content: "Keep this follow-up", role: "user" },
    { content: "Follow-up survived.", role: "assistant", stopReason: "done" },
  ]);
  expect(result.branch).not.toContainEqual(
    expect.objectContaining({
      payload: expect.objectContaining({ content: "Discard this steering" }),
    }),
  );
});

test("steering while IDLE rejects typed as phase-invalid", async () => {
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      return yield* Effect.flip(orchestrator.steer(session.id, "Cannot steer while idle"));
    }).pipe(Effect.provide(testLayer(scriptedProvider([])))),
  );

  expect(error).toMatchObject({
    _tag: "ProtocolError",
    message: "Steering requires a running turn.",
    reason: "phase_invalid_command",
  });
});

test("runTurn steer delivery at IDLE starts a normal turn", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const settled = yield* orchestrator.openTurn(session.id, "Start from IDLE", undefined, {
        deliveryMode: "steer",
      });
      return { branch: yield* journal.readBranch(session.id), settled };
    }).pipe(
      Effect.provide(
        testLayer(
          scriptedProvider([
            { _tag: "textDelta", text: "Started." },
            { _tag: "done", stopReason: "done" },
          ]),
        ),
      ),
    ),
  );

  expect(result.settled).toEqual({ stopReason: "done" });
  expect(result.branch.map((entry) => entry.payload)).toMatchObject([
    {},
    { content: "Start from IDLE", role: "user" },
    { content: "Started.", role: "assistant", stopReason: "done" },
  ]);
  expect(result.branch[1]?.payload).not.toHaveProperty("deliveryMode");
});

test("runTurn steer delivery converts to follow-up after settlement closes steering", async () => {
  const settlementCountEntered = await Effect.runPromise(Deferred.make<void>());
  const releaseSettlementCount = await Effect.runPromise(Deferred.make<void>());
  const observed: Array<Progress> = [];
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: () => {
      requests += 1;
      return Stream.fromIterable([
        { _tag: "textDelta" as const, text: requests === 1 ? "First." : "Follow-up." },
        { _tag: "done" as const, stopReason: "done" as const },
      ]);
    },
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(orchestrator.subscribeProgress(session.id), (item) =>
          Effect.sync(() => observed.push(item)),
        ),
      );
      yield* Effect.yieldNow();
      const initial = yield* Effect.fork(orchestrator.openTurn(session.id, "Initial"));
      yield* Deferred.await(settlementCountEntered);
      const raced = yield* Effect.fork(
        orchestrator.openTurn(session.id, "Race follow-up", undefined, { deliveryMode: "steer" }),
      );
      yield* Effect.yieldNow();
      yield* Deferred.succeed(releaseSettlementCount, undefined);
      const results = yield* Effect.all([Fiber.join(initial), Fiber.join(raced)], {
        concurrency: "unbounded",
      });
      yield* Fiber.interrupt(progress);
      return { branch: yield* journal.readBranch(session.id), results };
    }).pipe(
      Effect.provide(
        testLayer(provider, pauseSettlementCount(settlementCountEntered, releaseSettlementCount)),
      ),
    ),
  );

  expect(result.results).toEqual([{ stopReason: "done" }, { stopReason: "done" }]);
  expect(requests).toBe(2);
  expect(observed).toContainEqual({ _tag: "followUpQueued", content: "Race follow-up" });
  expect(result.branch.map((entry) => entry.payload)).toMatchObject([
    {},
    { content: "Initial", role: "user" },
    { content: "First.", role: "assistant", stopReason: "done" },
    { content: "Race follow-up", role: "user" },
    { content: "Follow-up.", role: "assistant", stopReason: "done" },
  ]);
});

test("explicit steer converts to follow-up after settlement closes steering", async () => {
  const settlementCountEntered = await Effect.runPromise(Deferred.make<void>());
  const releaseSettlementCount = await Effect.runPromise(Deferred.make<void>());
  const secondSettled = await Effect.runPromise(Deferred.make<void>());
  let settlements = 0;
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: () => {
      requests += 1;
      return Stream.fromIterable([
        { _tag: "textDelta" as const, text: requests === 1 ? "First." : "Follow-up." },
        { _tag: "done" as const, stopReason: "done" as const },
      ]);
    },
  };

  const branch = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(orchestrator.subscribeProgress(session.id), (item) =>
          item._tag === "turnSettled" && ++settlements === 2
            ? Deferred.succeed(secondSettled, undefined)
            : Effect.void,
        ),
      );
      const initial = yield* Effect.fork(orchestrator.openTurn(session.id, "Initial"));
      yield* Deferred.await(settlementCountEntered);
      yield* orchestrator.steer(session.id, "Explicit follow-up");
      yield* Deferred.succeed(releaseSettlementCount, undefined);
      yield* Fiber.join(initial);
      yield* Deferred.await(secondSettled);
      yield* Fiber.interrupt(progress);
      return yield* journal.readBranch(session.id);
    }).pipe(
      Effect.provide(
        testLayer(provider, pauseSettlementCount(settlementCountEntered, releaseSettlementCount)),
      ),
    ),
  );

  expect(requests).toBe(2);
  expect(branch.map((entry) => entry.payload)).toMatchObject([
    {},
    { content: "Initial", role: "user" },
    { content: "First.", role: "assistant", stopReason: "done" },
    { content: "Explicit follow-up", role: "user" },
    { content: "Follow-up.", role: "assistant", stopReason: "done" },
  ]);
});

test("tool calls append results in call order while completion order appears only in progress", async () => {
  const contexts: Array<ReadonlyArray<ContextItem>> = [];
  const fastCompleted = await Effect.runPromise(Deferred.make<void>());
  const observed: Array<Progress> = [];
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: (context) => {
      contexts.push(context);
      requests += 1;
      return requests === 1
        ? Stream.fromIterable([
            { _tag: "toolCall", argumentsJson: '{"value":"slow"}', id: "slow-call", name: "slow" },
            { _tag: "toolCall", argumentsJson: '{"value":"fast"}', id: "fast-call", name: "fast" },
            { _tag: "done", stopReason: "toolCalls" },
          ])
        : Stream.fromIterable([{ _tag: "done", stopReason: "done" }]);
    },
  };
  const slow: Tool<{ readonly value: string }> = {
    description: "Completes after fast.",
    execute: () => Deferred.await(fastCompleted).pipe(Effect.as({ content: "slow result" })),
    name: "slow",
    parameters: Schema.Struct({ value: Schema.String }),
  };
  const fast: Tool<{ readonly value: string }> = {
    description: "Completes first.",
    execute: () =>
      Deferred.succeed(fastCompleted, undefined).pipe(Effect.as({ content: "fast result" })),
    name: "fast",
    parameters: Schema.Struct({ value: Schema.String }),
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(orchestrator.subscribeProgress(session.id), (item) =>
          Effect.sync(() => observed.push(item)),
        ),
      );
      yield* Effect.yieldNow();
      const settled = yield* orchestrator.openTurn(session.id, "Use the tools");
      yield* Fiber.interrupt(progress);
      return { branch: yield* journal.readBranch(session.id), settled };
    }).pipe(
      Effect.provide(
        testLayer(provider, undefined, ToolRegistryLive([defineTool(slow), defineTool(fast)])),
      ),
    ),
  );

  expect(result.settled).toEqual({ stopReason: "done" });
  expect(observed.filter((item) => item._tag === "toolStarted")).toEqual([
    { _tag: "toolStarted", name: "slow", toolCallId: "slow-call" },
    { _tag: "toolStarted", name: "fast", toolCallId: "fast-call" },
  ]);
  expect(observed.filter((item) => item._tag === "toolCompleted")).toEqual([
    { _tag: "toolCompleted", isError: false, toolCallId: "fast-call" },
    { _tag: "toolCompleted", isError: false, toolCallId: "slow-call" },
  ]);
  expect(observed).toContainEqual({ _tag: "phaseChanged", phase: "EXECUTING" });
  expect(result.branch.map((entry) => entry.payload)).toMatchObject([
    {},
    { content: "Use the tools", role: "user" },
    {
      role: "assistant",
      stopReason: "toolCalls",
      toolCalls: [
        { argumentsJson: '{"value":"slow"}', id: "slow-call", name: "slow" },
        { argumentsJson: '{"value":"fast"}', id: "fast-call", name: "fast" },
      ],
    },
    { content: "slow result", role: "toolResult", toolCallId: "slow-call" },
    { content: "fast result", role: "toolResult", toolCallId: "fast-call" },
    { role: "assistant", stopReason: "done" },
  ]);
  expect(contexts[1]).toEqual([
    { content: "Use the tools", role: "user" },
    {
      content: "",
      role: "assistant",
      toolCalls: [
        { argumentsJson: '{"value":"slow"}', id: "slow-call", name: "slow" },
        { argumentsJson: '{"value":"fast"}', id: "fast-call", name: "fast" },
      ],
    },
    {
      content: "slow result",
      isError: false,
      role: "toolResult",
      toolCallId: "slow-call",
      toolName: "slow",
    },
    {
      content: "fast result",
      isError: false,
      role: "toolResult",
      toolCallId: "fast-call",
      toolName: "fast",
    },
  ]);
});

test("a Tool-using turn persists its crash-recovery Record sequence", async () => {
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: () => {
      requests += 1;
      return requests === 1
        ? Stream.fromIterable([
            { _tag: "toolCall", argumentsJson: "{}", id: "recorded-call", name: "recorded" },
            { _tag: "done", stopReason: "toolCalls" },
          ])
        : Stream.fromIterable([{ _tag: "done", stopReason: "done" }]);
    },
  };
  const tool: Tool<Record<string, never>> = {
    description: "Returns a durable result.",
    execute: () => Effect.succeed({ content: "recorded result" }),
    name: "recorded",
    parameters: Schema.Struct({}),
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      yield* orchestrator.openTurn(session.id, "Record this turn");
      return {
        branch: yield* journal.readBranch(session.id),
        records: yield* journal.readRecords(session.id),
      };
    }).pipe(Effect.provide(testLayer(provider, undefined, ToolRegistryLive([defineTool(tool)])))),
  );

  const started = result.records[0];
  const toolStarted = result.records[1];
  const finished = result.records[2];
  const startedPayload = started?.payload as {
    readonly operationId?: unknown;
    readonly promptEntryId?: unknown;
  };
  const toolPayload = toolStarted?.payload as {
    readonly operationId?: unknown;
    readonly replay?: unknown;
  };
  const finishedPayload = finished?.payload as {
    readonly operationId?: unknown;
    readonly outcome?: unknown;
  };

  expect(result.records.map((record) => record.kind)).toEqual([
    "operation_started",
    "tool_started",
    "operation_finished",
  ]);
  expect(startedPayload.promptEntryId).toBe(result.branch[1]?.id);
  expect(toolPayload).toMatchObject({ operationId: startedPayload.operationId, replay: "never" });
  expect(finishedPayload).toMatchObject({
    operationId: startedPayload.operationId,
    outcome: "done",
  });
});

test("a tool_started Record failure closes every assistant Tool call with a result before settlement", async () => {
  let executions = 0;
  const tool = defineTool({
    description: "Must not execute without its durable start Record.",
    execute: () =>
      Effect.sync(() => {
        executions += 1;
        return { content: "executed" };
      }),
    name: "write_file",
    parameters: Schema.Struct({}),
  });
  const provider = scriptedProvider([
    { _tag: "toolCall", argumentsJson: "{}", id: "failed-start-call", name: "write_file" },
    { _tag: "done", stopReason: "toolCalls" },
  ]);

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const error = yield* Effect.flip(orchestrator.openTurn(session.id, "write"));
      return {
        branch: yield* journal.readBranch(session.id),
        error,
        records: yield* journal.readRecords(session.id),
      };
    }).pipe(Effect.provide(testLayer(provider, failToolStartedRecord(), ToolRegistryLive([tool])))),
  );

  expect(executions).toBe(0);
  expect(result.error).toMatchObject({
    _tag: "JournalError",
    message: "Injected tool_started Record failure.",
  });
  expect(result.branch.slice(-2).map((entry) => entry.payload)).toMatchObject([
    {
      content: "Tool execution interrupted.",
      isError: true,
      role: "toolResult",
      toolCallId: "failed-start-call",
    },
    { role: "assistant", stopReason: "error" },
  ]);
  expect(result.records.map((record) => record.kind)).toEqual([
    "operation_started",
    "operation_finished",
  ]);
});

test("a recovered session accepts and settles a new prompt normally", async () => {
  const contexts: Array<ReadonlyArray<ContextItem>> = [];
  const provider: ProviderService = {
    streamAssistant: (context) => {
      contexts.push(context);
      return Stream.fromIterable([
        { _tag: "textDelta" as const, text: "Recovered response." },
        { _tag: "done" as const, stopReason: "done" as const },
      ]);
    },
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const interruptedPrompt = yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: { content: "Interrupted prompt", role: "user" },
        }),
      );
      yield* appendOperationStarted(journal, session.id, {
        intent: "turn",
        operationId: yield* createOperationId(),
        promptEntryId: interruptedPrompt.id,
        turnOrdinal: 1,
      });
      const resumed = yield* sessions.resume(session.id);
      const settled = yield* orchestrator.openTurn(session.id, "Continue after recovery");
      return { branch: yield* journal.readBranch(session.id), resumed, settled };
    }).pipe(Effect.provide(testLayer(provider))),
  );

  expect(result.resumed.recovery).toMatchObject({
    entriesAppended: [expect.any(String)],
    operationIdFound: expect.any(String),
  });
  expect(result.settled).toEqual({ stopReason: "done" });
  expect(contexts[0]).toMatchObject([
    { content: "Interrupted prompt", role: "user" },
    { content: "Turn interrupted by crash.", role: "assistant" },
    { content: "Continue after recovery", role: "user" },
  ]);
  expect(result.branch.slice(-2).map((entry) => entry.payload)).toMatchObject([
    { content: "Continue after recovery", role: "user" },
    { content: "Recovered response.", role: "assistant", stopReason: "done" },
  ]);
});

test("steer during EXECUTING drains after the tool batch before the next provider request", async () => {
  const toolStarted = await Effect.runPromise(Deferred.make<void>());
  const releaseTool = await Effect.runPromise(Deferred.make<void>());
  const contexts: Array<ReadonlyArray<ContextItem>> = [];
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: (context) => {
      contexts.push(context);
      requests += 1;
      return requests === 1
        ? Stream.fromIterable([
            { _tag: "toolCall" as const, argumentsJson: "{}", id: "wait-call", name: "wait" },
            { _tag: "done" as const, stopReason: "toolCalls" as const },
          ])
        : Stream.fromIterable([
            { _tag: "textDelta" as const, text: "Steering applied." },
            { _tag: "done" as const, stopReason: "done" as const },
          ]);
    },
  };
  const wait: Tool<Readonly<Record<string, never>>> = {
    description: "Waits for steering before completing.",
    execute: () =>
      Deferred.succeed(toolStarted, undefined).pipe(
        Effect.zipRight(Deferred.await(releaseTool)),
        Effect.as({ content: "tool result" }),
      ),
    name: "wait",
    parameters: Schema.Struct({}),
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const running = yield* Effect.fork(orchestrator.openTurn(session.id, "Start tools"));
      yield* Deferred.await(toolStarted);
      yield* orchestrator.steer(session.id, "Use this constraint");
      yield* Deferred.succeed(releaseTool, undefined);
      const settled = yield* Fiber.join(running);
      return {
        branch: yield* journal.readBranch(session.id),
        settled,
      };
    }).pipe(Effect.provide(testLayer(provider, undefined, ToolRegistryLive([defineTool(wait)])))),
  );

  expect(result.settled).toEqual({ stopReason: "done" });
  expect(contexts[1]).toEqual([
    { content: "Start tools", role: "user" },
    {
      content: "",
      role: "assistant",
      toolCalls: [{ argumentsJson: "{}", id: "wait-call", name: "wait" }],
    },
    {
      content: "tool result",
      isError: false,
      role: "toolResult",
      toolCallId: "wait-call",
      toolName: "wait",
    },
    { content: "Use this constraint", role: "user" },
  ]);
  expect(result.branch.map((entry) => entry.payload)).toMatchObject([
    {},
    { content: "Start tools", role: "user" },
    { role: "assistant", stopReason: "toolCalls" },
    { content: "tool result", role: "toolResult", toolCallId: "wait-call" },
    { content: "Use this constraint", role: "user" },
    { content: "Steering applied.", role: "assistant", stopReason: "done" },
  ]);
});

test("name-last tool call deltas assemble without discarding early argument fragments", async () => {
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: () => {
      requests += 1;
      return requests === 1
        ? Stream.fromIterable([
            {
              _tag: "toolCallDelta" as const,
              argumentsJsonDelta: '{"value":',
              id: "assembled-call",
              index: 0,
              name: undefined,
            },
            {
              _tag: "toolCallDelta" as const,
              argumentsJsonDelta: '"assembled"}',
              id: "assembled-call",
              index: 0,
              name: "echo",
            },
            { _tag: "done" as const, stopReason: "toolCalls" as const },
          ])
        : Stream.fromIterable([{ _tag: "done" as const, stopReason: "done" as const }]);
    },
  };
  const echo: Tool<{ readonly value: string }> = {
    description: "Echoes the assembled value.",
    execute: (arguments_) => Effect.succeed({ content: arguments_.value }),
    name: "echo",
    parameters: Schema.Struct({ value: Schema.String }),
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const settled = yield* orchestrator.openTurn(session.id, "Assemble fragments");
      return { branch: yield* journal.readBranch(session.id), settled };
    }).pipe(Effect.provide(testLayer(provider, undefined, ToolRegistryLive([defineTool(echo)])))),
  );

  expect(result.settled).toEqual({ stopReason: "done" });
  expect(result.branch.map((entry) => entry.payload)).toMatchObject([
    {},
    { role: "user" },
    {
      role: "assistant",
      toolCalls: [
        {
          argumentsJson: '{"value":"assembled"}',
          id: "assembled-call",
          name: "echo",
        },
      ],
    },
    { content: "assembled", role: "toolResult", toolCallId: "assembled-call" },
    { role: "assistant", stopReason: "done" },
  ]);
});

test("tool defects remain model-visible and the turn continues after healthy siblings", async () => {
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: () => {
      requests += 1;
      return requests === 1
        ? Stream.fromIterable([
            { _tag: "toolCall" as const, argumentsJson: "{}", id: "before", name: "healthy" },
            { _tag: "toolCall" as const, argumentsJson: "{}", id: "throw", name: "throwing" },
            { _tag: "toolCall" as const, argumentsJson: "{}", id: "die", name: "dying" },
            { _tag: "toolCall" as const, argumentsJson: "{}", id: "after", name: "healthy" },
            { _tag: "done" as const, stopReason: "toolCalls" as const },
          ])
        : Stream.fromIterable([
            { _tag: "textDelta" as const, text: "Recovered." },
            { _tag: "done" as const, stopReason: "done" as const },
          ]);
    },
  };
  const healthy: Tool<Readonly<Record<string, never>>> = {
    description: "Succeeds.",
    execute: () => Effect.succeed({ content: "healthy" }),
    name: "healthy",
    parameters: Schema.Struct({}),
  };
  const throwing: Tool<Readonly<Record<string, never>>> = {
    description: "Throws.",
    execute: () =>
      Effect.sync(() => {
        throw new Error("throw defect");
      }),
    name: "throwing",
    parameters: Schema.Struct({}),
  };
  const dying: Tool<Readonly<Record<string, never>>> = {
    description: "Dies.",
    execute: () => Effect.die(new Error("die defect")),
    name: "dying",
    parameters: Schema.Struct({}),
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const settled = yield* orchestrator.openTurn(session.id, "Run all tools");
      return { branch: yield* journal.readBranch(session.id), settled };
    }).pipe(
      Effect.provide(
        testLayer(
          provider,
          undefined,
          ToolRegistryLive([defineTool(healthy), defineTool(throwing), defineTool(dying)]),
        ),
      ),
    ),
  );

  const results = result.branch.filter((entry) => {
    const payload = entry.payload as { readonly role?: unknown };
    return payload.role === "toolResult";
  });
  expect(result.settled).toEqual({ stopReason: "done" });
  expect(results).toHaveLength(4);
  expect(results.map((entry) => entry.payload)).toMatchObject([
    { content: "healthy", isError: false, toolCallId: "before" },
    { isError: true, toolCallId: "throw" },
    { isError: true, toolCallId: "die" },
    { content: "healthy", isError: false, toolCallId: "after" },
  ]);
  expect(result.branch.at(-1)).toMatchObject({
    payload: { content: "Recovered.", role: "assistant", stopReason: "done" },
  });
});

test("a looping tool-call provider settles at the configured provider round bound", async () => {
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: () => {
      requests += 1;
      return Stream.fromIterable([
        {
          _tag: "toolCall" as const,
          argumentsJson: "{}",
          id: `call-${requests}`,
          name: "loop",
        },
        { _tag: "done" as const, stopReason: "toolCalls" as const },
      ]);
    },
  };
  const loop: Tool<Readonly<Record<string, never>>> = {
    description: "Completes one loop round.",
    execute: () => Effect.succeed({ content: "continue" }),
    name: "loop",
    parameters: Schema.Struct({}),
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const settled = yield* orchestrator.openTurn(session.id, "Loop", undefined, {
        maxProviderRounds: 2,
      });
      return { branch: yield* journal.readBranch(session.id), settled };
    }).pipe(Effect.provide(testLayer(provider, undefined, ToolRegistryLive([defineTool(loop)])))),
  );

  expect(requests).toBe(2);
  expect(result.settled).toEqual({ stopReason: "error" });
  expect(result.branch.at(-1)).toMatchObject({
    payload: {
      content: "Maximum provider round bound of 2 exceeded.",
      diagnostic: {
        detail: "Maximum provider round bound of 2 exceeded.",
        reason: "turn_failure",
      },
      role: "assistant",
      stopReason: "error",
    },
  });
});

test("steering-driven loops settle at the configured provider round bound", async () => {
  const firstEntered = await Effect.runPromise(Deferred.make<void>());
  const releaseFirst = await Effect.runPromise(Deferred.make<void>());
  const secondEntered = await Effect.runPromise(Deferred.make<void>());
  const releaseSecond = await Effect.runPromise(Deferred.make<void>());
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: () => {
      requests += 1;
      const entered = requests === 1 ? firstEntered : secondEntered;
      const release = requests === 1 ? releaseFirst : releaseSecond;
      return Stream.fromEffect(
        Deferred.succeed(entered, undefined).pipe(
          Effect.zipRight(Deferred.await(release)),
          Effect.as({ _tag: "done" as const, stopReason: "done" as const }),
        ),
      );
    },
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const running = yield* Effect.fork(
        orchestrator.openTurn(session.id, "Loop", undefined, { maxProviderRounds: 2 }),
      );
      yield* Deferred.await(firstEntered);
      yield* orchestrator.steer(session.id, "Loop one");
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Deferred.await(secondEntered);
      yield* orchestrator.steer(session.id, "Loop two");
      yield* Deferred.succeed(releaseSecond, undefined);
      const settled = yield* Fiber.join(running);
      return { branch: yield* journal.readBranch(session.id), settled };
    }).pipe(Effect.provide(testLayer(provider))),
  );

  expect(requests).toBe(2);
  expect(result.settled).toEqual({ stopReason: "error" });
  expect(result.branch.at(-1)).toMatchObject({
    payload: {
      content: "Maximum provider round bound of 2 exceeded.",
      diagnostic: {
        detail: "Maximum provider round bound of 2 exceeded.",
        reason: "turn_failure",
      },
      role: "assistant",
      stopReason: "error",
    },
  });
});

test("toolCalls stop reason without calls settles as a diagnostic error", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const settled = yield* orchestrator.openTurn(session.id, "Degenerate");
      return { branch: yield* journal.readBranch(session.id), settled };
    }).pipe(
      Effect.provide(testLayer(scriptedProvider([{ _tag: "done", stopReason: "toolCalls" }]))),
    ),
  );

  expect(result.settled).toEqual({ stopReason: "error" });
  expect(result.branch.at(-1)).toMatchObject({
    payload: {
      diagnostic: {
        detail: "Provider returned stopReason toolCalls without any tool calls.",
        reason: "turn_failure",
      },
      role: "assistant",
      stopReason: "error",
    },
  });
});

test("retry exhaustion persists an error Entry and settles the turn", async () => {
  let attempts = 0;
  const failingProvider: ProviderService = {
    streamAssistant: () => {
      attempts += 1;
      return Stream.fromIterable([
        { _tag: "textDelta" as const, text: `Partial ${attempts}.` },
      ]).pipe(
        Stream.concat(
          Stream.fail(
            new ProviderError({ message: "Temporary Provider failure.", transient: true }),
          ),
        ),
      );
    },
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const settled = yield* orchestrator.openTurn(session.id, "Try again", undefined, {
        maxAttempts: 3,
      });
      return { branch: yield* journal.readBranch(session.id), settled };
    }).pipe(Effect.provide(testLayer(failingProvider))),
  );

  expect(attempts).toBe(3);
  expect(result.settled).toEqual({ stopReason: "error" });
  expect(result.branch.at(-1)).toMatchObject({
    kind: "message",
    payload: {
      content: "Partial 3.",
      diagnostic: {
        attempts: 3,
        detail: "Temporary Provider failure.",
        reason: "provider_error",
      },
      role: "assistant",
      stopReason: "error",
    },
  });
});

test("budget exhaustion persists the fold diagnostic and publishes an error settlement", async () => {
  const observed: Array<Progress> = [];
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(orchestrator.subscribeProgress(session.id), (item) =>
          Effect.sync(() => observed.push(item)),
        ),
      );
      yield* Effect.yieldNow();
      const settled = yield* orchestrator.openTurn(session.id, "Too large", undefined, {
        compaction: { enabled: false },
        contextBudget: 0,
      });
      yield* Fiber.interrupt(progress);
      return { branch: yield* journal.readBranch(session.id), settled };
    }).pipe(Effect.provide(testLayer(scriptedProvider([])))),
  );

  expect(result.settled).toEqual({ stopReason: "error" });
  expect(result.branch.at(-1)).toMatchObject({
    payload: {
      diagnostic: { reason: "budget_exceeded" },
      role: "assistant",
      stopReason: "error",
    },
  });
  const payload = result.branch.at(-1)?.payload as {
    readonly content: string;
    readonly diagnostic: { readonly detail: string };
  };
  expect(payload.content).toBe(payload.diagnostic.detail);
  expect(observed.at(-2)).toEqual({ _tag: "turnSettled", revision: 5, stopReason: "error" });
  expect(observed.at(-1)).toEqual({ _tag: "phaseChanged", phase: "IDLE" });
});

test("a disabled Compaction service makes overflow settle without a summarize request", async () => {
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: () => {
      requests += 1;
      return Stream.empty;
    },
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const settled = yield* orchestrator.openTurn(session.id, "Too large", undefined, {
        contextBudget: 0,
      });
      return { branch: yield* journal.readBranch(session.id), settled };
    }).pipe(
      Effect.provide(
        testLayer(provider, undefined, ToolRegistryLive([]), {
          enabled: false,
        }),
      ),
    ),
  );

  expect(requests).toBe(0);
  expect(result.settled).toEqual({ stopReason: "error" });
  expect(result.branch.filter((entry) => entry.kind === "compaction")).toHaveLength(0);
});

test("compactNow waits for an active turn to settle before it compacts", async () => {
  const entered = await Effect.runPromise(Deferred.make<void>());
  const release = await Effect.runPromise(Deferred.make<void>());
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: (_context, options) => {
      requests += 1;
      return options.purpose === "turn"
        ? Stream.fromEffect(
            Deferred.succeed(entered, undefined).pipe(
              Effect.zipRight(Deferred.await(release)),
              Effect.as({ _tag: "done" as const, stopReason: "done" as const }),
            ),
          )
        : Stream.fromIterable([
            { _tag: "textDelta" as const, text: "manual summary" },
            { _tag: "done" as const, stopReason: "done" as const },
          ]);
    },
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const compaction = yield* Compaction;
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const running = yield* Effect.fork(orchestrator.openTurn(session.id, "Hold"));
      yield* Deferred.await(entered);
      const compacting = yield* Effect.fork(compaction.compactNow(session.id));
      yield* Effect.yieldNow();
      const whileRunning = yield* Fiber.poll(compacting);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(running);
      const compacted = yield* Fiber.join(compacting);
      return { branch: yield* journal.readBranch(session.id), compacted, whileRunning };
    }).pipe(Effect.provide(testLayer(provider))),
  );

  expect(Option.isNone(result.whileRunning)).toBe(true);
  expect(requests).toBe(2);
  expect(result.compacted.entriesCovered).toBe(2);
  expect(result.branch.at(-1)?.kind).toBe("compaction");
});

test("context overflow triggers compact-then-retry exactly once per turn", async () => {
  const requestKinds: Array<string | undefined> = [];
  const provider: ProviderService = {
    streamAssistant: (_context, options) => {
      const purpose = (options as { readonly purpose?: string }).purpose;
      requestKinds.push(purpose);
      return purpose === "compaction"
        ? Stream.fromIterable([
            { _tag: "textDelta" as const, text: "summary remains above budget" },
            { _tag: "done" as const, stopReason: "done" as const },
          ])
        : Stream.fromIterable([
            { _tag: "textDelta" as const, text: "Completed." },
            { _tag: "done" as const, stopReason: "done" as const },
          ]);
    },
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: { content: "Older branch content.", role: "user" },
        }),
      );
      const settled = yield* orchestrator.openTurn(session.id, "Now", undefined, {
        compaction: { retainedTailCount: 1, sliceBudget: 256 },
        contextBudget: 12,
      });
      return { branch: yield* journal.readBranch(session.id), settled };
    }).pipe(Effect.provide(testLayer(provider))),
  );

  expect(result.settled).toEqual({ stopReason: "error" });
  expect(result.branch.filter((entry) => entry.kind === "compaction")).toHaveLength(1);
  expect(result.branch.at(-1)).toMatchObject({
    payload: { diagnostic: { reason: "budget_exceeded" }, role: "assistant", stopReason: "error" },
  });
  expect(requestKinds).toEqual(["compaction"]);
});

test("compaction summarization requests are bounded slices", async () => {
  const compactionContexts: Array<ReadonlyArray<ContextItem>> = [];
  const sliceIndexes: Array<number | undefined> = [];
  const summaries: Array<string> = [];
  const provider: ProviderService = {
    streamAssistant: (context, options) => {
      if (options.purpose === "compaction") {
        compactionContexts.push(context);
        sliceIndexes.push(options.sliceIndex);
        const summary = `s${compactionContexts.length}`;
        summaries.push(summary);
        return Stream.fromIterable([
          { _tag: "textDelta" as const, text: summary },
          { _tag: "done" as const, stopReason: "done" as const },
        ]);
      }
      return Stream.fromIterable([{ _tag: "done" as const, stopReason: "done" as const }]);
    },
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: { content: "x".repeat(500), role: "user" },
        }),
      );
      yield* orchestrator.openTurn(session.id, "Now", undefined, {
        compaction: { retainedTailCount: 0, sliceBudget: 256 },
        contextBudget: 64,
      });
      return yield* journal.readBranch(session.id);
    }).pipe(Effect.provide(testLayer(provider))),
  );

  expect(compactionContexts.length).toBeGreaterThan(1);
  expect(sliceIndexes).toEqual(compactionContexts.map((_, index) => index + 1));
  expect(
    compactionContexts.every(
      (context) => context.reduce((size, item) => size + item.content.length, 0) <= 256,
    ),
  ).toBe(true);
  const sourceFragments = compactionContexts.flatMap((context) => context.slice(1));
  expect(sourceFragments.map((item) => item.content).join("")).toBe(`${"x".repeat(500)}Now`);
  const averageFill =
    compactionContexts.reduce(
      (total, context) => total + context.reduce((size, item) => size + item.content.length, 0),
      0,
    ) /
    compactionContexts.length /
    256;
  expect(averageFill).toBeGreaterThan(0.85);
  expect(result.find((entry) => entry.kind === "compaction")?.payload).toMatchObject({
    summary: summaries.join("\n"),
  });
});

test("successive overflows carry the prior summary marker through compaction-of-compaction", async () => {
  const marker = "ORIGINAL-BRANCH-MARKER";
  const compactionContexts: Array<ReadonlyArray<ContextItem>> = [];
  const turnContexts: Array<ReadonlyArray<ContextItem>> = [];
  const provider: ProviderService = {
    streamAssistant: (context, options) => {
      if (options.purpose === "compaction") {
        compactionContexts.push(context);
        const summary = context.some((item) => item.content.includes(marker))
          ? `summary:${marker}`
          : "summary:marker-missing";
        return Stream.fromIterable([
          { _tag: "textDelta" as const, text: summary },
          { _tag: "done" as const, stopReason: "done" as const },
        ]);
      }
      turnContexts.push(context);
      return Stream.fromIterable([
        {
          _tag: "textDelta" as const,
          text: turnContexts.length === 1 ? "z".repeat(80) : "Complete.",
        },
        { _tag: "done" as const, stopReason: "done" as const },
      ]);
    },
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: { content: `${marker}:${"x".repeat(80)}`, role: "user" },
        }),
      );
      const options = {
        compaction: { retainedTailCount: 0, sliceBudget: 256 },
        contextBudget: 40,
      } as const;
      yield* orchestrator.openTurn(session.id, "First", undefined, options);
      yield* orchestrator.openTurn(session.id, "Second", undefined, options);
      return yield* journal.readBranch(session.id);
    }).pipe(Effect.provide(testLayer(provider))),
  );

  expect(result.filter((entry) => entry.kind === "compaction")).toHaveLength(2);
  expect(compactionContexts).toHaveLength(2);
  expect(compactionContexts[1]?.[1]).toMatchObject({
    role: "user",
  });
  expect(compactionContexts[1]?.[1]?.content).toContain("Prior summary:");
  expect(compactionContexts[1]?.[1]?.content).toContain(marker);
  expect(turnContexts[1]?.some((item) => item.content.includes(marker))).toBe(true);
});

test("retained tail extends backward to keep a Tool call with its retained result", async () => {
  const turnContexts: Array<ReadonlyArray<ContextItem>> = [];
  const provider: ProviderService = {
    streamAssistant: (context, options) =>
      options.purpose === "compaction"
        ? Stream.fromIterable([
            { _tag: "textDelta" as const, text: "brief" },
            { _tag: "done" as const, stopReason: "done" as const },
          ])
        : Stream.fromIterable([
            ...(turnContexts.push(context) > 0
              ? [{ _tag: "done" as const, stopReason: "done" as const }]
              : []),
          ]),
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: { content: "x".repeat(100), role: "user" },
        }),
      );
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: {
            content: "Calling tool.",
            role: "assistant",
            stopReason: "toolCalls",
            toolCalls: [{ argumentsJson: "{}", id: "call-1", name: "lookup" }],
          },
        }),
      );
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: {
            content: "tool result",
            isError: false,
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "lookup",
          },
        }),
      );
      yield* orchestrator.openTurn(session.id, "Continue", undefined, {
        compaction: { retainedTailCount: 2, sliceBudget: 256 },
        contextBudget: 60,
      });
    }).pipe(Effect.provide(testLayer(provider))),
  );

  const context = turnContexts[0] ?? [];
  const toolResultIndex = context.findIndex((item) => item.role === "toolResult");
  expect(toolResultIndex).toBeGreaterThan(0);
  expect(context[toolResultIndex - 1]).toMatchObject({
    role: "assistant",
    toolCalls: [{ id: "call-1" }],
  });
});

test("Compaction slices long Tool results into plain user fragments", async () => {
  const compactionContexts: Array<ReadonlyArray<ContextItem>> = [];
  const provider: ProviderService = {
    streamAssistant: (context, options) => {
      if (options.purpose === "compaction") {
        compactionContexts.push(context);
        return Stream.fromIterable([
          { _tag: "textDelta" as const, text: "brief" },
          { _tag: "done" as const, stopReason: "done" as const },
        ]);
      }
      return Stream.fromIterable([{ _tag: "done" as const, stopReason: "done" as const }]);
    },
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: {
            content: "Calling.",
            role: "assistant",
            stopReason: "toolCalls",
            toolCalls: [{ argumentsJson: "{}", id: "long-call", name: "lookup" }],
          },
        }),
      );
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: {
            content: "r".repeat(400),
            isError: false,
            role: "toolResult",
            toolCallId: "long-call",
            toolName: "lookup",
          },
        }),
      );
      yield* orchestrator.openTurn(session.id, "Continue", undefined, {
        compaction: { retainedTailCount: 0, sliceBudget: 256 },
        contextBudget: 32,
      });
    }).pipe(Effect.provide(testLayer(provider))),
  );

  const fragments = compactionContexts.flatMap((context) => context.slice(1));
  expect(compactionContexts.length).toBeGreaterThan(1);
  expect(fragments.every((item) => item.role === "user")).toBe(true);
  expect(fragments.every((item) => !("toolCalls" in item) && !("toolCallId" in item))).toBe(true);
});

test("a transient summarize failure retries under the turn attempt policy", async () => {
  const calls: Array<{
    readonly attempt: number;
    readonly purpose: string | undefined;
    readonly sliceIndex: number | undefined;
  }> = [];
  const provider: ProviderService = {
    streamAssistant: (_context, options) => {
      calls.push({
        attempt: options.attempt,
        purpose: options.purpose,
        sliceIndex: options.sliceIndex,
      });
      if (options.purpose === "compaction" && calls.length === 1) {
        return Stream.fail(
          new ProviderError({ message: "Transient summary blip.", transient: true }),
        );
      }
      return options.purpose === "compaction"
        ? Stream.fromIterable([
            { _tag: "textDelta" as const, text: "brief" },
            { _tag: "done" as const, stopReason: "done" as const },
          ])
        : Stream.fromIterable([{ _tag: "done" as const, stopReason: "done" as const }]);
    },
  };
  const settled = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: { content: "x".repeat(80), role: "user" },
        }),
      );
      return yield* orchestrator.openTurn(session.id, "Now", undefined, {
        compaction: { retainedTailCount: 0, sliceBudget: 256 },
        contextBudget: 20,
        maxAttempts: 2,
        maxProviderRounds: 3,
      });
    }).pipe(Effect.provide(testLayer(provider))),
  );

  expect(settled).toEqual({ stopReason: "done" });
  expect(calls).toEqual([
    { attempt: 1, purpose: "compaction", sliceIndex: 1 },
    { attempt: 2, purpose: "compaction", sliceIndex: 1 },
    { attempt: 3, purpose: "turn", sliceIndex: undefined },
  ]);
});

test("Compaction slice requests stop at the shared provider-round bound", async () => {
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: (_context, options) => {
      requests += 1;
      expect(options.purpose).toBe("compaction");
      return Stream.fromIterable([
        { _tag: "textDelta" as const, text: "partial" },
        { _tag: "done" as const, stopReason: "done" as const },
      ]);
    },
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: { content: "x".repeat(600), role: "user" },
        }),
      );
      const settled = yield* orchestrator.openTurn(session.id, "Now", undefined, {
        compaction: { retainedTailCount: 0, sliceBudget: 256 },
        contextBudget: 20,
        maxAttempts: 1,
        maxProviderRounds: 2,
      });
      return { branch: yield* journal.readBranch(session.id), settled };
    }).pipe(Effect.provide(testLayer(provider))),
  );

  expect(requests).toBe(2);
  expect(result.settled).toEqual({ stopReason: "error" });
  expect(result.branch.filter((entry) => entry.kind === "compaction")).toHaveLength(0);
  expect(result.branch.at(-1)).toMatchObject({
    payload: {
      diagnostic: {
        attempts: 2,
        detail: "Maximum provider round bound of 2 exceeded.",
        reason: "provider_error",
      },
    },
  });
});

test("unsummarizable overflow yields BudgetExceeded with the options diagnostic", async () => {
  let compactionRequests = 0;
  const provider: ProviderService = {
    streamAssistant: (_context, options) => {
      if (options.purpose === "compaction") {
        compactionRequests += 1;
        return Stream.fromIterable([
          { _tag: "textDelta" as const, text: "brief" },
          { _tag: "done" as const, stopReason: "done" as const },
        ]);
      }
      return Stream.fromIterable([{ _tag: "done" as const, stopReason: "done" as const }]);
    },
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: { content: "Older overflowing Context.", role: "user" },
        }),
      );
      const settled = yield* orchestrator.openTurn(
        session.id,
        "Retained tail is too large",
        undefined,
        {
          compaction: { retainedTailCount: 1, sliceBudget: 256 },
          contextBudget: 12,
        },
      );
      return { branch: yield* journal.readBranch(session.id), settled };
    }).pipe(Effect.provide(testLayer(provider))),
  );

  const compactions = result.branch.filter((entry) => entry.kind === "compaction");
  expect(compactionRequests).toBe(1);
  expect(compactions).toHaveLength(1);
  expect(result.settled).toEqual({ stopReason: "error" });
  expect(result.branch.at(-1)).toMatchObject({
    payload: {
      diagnostic: {
        compactionApplied: compactions[0]?.id,
        detail: "branch to an earlier entry or start a new session",
        reason: "budget_exceeded",
      },
      role: "assistant",
      stopReason: "error",
    },
  });
});

test("retry and compaction-trigger diagnostics surface as structured progress", async () => {
  const observed: Array<Progress> = [];
  let turnAttempts = 0;
  const provider: ProviderService = {
    streamAssistant: (_context, options) => {
      if (options.purpose === "compaction") {
        return Stream.fromIterable([
          { _tag: "textDelta" as const, text: "brief" },
          { _tag: "done" as const, stopReason: "done" as const },
        ]);
      }
      turnAttempts += 1;
      return turnAttempts === 1
        ? Stream.fail(new ProviderError({ message: "Retry.", transient: true }))
        : Stream.fromIterable([{ _tag: "done" as const, stopReason: "done" as const }]);
    },
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: { content: "Older branch content.", role: "user" },
        }),
      );
      const subscription = yield* Effect.fork(
        Stream.runForEach(orchestrator.subscribeProgress(session.id), (item) =>
          Effect.sync(() => observed.push(item)),
        ),
      );
      yield* Effect.yieldNow();
      const settled = yield* orchestrator.openTurn(session.id, "Now", undefined, {
        compaction: { retainedTailCount: 1, sliceBudget: 256 },
        contextBudget: 12,
        maxAttempts: 2,
      });
      yield* Fiber.interrupt(subscription);
      return { branch: yield* journal.readBranch(session.id), settled };
    }).pipe(Effect.provide(testLayer(provider))),
  );

  const compaction = result.branch.find((entry) => entry.kind === "compaction");
  expect(result.settled).toEqual({ stopReason: "done" });
  expect(observed).toContainEqual({ _tag: "compactionStarted", entriesCovered: 2, sliceCount: 1 });
  expect(observed).toContainEqual({
    _tag: "compactionApplied",
    compactionEntryId: compaction?.id,
    entriesCovered: 2,
    sliceCount: 1,
    summaryLength: 5,
  });
  expect(observed).toContainEqual({
    _tag: "providerRetryScheduled",
    attempt: 3,
    delayMs: 100,
  });
});

test("a journal failure settles progress to IDLE, notifies subscribers, and leaves the command typed", async () => {
  const observed: Array<Progress> = [];
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(orchestrator.subscribeProgress(session.id), (item) =>
          Effect.sync(() => observed.push(item)),
        ),
      );
      yield* Effect.yieldNow();
      const error = yield* Effect.flip(orchestrator.openTurn(session.id, "Fail journal"));
      yield* Fiber.interrupt(progress);
      const nextSubscriber = yield* Stream.runHead(orchestrator.subscribeProgress(session.id));
      return { error, nextSubscriber };
    }).pipe(Effect.provide(testLayer(scriptedProvider([]), failSecondBranchRead()))),
  );

  expect(result.error).toMatchObject({
    _tag: "JournalError",
    message: "Injected branch read failure.",
  });
  expect(observed.filter((item) => item._tag === "phaseChanged")).toEqual([
    { _tag: "phaseChanged", phase: "IDLE" },
    { _tag: "phaseChanged", phase: "ASSEMBLING" },
    { _tag: "phaseChanged", phase: "SETTLING" },
    { _tag: "phaseChanged", phase: "IDLE" },
  ]);
  expect(observed).toContainEqual({ _tag: "turnSettled", revision: 5, stopReason: "error" });
  expect(Option.getOrUndefined(result.nextSubscriber)).toEqual({
    _tag: "phaseChanged",
    phase: "IDLE",
  });
});

test("transient ProviderError retries on exponential backoff up to the configured cap", async () => {
  const contexts: Array<ReadonlyArray<{ readonly content: string; readonly role: string }>> = [];
  const observed: Array<Progress> = [];
  let attempts = 0;
  const retryingProvider: ProviderService = {
    streamAssistant: (context) => {
      contexts.push(context);
      attempts += 1;
      if (attempts < 3) {
        return Stream.fromIterable([
          { _tag: "textDelta" as const, text: `Discard ${attempts}.` },
        ]).pipe(
          Stream.concat(Stream.fail(new ProviderError({ message: "Retry.", transient: true }))),
        );
      }
      return Stream.fromIterable([
        { _tag: "textDelta" as const, text: attempts === 3 ? "Final." : "Next." },
        { _tag: "done" as const, stopReason: "done" as const },
      ]);
    },
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(orchestrator.subscribeProgress(session.id), (item) =>
          Effect.sync(() => observed.push(item)),
        ),
      );
      yield* Effect.yieldNow();
      yield* orchestrator.openTurn(session.id, "First", undefined, { maxAttempts: 3 });
      yield* orchestrator.openTurn(session.id, "Second");
      yield* Fiber.interrupt(progress);
      return yield* journal.readBranch(session.id);
    }).pipe(Effect.provide(testLayer(retryingProvider))),
  );

  expect(observed.filter((item) => item._tag === "assistantText")).toEqual([
    { _tag: "assistantText", text: "Final." },
    { _tag: "assistantText", text: "Next." },
  ]);
  expect(observed.filter((item) => item._tag === "providerRetryScheduled")).toEqual([
    { _tag: "providerRetryScheduled", attempt: 2, delayMs: 100 },
    { _tag: "providerRetryScheduled", attempt: 3, delayMs: 200 },
  ]);
  expect(
    result.filter((entry) => entry.kind === "message").map((entry) => entry.payload),
  ).toMatchObject([
    { content: "First", role: "user" },
    { content: "Final.", role: "assistant", stopReason: "done" },
    { content: "Second", role: "user" },
    { content: "Next.", role: "assistant", stopReason: "done" },
  ]);
  expect(contexts.at(-1)).toEqual([
    { content: "First", role: "user" },
    { content: "Final.", role: "assistant" },
    { content: "Second", role: "user" },
  ]);
});

test("abort during ASSEMBLING settles an empty assistant entry before the provider starts", async () => {
  const entered = await Effect.runPromise(Deferred.make<void>());
  const release = await Effect.runPromise(Deferred.make<void>());
  let providerCalls = 0;
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const running = yield* Effect.fork(orchestrator.openTurn(session.id, "Assemble"));
      yield* Deferred.await(entered);
      const aborted = yield* orchestrator.abortTurn(session.id);
      yield* Deferred.succeed(release, undefined);
      return {
        aborted,
        branch: yield* journal.readBranch(session.id),
        settled: yield* Fiber.join(running),
      };
    }).pipe(
      Effect.provide(
        testLayer(
          {
            streamAssistant: () => {
              providerCalls += 1;
              return Stream.empty;
            },
          },
          pauseSecondBranchRead(entered, release),
        ),
      ),
    ),
  );

  expect(providerCalls).toBe(0);
  expect(result.aborted).toEqual({ aborted: true, turnOrdinal: 1 });
  expect(result.settled).toEqual({ stopReason: "aborted" });
  expect(result.branch.at(-1)).toMatchObject({
    payload: { content: "", role: "assistant", stopReason: "aborted" },
  });
});

test("abort after operation_started lands records a finished operation before resume", async () => {
  const entered = await Effect.runPromise(Deferred.make<void>());
  const release = await Effect.runPromise(Deferred.make<void>());
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const running = yield* Effect.fork(
        orchestrator.openTurn(session.id, "Abort at operation start"),
      );
      yield* Deferred.await(entered);
      const aborting = yield* Effect.fork(orchestrator.abortTurn(session.id));
      yield* Effect.yieldNow();
      yield* Deferred.succeed(release, undefined);
      const aborted = yield* Fiber.join(aborting);
      const settled = yield* Fiber.join(running);
      const recordsBeforeResume = yield* journal.readRecords(session.id);
      const resumed = yield* sessions.resume(session.id);
      return { aborted, recordsBeforeResume, resumed, settled };
    }).pipe(
      Effect.provide(
        testLayer(
          scriptedProvider([{ _tag: "done", stopReason: "done" }]),
          pauseAfterOperationStarted(entered, release),
        ),
      ),
    ),
  );

  expect(result.aborted).toEqual({ aborted: true, turnOrdinal: 1 });
  expect(result.settled).toEqual({ stopReason: "aborted" });
  expect(result.recordsBeforeResume.map((record) => record.kind)).toEqual([
    "operation_started",
    "operation_finished",
  ]);
  expect(result.resumed.recovery).toMatchObject({
    actions: [],
    entriesAppended: [],
    operationIdFound: undefined,
  });
});

test("abort mid-stream persists the partial assistant entry with stop reason aborted", async () => {
  const started = await Effect.runPromise(Deferred.make<void>());
  const hangingProvider: ProviderService = {
    streamAssistant: () =>
      Stream.fromEffect(
        Deferred.succeed(started, undefined).pipe(
          Effect.as({ _tag: "textDelta" as const, text: "Partial reply." }),
        ),
      ).pipe(Stream.concat(Stream.never)),
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const running = yield* Effect.fork(orchestrator.openTurn(session.id, "Start"));
      yield* Deferred.await(started);
      const aborted = yield* orchestrator.abortTurn(session.id);
      const settled = yield* Fiber.join(running).pipe(Effect.timeoutOption("100 millis"));
      return { aborted, branch: yield* journal.readBranch(session.id), settled };
    }).pipe(Effect.provide(testLayer(hangingProvider))),
  );

  expect(Option.getOrUndefined(result.settled)).toEqual({ stopReason: "aborted" });
  expect(result.aborted).toEqual({ aborted: true, turnOrdinal: 1 });
  expect(result.branch.at(-1)).toMatchObject({
    kind: "message",
    payload: { content: "Partial reply.", role: "assistant", stopReason: "aborted" },
  });
});

test("abort during a tool batch interrupts execution and persists one result per call before settling", async () => {
  const started = await Effect.runPromise(Deferred.make<void>());
  const finalized = await Effect.runPromise(Ref.make(false));
  const provider: ProviderService = {
    streamAssistant: () =>
      Stream.fromIterable([
        { _tag: "toolCall", argumentsJson: '{"value":"first"}', id: "first-call", name: "wait" },
        { _tag: "toolCall", argumentsJson: '{"value":"second"}', id: "second-call", name: "wait" },
        { _tag: "done", stopReason: "toolCalls" },
      ]),
  };
  const tool: Tool<{ readonly value: string }, Scope.Scope> = {
    description: "Waits until the turn is aborted.",
    execute: () =>
      Effect.addFinalizer(() => Ref.set(finalized, true)).pipe(
        Effect.zipRight(Deferred.succeed(started, undefined)),
        Effect.zipRight(Effect.never),
      ),
    executionMode: "sequential",
    name: "wait",
    parameters: Schema.Struct({ value: Schema.String }),
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const running = yield* Effect.fork(orchestrator.openTurn(session.id, "Run tools"));
      yield* Deferred.await(started);
      const aborted = yield* orchestrator.abortTurn(session.id);
      return {
        aborted,
        branch: yield* journal.readBranch(session.id),
        finalized: yield* Ref.get(finalized),
        settled: yield* Fiber.join(running),
      };
    }).pipe(Effect.provide(testLayer(provider, undefined, ToolRegistryLive([defineTool(tool)])))),
  );

  expect(result.aborted).toEqual({ aborted: true, turnOrdinal: 1 });
  expect(result.finalized).toBe(true);
  expect(result.settled).toEqual({ stopReason: "aborted" });
  expect(result.branch.map((entry) => entry.payload)).toMatchObject([
    {},
    { content: "Run tools", role: "user" },
    {
      role: "assistant",
      stopReason: "toolCalls",
      toolCalls: [
        { argumentsJson: '{"value":"first"}', id: "first-call", name: "wait" },
        { argumentsJson: '{"value":"second"}', id: "second-call", name: "wait" },
      ],
    },
    {
      content: "Tool execution interrupted.",
      isError: true,
      role: "toolResult",
      toolCallId: "first-call",
    },
    {
      content: "Tool execution interrupted.",
      isError: true,
      role: "toolResult",
      toolCallId: "second-call",
    },
    { content: "", role: "assistant", stopReason: "aborted" },
  ]);
});

test("abort preserves completed results and writes exactly one result for every call", async () => {
  const fastObserved = await Effect.runPromise(Deferred.make<void>());
  const waitStarted = await Effect.runPromise(Deferred.make<void>());
  const provider: ProviderService = {
    streamAssistant: () =>
      Stream.fromIterable([
        { _tag: "toolCall", argumentsJson: "{}", id: "fast-call", name: "fast" },
        { _tag: "toolCall", argumentsJson: "{}", id: "wait-call", name: "wait" },
        { _tag: "done", stopReason: "toolCalls" },
      ]),
  };
  const fast: Tool<Readonly<Record<string, never>>> = {
    description: "Completes before abort.",
    execute: () => Effect.succeed({ content: "real result" }),
    name: "fast",
    parameters: Schema.Struct({}),
  };
  const wait: Tool<Readonly<Record<string, never>>> = {
    description: "Waits for abort.",
    execute: () => Deferred.succeed(waitStarted, undefined).pipe(Effect.zipRight(Effect.never)),
    name: "wait",
    parameters: Schema.Struct({}),
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(orchestrator.subscribeProgress(session.id), (item) =>
          item._tag === "toolCompleted" && item.toolCallId === "fast-call"
            ? Deferred.succeed(fastObserved, undefined)
            : Effect.void,
        ),
      );
      const running = yield* Effect.fork(orchestrator.openTurn(session.id, "Run mixed batch"));
      yield* Deferred.await(waitStarted);
      yield* Deferred.await(fastObserved);
      const aborted = yield* orchestrator.abortTurn(session.id);
      const settled = yield* Fiber.join(running);
      yield* Fiber.interrupt(progress);
      return { aborted, branch: yield* journal.readBranch(session.id), settled };
    }).pipe(
      Effect.provide(
        testLayer(provider, undefined, ToolRegistryLive([defineTool(fast), defineTool(wait)])),
      ),
    ),
  );

  const toolResults = result.branch
    .map((entry) => entry.payload)
    .filter((payload) => {
      const candidate = payload as { readonly role?: unknown };
      return candidate.role === "toolResult";
    }) as ReadonlyArray<{
    readonly content: string;
    readonly isError: boolean;
    readonly role: "toolResult";
    readonly toolCallId: string;
    readonly toolName: string;
  }>;
  expect(result.aborted).toEqual({ aborted: true, turnOrdinal: 1 });
  expect(result.settled).toEqual({ stopReason: "aborted" });
  expect(toolResults).toEqual([
    {
      content: "real result",
      isError: false,
      role: "toolResult",
      toolCallId: "fast-call",
      toolName: "fast",
    },
    {
      content: "Tool execution interrupted.",
      isError: true,
      role: "toolResult",
      toolCallId: "wait-call",
      toolName: "wait",
    },
  ]);
  expect(new Set(toolResults.map((result) => result.toolCallId)).size).toBe(2);
  expect(result.branch.at(-1)).toMatchObject({
    payload: { content: "", role: "assistant", stopReason: "aborted" },
  });
});

test("an uninterruptible tool cannot block abort beyond its configured grace", async () => {
  const started = await Effect.runPromise(Deferred.make<void>());
  const provider: ProviderService = {
    streamAssistant: () =>
      Stream.fromIterable([
        { _tag: "toolCall", argumentsJson: "{}", id: "leaked-call", name: "leak" },
        { _tag: "done", stopReason: "toolCalls" },
      ]),
  };
  const leak: Tool<Readonly<Record<string, never>>> = {
    description: "Never reaches an interruptible boundary.",
    execute: () =>
      Deferred.succeed(started, undefined).pipe(
        Effect.zipRight(Effect.never),
        Effect.uninterruptible,
      ),
    name: "leak",
    parameters: Schema.Struct({}),
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const running = yield* Effect.fork(
        orchestrator.openTurn(session.id, "Leak", undefined, { abortGraceMs: 20 }),
      );
      yield* Deferred.await(started);
      const aborted = yield* orchestrator.abortTurn(session.id).pipe(Effect.timeout("500 millis"));
      const settled = yield* Fiber.join(running).pipe(Effect.timeout("500 millis"));
      return { aborted, branch: yield* journal.readBranch(session.id), settled };
    }).pipe(Effect.provide(testLayer(provider, undefined, ToolRegistryLive([defineTool(leak)])))),
  );

  expect(result.aborted).toEqual({ aborted: true, turnOrdinal: 1 });
  expect(result.settled).toEqual({ stopReason: "aborted" });
  expect(result.branch.map((entry) => entry.payload)).toMatchObject([
    {},
    { role: "user" },
    { role: "assistant", stopReason: "toolCalls" },
    {
      content: "Tool execution interrupted.",
      isError: true,
      role: "toolResult",
      toolCallId: "leaked-call",
    },
    { content: "", role: "assistant", stopReason: "aborted" },
  ]);
});

test("turn ordinal counts user turns once across provider tool rounds", async () => {
  const ordinals: Array<number> = [];
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: (_context, options) => {
      ordinals.push(options.turnOrdinal);
      requests += 1;
      return requests === 1
        ? Stream.fromIterable([
            { _tag: "toolCall" as const, argumentsJson: "{}", id: "call", name: "once" },
            { _tag: "done" as const, stopReason: "toolCalls" as const },
          ])
        : Stream.fromIterable([{ _tag: "done" as const, stopReason: "done" as const }]);
    },
  };
  const once: Tool<Readonly<Record<string, never>>> = {
    description: "Runs once.",
    execute: () => Effect.succeed({ content: "done" }),
    name: "once",
    parameters: Schema.Struct({}),
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      yield* orchestrator.openTurn(session.id, "First");
      yield* orchestrator.openTurn(session.id, "Second");
    }).pipe(Effect.provide(testLayer(provider, undefined, ToolRegistryLive([defineTool(once)])))),
  );

  expect(ordinals).toEqual([1, 1, 2]);
});

test("turn capacity options reject invalid values before enqueue", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      expect(() =>
        orchestrator.openTurn(session.id, "Invalid", undefined, { maxProviderRounds: 0 }),
      ).toThrow("Maximum provider rounds must be a positive safe integer.");
      expect(() =>
        orchestrator.openTurn(session.id, "Invalid", undefined, { maxToolRounds: 0 }),
      ).toThrow("Maximum tool rounds must be a positive safe integer.");
      expect(() =>
        orchestrator.openTurn(session.id, "Invalid", undefined, { toolConcurrency: 0 }),
      ).toThrow("Tool concurrency must be a positive safe integer.");
      expect(() =>
        orchestrator.openTurn(session.id, "Invalid", undefined, {
          compaction: { retainedTailCount: -1 },
        }),
      ).toThrow("Compaction retained-tail count must be a non-negative safe integer.");
      expect(() =>
        orchestrator.openTurn(session.id, "Invalid", undefined, { compaction: { sliceBudget: 0 } }),
      ).toThrow("Compaction slice budget must be a safe integer of at least 200.");
    }).pipe(Effect.provide(testLayer(scriptedProvider([])))),
  );
});

test("runTurn threads expectedRevision to the mailbox command", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const error = yield* Effect.flip(
        orchestrator.openTurn(session.id, "Stale", undefined, {
          expectedRevision: session.revision - 1,
        }),
      );
      return { branch: yield* journal.readBranch(session.id), error };
    }).pipe(Effect.provide(testLayer(scriptedProvider([])))),
  );

  expect(result.error).toMatchObject({
    _tag: "StaleRevision",
    actual: 1,
    expected: 0,
  });
  expect(result.branch).toHaveLength(1);
});

test("a prompt in the active-turn registration gap publishes turnQueued", async () => {
  const registrationEntered = await Effect.runPromise(Deferred.make<void>());
  const releaseRegistration = await Effect.runPromise(Deferred.make<void>());
  const turnQueued = await Effect.runPromise(Deferred.make<void>());
  const observed: Array<Progress> = [];
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(orchestrator.subscribeProgress(session.id), (item) =>
          Effect.sync(() => observed.push(item)).pipe(
            Effect.zipRight(
              item._tag === "turnQueued" ? Deferred.succeed(turnQueued, undefined) : Effect.void,
            ),
          ),
        ),
      );
      yield* Effect.yieldNow();
      const first = yield* Effect.fork(orchestrator.openTurn(session.id, "First"));
      yield* Deferred.await(registrationEntered);
      const second = yield* Effect.fork(orchestrator.openTurn(session.id, "Second"));
      yield* Deferred.await(turnQueued);
      yield* Deferred.succeed(releaseRegistration, undefined);
      const results = yield* Effect.all([Fiber.join(first), Fiber.join(second)], {
        concurrency: "unbounded",
      });
      yield* Fiber.interrupt(progress);
      return { branch: yield* journal.readBranch(session.id), results };
    }).pipe(
      Effect.provide(
        testLayer(
          scriptedProvider([{ _tag: "done", stopReason: "done" }]),
          pauseBranchRead(1, registrationEntered, releaseRegistration),
        ),
      ),
    ),
  );

  expect(result.results).toEqual([{ stopReason: "done" }, { stopReason: "done" }]);
  expect(observed).toContainEqual({ _tag: "turnQueued", content: "Second" });
  expect(result.branch.map((entry) => entry.payload)).toMatchObject([
    {},
    { content: "First", role: "user" },
    { role: "assistant", stopReason: "done" },
    { content: "Second", role: "user" },
    { role: "assistant", stopReason: "done" },
  ]);
});

test("steering queue rejects the item beyond capacity with TurnQueueFull", async () => {
  const providerEntered = await Effect.runPromise(Deferred.make<void>());
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const running = yield* Effect.fork(orchestrator.openTurn(session.id, "Initial"));
      yield* Deferred.await(providerEntered);
      yield* Effect.forEach(
        Array.from({ length: TURN_INPUT_QUEUE_CAPACITY }, (_, index) => index),
        (index) => orchestrator.steer(session.id, `Steering ${index}`),
      );
      const error = yield* Effect.flip(orchestrator.steer(session.id, "Overflow"));
      yield* orchestrator.abortTurn(session.id);
      yield* Fiber.join(running);
      return { error, session };
    }).pipe(
      Effect.provide(
        testLayer({
          streamAssistant: () =>
            Stream.fromEffect(
              Deferred.succeed(providerEntered, undefined).pipe(Effect.zipRight(Effect.never)),
            ),
        }),
      ),
    ),
  );

  expect(result.error).toMatchObject({
    _tag: "TurnQueueFull",
    capacity: TURN_INPUT_QUEUE_CAPACITY,
    queue: "steering",
    sessionId: result.session.id,
  });
});

test("follow-up queue rejects the item beyond capacity with TurnQueueFull", async () => {
  const allQueued = await Effect.runPromise(Deferred.make<void>());
  const providerEntered = await Effect.runPromise(Deferred.make<void>());
  let queuedCount = 0;
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: () => {
      requests += 1;
      return requests === 1
        ? Stream.fromEffect(
            Deferred.succeed(providerEntered, undefined).pipe(Effect.zipRight(Effect.never)),
          )
        : Stream.fromIterable([{ _tag: "done", stopReason: "done" }]);
    },
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(orchestrator.subscribeProgress(session.id), (item) =>
          item._tag === "followUpQueued" && ++queuedCount === TURN_INPUT_QUEUE_CAPACITY
            ? Deferred.succeed(allQueued, undefined)
            : Effect.void,
        ),
      );
      const running = yield* Effect.fork(orchestrator.openTurn(session.id, "Initial"));
      yield* Deferred.await(providerEntered);
      const followers = yield* Effect.forEach(
        Array.from({ length: TURN_INPUT_QUEUE_CAPACITY }, (_, index) => index),
        (index) => Effect.fork(orchestrator.openTurn(session.id, `Follow-up ${index}`)),
      );
      yield* Deferred.await(allQueued);
      const error = yield* Effect.flip(orchestrator.openTurn(session.id, "Overflow"));
      yield* orchestrator.abortTurn(session.id);
      yield* Fiber.join(running);
      yield* Effect.forEach(followers, Fiber.join, { concurrency: "unbounded" });
      yield* Fiber.interrupt(progress);
      return { error, session };
    }).pipe(Effect.provide(testLayer(provider))),
  );

  expect(result.error).toMatchObject({
    _tag: "TurnQueueFull",
    capacity: TURN_INPUT_QUEUE_CAPACITY,
    queue: "followUp",
    sessionId: result.session.id,
  });
});

test("abort after assistant settlement begins prevents any settlement loop", async () => {
  const entered = await Effect.runPromise(Deferred.make<void>());
  const release = await Effect.runPromise(Deferred.make<void>());
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const running = yield* Effect.fork(orchestrator.openTurn(session.id, "Settle"));
      yield* Deferred.await(entered);
      const aborted = yield* orchestrator.abortTurn(session.id);
      yield* Deferred.succeed(release, undefined);
      return { aborted, settled: yield* Fiber.join(running) };
    }).pipe(
      Effect.provide(
        testLayer(
          scriptedProvider([
            { _tag: "textDelta", text: "Complete." },
            { _tag: "done", stopReason: "done" },
          ]),
          pauseAssistantAppend(entered, release),
        ),
      ),
    ),
  );

  expect(result.aborted).toEqual({ aborted: true, note: "loop-prevented", turnOrdinal: 1 });
  expect(result.settled).toEqual({ stopReason: "done" });
});

test("kernel.turn records the accumulated steering drain count once at settlement", async () => {
  const firstEntered = await Effect.runPromise(Deferred.make<void>());
  const releaseFirst = await Effect.runPromise(Deferred.make<void>());
  const secondEntered = await Effect.runPromise(Deferred.make<void>());
  const releaseSecond = await Effect.runPromise(Deferred.make<void>());
  const spans: Array<CapturedSpan> = [];
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: () => {
      requests += 1;
      if (requests === 3) {
        return Stream.fromIterable([{ _tag: "done", stopReason: "done" }]);
      }
      const entered = requests === 1 ? firstEntered : secondEntered;
      const release = requests === 1 ? releaseFirst : releaseSecond;
      return Stream.fromEffect(
        Deferred.succeed(entered, undefined).pipe(
          Effect.zipRight(Deferred.await(release)),
          Effect.as({ _tag: "done" as const, stopReason: "done" as const }),
        ),
      );
    },
  };

  await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const running = yield* Effect.fork(orchestrator.openTurn(session.id, "Initial"));
      yield* Deferred.await(firstEntered);
      yield* orchestrator.steer(session.id, "First steering");
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Deferred.await(secondEntered);
      yield* orchestrator.steer(session.id, "Second steering");
      yield* Deferred.succeed(releaseSecond, undefined);
      yield* Fiber.join(running);
    }).pipe(Effect.provide(testLayer(provider).pipe(Layer.provide(tracerLayer(spans))))),
  );

  const turnSpan = spans.find((span) => span.name === "kernel.turn");
  expect(turnSpan?.attributes.get("steeringDrainedCount")).toBe(2);
});

test("follow-up drain count is recorded on kernel.turn instead of kernel.command", async () => {
  const followUpQueued = await Effect.runPromise(Deferred.make<void>());
  const providerEntered = await Effect.runPromise(Deferred.make<void>());
  const releaseProvider = await Effect.runPromise(Deferred.make<void>());
  const spans: Array<CapturedSpan> = [];
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: () => {
      requests += 1;
      return requests === 1
        ? Stream.fromEffect(
            Deferred.succeed(providerEntered, undefined).pipe(
              Effect.zipRight(Deferred.await(releaseProvider)),
              Effect.as({ _tag: "done" as const, stopReason: "done" as const }),
            ),
          )
        : Stream.fromIterable([{ _tag: "done", stopReason: "done" }]);
    },
  };

  await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(orchestrator.subscribeProgress(session.id), (item) =>
          item._tag === "followUpQueued"
            ? Deferred.succeed(followUpQueued, undefined)
            : Effect.void,
        ),
      );
      const initial = yield* Effect.fork(orchestrator.openTurn(session.id, "Initial"));
      yield* Deferred.await(providerEntered);
      const followUp = yield* Effect.fork(orchestrator.openTurn(session.id, "Follow-up"));
      yield* Deferred.await(followUpQueued);
      yield* Deferred.succeed(releaseProvider, undefined);
      yield* Fiber.join(initial);
      yield* Fiber.join(followUp);
      yield* Fiber.interrupt(progress);
    }).pipe(Effect.provide(testLayer(provider).pipe(Layer.provide(tracerLayer(spans))))),
  );

  const turnSpans = spans.filter((span) => span.name === "kernel.turn");
  const commandSpans = spans.filter((span) => span.name === "kernel.command");
  expect(turnSpans).toHaveLength(2);
  expect(turnSpans[1]?.attributes.get("followUpDrainedCount")).toBe(1);
  expect(commandSpans.every((span) => !span.attributes.has("followUpDrainedCount"))).toBe(true);
});

test("turn spans carry session id, turn ordinal, appended entry ids, and stop reason", async () => {
  const spans: Array<{
    readonly attributes: Map<string, unknown>;
    exit: Exit.Exit<unknown, unknown> | undefined;
    readonly name: string;
  }> = [];
  const tracer = Tracer.make({
    context: (evaluate) => evaluate(),
    span: (name, parent, context, links, startTime, kind, options) => {
      const captured = {
        attributes: new Map(Object.entries(options?.attributes ?? {})),
        exit: undefined as Exit.Exit<unknown, unknown> | undefined,
        name,
      };
      spans.push(captured);
      return {
        _tag: "Span",
        addLinks: () => undefined,
        attribute: (key, value) => captured.attributes.set(key, value),
        attributes: captured.attributes,
        context,
        end: (_endTime, exit) => {
          captured.exit = exit;
        },
        event: () => undefined,
        kind,
        links,
        name,
        parent,
        sampled: true,
        spanId: `${spans.length}`,
        status: { _tag: "Started", startTime },
        traceId: "captured",
      } satisfies Tracer.Span;
    },
  });
  const traceLayer = Layer.merge(Layer.setTracer(tracer), Layer.setTracerEnabled(true));
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      yield* orchestrator.openTurn(session.id, "First");
      yield* orchestrator.openTurn(session.id, "Second");
      return { branch: yield* journal.readBranch(session.id), session };
    }).pipe(
      Effect.provide(
        testLayer(
          scriptedProvider([
            { _tag: "textDelta", text: "Answer" },
            { _tag: "done", stopReason: "done" },
          ]),
        ).pipe(Layer.provide(traceLayer)),
      ),
    ),
  );

  const turns = spans.filter((span) => span.name === "kernel.turn");
  expect(turns).toHaveLength(2);
  for (const [index, span] of turns.entries()) {
    const user = result.branch[index * 2 + 1];
    const assistant = result.branch[index * 2 + 2];
    expect(span.attributes.get("assistantEntryId")).toBe(assistant?.id);
    expect(span.attributes.get("sessionId")).toBe(result.session.id);
    expect(span.attributes.get("stopReason")).toBe("done");
    expect(span.attributes.get("turnOrdinal")).toBe(index + 1);
    expect(span.attributes.get("userEntryId")).toBe(user?.id);
    expect(span.exit === undefined ? false : Exit.isSuccess(span.exit)).toBe(true);
  }
});

test("error and abort turn spans end with failure", async () => {
  const spans: Array<{
    exit: Exit.Exit<unknown, unknown> | undefined;
    readonly name: string;
  }> = [];
  const abortStarted = await Effect.runPromise(Deferred.make<void>());
  const tracer = Tracer.make({
    context: (evaluate) => evaluate(),
    span: (name, parent, context, links, startTime, kind) => {
      const captured = { exit: undefined as Exit.Exit<unknown, unknown> | undefined, name };
      spans.push(captured);
      return {
        _tag: "Span",
        addLinks: () => undefined,
        attribute: () => undefined,
        attributes: new Map(),
        context,
        end: (_endTime, exit) => {
          captured.exit = exit;
        },
        event: () => undefined,
        kind,
        links,
        name,
        parent,
        sampled: true,
        spanId: `${spans.length}`,
        status: { _tag: "Started", startTime },
        traceId: "captured",
      } satisfies Tracer.Span;
    },
  });
  const traceLayer = Layer.merge(Layer.setTracer(tracer), Layer.setTracerEnabled(true));
  await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const failed = yield* sessions.create();
      const aborted = yield* sessions.create();
      yield* orchestrator.openTurn(failed.id, "fail");
      const running = yield* Effect.fork(orchestrator.openTurn(aborted.id, "abort"));
      yield* Deferred.await(abortStarted);
      yield* orchestrator.abortTurn(aborted.id);
      yield* Fiber.join(running);
    }).pipe(
      Effect.provide(
        testLayer({
          streamAssistant: (context) =>
            context.at(-1)?.content === "fail"
              ? Stream.fail(new ProviderError({ message: "Failed.", transient: false }))
              : Stream.fromEffect(
                  Deferred.succeed(abortStarted, undefined).pipe(
                    Effect.as({ _tag: "textDelta" as const, text: "Partial." }),
                  ),
                ).pipe(Stream.concat(Stream.never)),
        }).pipe(Layer.provide(traceLayer)),
      ),
    ),
  );

  const turns = spans.filter((span) => span.name === "kernel.turn");
  expect(turns).toHaveLength(2);
  expect(turns.every((span) => span.exit !== undefined && Exit.isFailure(span.exit))).toBe(true);
});

test("every terminal path leaves a well-formed entry sequence in a fixture replay", async () => {
  const abortStarted = await Effect.runPromise(Deferred.make<void>());
  const fixtureProvider: ProviderService = {
    streamAssistant: (context) => {
      const content = context.at(-1)?.content;
      if (content === "fail") {
        return Stream.fail(new ProviderError({ message: "Failed.", transient: false }));
      }
      if (content === "abort") {
        return Stream.fromEffect(
          Deferred.succeed(abortStarted, undefined).pipe(
            Effect.as({ _tag: "textDelta" as const, text: "Partial." }),
          ),
        ).pipe(Stream.concat(Stream.never));
      }
      return Stream.fromIterable([
        { _tag: "textDelta" as const, text: "Complete." },
        { _tag: "done" as const, stopReason: "done" as const },
      ]);
    },
  };
  const branches = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const done = yield* sessions.create();
      const failed = yield* sessions.create();
      const aborted = yield* sessions.create();
      yield* orchestrator.openTurn(done.id, "done");
      yield* orchestrator.openTurn(failed.id, "fail");
      const running = yield* Effect.fork(orchestrator.openTurn(aborted.id, "abort"));
      yield* Deferred.await(abortStarted);
      yield* orchestrator.abortTurn(aborted.id);
      yield* Fiber.join(running);
      return yield* Effect.all([
        journal.readBranch(done.id),
        journal.readBranch(failed.id),
        journal.readBranch(aborted.id),
      ]);
    }).pipe(Effect.provide(testLayer(fixtureProvider))),
  );

  for (const [branch, stopReason] of [
    [branches[0], "done"],
    [branches[1], "error"],
    [branches[2], "aborted"],
  ] as const) {
    expect(branch).toHaveLength(3);
    expect(branch?.[1]?.parentId).toBe(branch?.[0]?.id);
    expect(branch?.[2]?.parentId).toBe(branch?.[1]?.id);
    expect(branch?.[1]).toMatchObject({ kind: "message", payload: { role: "user" } });
    expect(branch?.[2]).toMatchObject({
      kind: "message",
      payload: { role: "assistant", stopReason },
    });
  }
});

test("abort between provider retry attempts aborts with one provider start and leaves Session usable", async () => {
  const retryScheduled = await Effect.runPromise(Deferred.make<void>());
  const observed: Array<Progress> = [];
  let providerStarts = 0;
  const transientProvider: ProviderService = {
    streamAssistant: () => {
      providerStarts += 1;
      if (providerStarts === 1) {
        return Stream.fail(new ProviderError({ message: "Transient blip.", transient: true }));
      }
      return Stream.fromIterable([
        { _tag: "textDelta" as const, text: "Should not reach." },
        { _tag: "done" as const, stopReason: "done" as const },
      ]);
    },
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const progressFiber = yield* Effect.fork(
        Stream.runForEach(orchestrator.subscribeProgress(session.id), (item) =>
          Effect.gen(function* () {
            observed.push(item);
            if (item._tag === "providerRetryScheduled" && item.attempt === 2) {
              yield* Deferred.succeed(retryScheduled, undefined);
            }
          }),
        ),
      );
      yield* Effect.yieldNow();
      const running = yield* Effect.fork(
        orchestrator.openTurn(session.id, "Transient then abort", undefined, {
          maxAttempts: 3,
          retryBaseDelayMs: 5000,
        }),
      );
      yield* Deferred.await(retryScheduled).pipe(Effect.timeout("2 seconds"), Effect.orDie);
      expect(providerStarts).toStrictEqual(1);
      const aborted = yield* orchestrator.abortTurn(session.id);
      const settled = yield* Fiber.join(running);
      yield* Fiber.interrupt(progressFiber);
      const providerStartsAtAbort = providerStarts;
      const secondSettled = yield* orchestrator.openTurn(session.id, "Follow-up usable");
      const branch = yield* journal.readBranch(session.id);
      return {
        aborted,
        branch,
        providerStarts: providerStartsAtAbort,
        providerStartsTotal: providerStarts,
        secondSettled,
        settled,
      };
    }).pipe(Effect.provide(testLayer(transientProvider))),
  );

  expect(providerStarts).toStrictEqual(2);
  expect(result.providerStarts).toStrictEqual(1);
  expect(result.providerStartsTotal).toStrictEqual(2);
  expect(result.aborted).toStrictEqual({ aborted: true, turnOrdinal: 1 });
  expect(result.settled).toStrictEqual({ stopReason: "aborted" });
  expect(result.branch.at(-2)?.payload).toMatchObject({
    content: "Follow-up usable",
    role: "user",
  });
  expect(result.secondSettled).toStrictEqual({ stopReason: "done" });
  const abortedEntry = result.branch[2];
  expect(abortedEntry).toBeDefined();
  expect(abortedEntry?.payload).toMatchObject({ role: "assistant", stopReason: "aborted" });
  expect(
    abortedEntry === undefined
      ? undefined
      : (abortedEntry.payload as { readonly content?: unknown }).content,
  ).toStrictEqual("");
  const retries = observed.filter((item) => item._tag === "providerRetryScheduled");
  expect(retries).toStrictEqual([{ _tag: "providerRetryScheduled", attempt: 2, delayMs: 5000 }]);
  expect(observed.filter((item) => item._tag === "assistantText")).toStrictEqual([]);
});
