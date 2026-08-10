import {
  createMemoryJournalBacking,
  type EntryDraft,
  Journal,
  JournalError,
  JournalMemory,
} from "@peye/journal";
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
import { ProviderError } from "./errors.js";
import { MailboxLive } from "./mailbox.js";
import { type Progress, ProgressHubLive } from "./progress.js";
import { type AssistantItem, Provider, type ProviderService } from "./provider.js";
import { Sessions, SessionsLive } from "./sessions.js";
import { type Tool, ToolRegistryLive } from "./tool.js";
import { Turns, TurnsLive } from "./turn.js";

const providerLayer = (service: ProviderService): Layer.Layer<Provider> =>
  Layer.succeed(Provider, service);

const testLayer = (
  service: ProviderService,
  journalLayer = JournalMemory(createMemoryJournalBacking()),
  toolLayer = ToolRegistryLive([]),
) => {
  const mailboxLayer = MailboxLive().pipe(Layer.provide(journalLayer));
  const sessionsLayer = SessionsLive.pipe(Layer.provide(Layer.merge(journalLayer, mailboxLayer)));
  const dependencies = Layer.mergeAll(
    journalLayer,
    mailboxLayer,
    ProgressHubLive(),
    providerLayer(service),
    toolLayer,
  );
  return Layer.mergeAll(dependencies, sessionsLayer, TurnsLive().pipe(Layer.provide(dependencies)));
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

const pauseSecondBranchRead = (
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
              count === 2
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

test("tool-free turn walks IDLE through SETTLING to IDLE and persists final stop reason done", async () => {
  const observed: Array<Progress> = [];
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const turns = yield* Turns;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(turns.subscribeProgress(session.id), (item) =>
          Effect.sync(() => observed.push(item)),
        ),
      );
      yield* Effect.yieldNow();

      yield* turns.runTurn(session.id, "Hello");

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

test("assistant text and thinking deltas stream only during STREAMING and persist their concatenation", async () => {
  const observed: Array<Progress> = [];
  const branch = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const turns = yield* Turns;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(turns.subscribeProgress(session.id), (item) =>
          Effect.sync(() => observed.push(item)),
        ),
      );
      yield* Effect.yieldNow();
      yield* turns.runTurn(session.id, "Explain this");
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

test("tool calls append results in call order while completion order appears only in progress", async () => {
  const fastCompleted = await Effect.runPromise(Deferred.make<void>());
  const observed: Array<Progress> = [];
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: () => {
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
      const turns = yield* Turns;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(turns.subscribeProgress(session.id), (item) =>
          Effect.sync(() => observed.push(item)),
        ),
      );
      yield* Effect.yieldNow();
      const settled = yield* turns.runTurn(session.id, "Use the tools");
      yield* Fiber.interrupt(progress);
      return { branch: yield* journal.readBranch(session.id), settled };
    }).pipe(Effect.provide(testLayer(provider, undefined, ToolRegistryLive([slow, fast])))),
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
});

test("provider failure after retries exhaust persists an error assistant entry and settles", async () => {
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
      const turns = yield* Turns;
      const session = yield* sessions.create();
      const settled = yield* turns.runTurn(session.id, "Try again", { maxAttempts: 3 });
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
      const turns = yield* Turns;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(turns.subscribeProgress(session.id), (item) =>
          Effect.sync(() => observed.push(item)),
        ),
      );
      yield* Effect.yieldNow();
      const settled = yield* turns.runTurn(session.id, "Too large", { contextBudget: 0 });
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
  expect(observed.at(-2)).toEqual({ _tag: "turnSettled", revision: 3, stopReason: "error" });
  expect(observed.at(-1)).toEqual({ _tag: "phaseChanged", phase: "IDLE" });
});

test("a journal failure settles progress to IDLE, notifies subscribers, and leaves the command typed", async () => {
  const observed: Array<Progress> = [];
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const turns = yield* Turns;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(turns.subscribeProgress(session.id), (item) =>
          Effect.sync(() => observed.push(item)),
        ),
      );
      yield* Effect.yieldNow();
      const error = yield* Effect.flip(turns.runTurn(session.id, "Fail journal"));
      yield* Fiber.interrupt(progress);
      const nextSubscriber = yield* Stream.runHead(turns.subscribeProgress(session.id));
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
  expect(observed).toContainEqual({ _tag: "turnSettled", revision: 3, stopReason: "error" });
  expect(Option.getOrUndefined(result.nextSubscriber)).toEqual({
    _tag: "phaseChanged",
    phase: "IDLE",
  });
});

