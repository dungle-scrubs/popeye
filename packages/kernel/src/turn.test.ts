import { createMemoryJournalBacking, Journal, JournalMemory } from "@peye/journal";
import { Deferred, Effect, Fiber, Layer, Option, Stream, Tracer } from "effect";
import { expect, test } from "vitest";
import { ProviderError } from "./errors.js";
import { MailboxLive } from "./mailbox.js";
import type { Progress } from "./progress.js";
import { type AssistantItem, Provider, type ProviderService } from "./provider.js";
import { Sessions, SessionsLive } from "./sessions.js";
import { Turns, TurnsLive } from "./turn.js";

const providerLayer = (service: ProviderService): Layer.Layer<Provider> =>
  Layer.succeed(Provider, service);

const testLayer = (service: ProviderService) => {
  const journalLayer = JournalMemory(createMemoryJournalBacking());
  const mailboxLayer = MailboxLive().pipe(Layer.provide(journalLayer));
  const sessionsLayer = SessionsLive.pipe(Layer.provide(Layer.merge(journalLayer, mailboxLayer)));
  const dependencies = Layer.mergeAll(journalLayer, mailboxLayer, providerLayer(service));
  return Layer.mergeAll(dependencies, sessionsLayer, TurnsLive().pipe(Layer.provide(dependencies)));
};

const scriptedProvider = (items: ReadonlyArray<AssistantItem>): ProviderService => ({
  streamAssistant: () => Stream.fromIterable(items),
});

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

test("assistant text and thinking deltas stream as structured progress during STREAMING", async () => {
  const observed: Array<Progress> = [];
  await Effect.runPromise(
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
      yield* turns.runTurn(session.id, "Explain this");
      yield* Fiber.interrupt(progress);
    }).pipe(
      Effect.provide(
        testLayer(
          scriptedProvider([
            { _tag: "thinkingDelta", text: "Considering context." },
            { _tag: "textDelta", text: "It works." },
            { _tag: "done", stopReason: "done" },
          ]),
        ),
      ),
    ),
  );

  expect(observed).toContainEqual({ _tag: "assistantThinking", text: "Considering context." });
  expect(observed).toContainEqual({ _tag: "assistantText", text: "It works." });
});

test("provider failure after retries exhaust persists an error assistant entry and settles", async () => {
  let attempts = 0;
  const failingProvider: ProviderService = {
    streamAssistant: () => {
      attempts += 1;
      return Stream.fail(
        new ProviderError({ message: "Temporary Provider failure.", transient: true }),
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
    payload: { role: "assistant", stopReason: "error" },
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
      yield* turns.abortTurn(session.id);
      const settled = yield* Fiber.join(running).pipe(Effect.timeoutOption("100 millis"));
      return { branch: yield* journal.readBranch(session.id), settled };
    }).pipe(Effect.provide(testLayer(hangingProvider))),
  );

  expect(Option.getOrUndefined(result.settled)).toEqual({ stopReason: "aborted" });
  expect(result.branch.at(-1)).toMatchObject({
    kind: "message",
    payload: { content: "Partial reply.", role: "assistant", stopReason: "aborted" },
  });
});

test("turn spans carry session id, turn ordinal, appended entry ids, and stop reason", async () => {
  const spans: Array<{
    readonly attributes: Map<string, unknown>;
    readonly name: string;
  }> = [];
  const tracer = Tracer.make({
    context: (evaluate) => evaluate(),
    span: (name, parent, context, links, startTime, kind, options) => {
      const captured = {
        attributes: new Map(Object.entries(options?.attributes ?? {})),
        name,
      };
      spans.push(captured);
      return {
        _tag: "Span",
        addLinks: () => undefined,
        attribute: (key, value) => captured.attributes.set(key, value),
        attributes: captured.attributes,
        context,
        end: () => undefined,
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
  }
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