test("transient retries retain only the successful attempt in progress, durable output, and later context", async () => {
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
      const turns = yield* Turns;
      const session = yield* sessions.create();
      const progress = yield* Effect.fork(
        Stream.runForEach(turns.subscribeProgress(session.id), (item) =>
          Effect.sync(() => observed.push(item)),
        ),
      );
      yield* Effect.yieldNow();
      yield* turns.runTurn(session.id, "First");
      yield* turns.runTurn(session.id, "Second");
      yield* Fiber.interrupt(progress);
      return yield* journal.readBranch(session.id);
    }).pipe(Effect.provide(testLayer(retryingProvider))),
  );

  expect(observed.filter((item) => item._tag === "assistantText")).toEqual([
    { _tag: "assistantText", text: "Final." },
    { _tag: "assistantText", text: "Next." },
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
      const turns = yield* Turns;
      const session = yield* sessions.create();
      const running = yield* Effect.fork(turns.runTurn(session.id, "Assemble"));
      yield* Deferred.await(entered);
      const aborted = yield* turns.abortTurn(session.id);
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
      const turns = yield* Turns;
      const session = yield* sessions.create();
      const running = yield* Effect.fork(turns.runTurn(session.id, "Start"));
      yield* Deferred.await(started);
      const aborted = yield* turns.abortTurn(session.id);
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
      const turns = yield* Turns;
      const session = yield* sessions.create();
      const running = yield* Effect.fork(turns.runTurn(session.id, "Run tools"));
      yield* Deferred.await(started);
      const aborted = yield* turns.abortTurn(session.id);
      return {
        aborted,
        branch: yield* journal.readBranch(session.id),
        finalized: yield* Ref.get(finalized),
        settled: yield* Fiber.join(running),
      };
    }).pipe(Effect.provide(testLayer(provider, undefined, ToolRegistryLive([tool])))),
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
  ]);
});

test("abort after assistant settlement begins leaves the active turn untouched", async () => {
  const entered = await Effect.runPromise(Deferred.make<void>());
  const release = await Effect.runPromise(Deferred.make<void>());
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const turns = yield* Turns;
      const session = yield* sessions.create();
      const running = yield* Effect.fork(turns.runTurn(session.id, "Settle"));
      yield* Deferred.await(entered);
      const aborted = yield* turns.abortTurn(session.id);
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

  expect(result.aborted).toEqual({ aborted: false, reason: "settling", turnOrdinal: 1 });
  expect(result.settled).toEqual({ stopReason: "done" });
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
      const turns = yield* Turns;
      const session = yield* sessions.create();
      yield* turns.runTurn(session.id, "First");
      yield* turns.runTurn(session.id, "Second");
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
      const turns = yield* Turns;
      const failed = yield* sessions.create();
      const aborted = yield* sessions.create();
      yield* turns.runTurn(failed.id, "fail");
      const running = yield* Effect.fork(turns.runTurn(aborted.id, "abort"));
      yield* Deferred.await(abortStarted);
      yield* turns.abortTurn(aborted.id);
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
      const turns = yield* Turns;
      const done = yield* sessions.create();
      const failed = yield* sessions.create();
      const aborted = yield* sessions.create();
      yield* turns.runTurn(done.id, "done");
      yield* turns.runTurn(failed.id, "fail");
      const running = yield* Effect.fork(turns.runTurn(aborted.id, "abort"));
      yield* Deferred.await(abortStarted);
      yield* turns.abortTurn(aborted.id);
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
