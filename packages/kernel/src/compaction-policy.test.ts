import {
  createMemoryJournalBacking,
  EntryDraftSchema,
  Journal,
  JournalDraftRejected,
  type JournalError,
  JournalMemory,
  type JournalService,
} from "@pop-eye/journal";
import { Effect, type Exit, Fiber, Layer, Option, Stream, Tracer } from "effect";
import { expect, test } from "vitest";

import {
  Compaction,
  CompactionLive,
  type CompactionPolicyOptions,
  DEFAULT_COMPACTION_POLICY,
  resolveCompactionPolicyOptions,
} from "./compaction-policy.js";
import { Mailbox, MailboxLive } from "./mailbox.js";
import { type Progress, ProgressHub, ProgressHubLive } from "./progress.js";
import { Provider, type ProviderService } from "./provider.js";

const testLayer = (
  provider: ProviderService,
  options: CompactionPolicyOptions = {},
  journalLayer: Layer.Layer<Journal, JournalError> = JournalMemory(createMemoryJournalBacking()),
) => {
  const mailboxLayer = MailboxLive().pipe(Layer.provide(journalLayer));
  const dependencies = Layer.mergeAll(
    journalLayer,
    mailboxLayer,
    ProgressHubLive(),
    Layer.succeed(Provider, provider),
  );
  return Layer.merge(dependencies, CompactionLive(options).pipe(Layer.provide(dependencies)));
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

test("manual Compaction compactNow runs through the mailbox with span diagnostics", async () => {
  const observed: Array<Progress> = [];
  const spans: Array<CapturedSpan> = [];
  const provider: ProviderService = {
    streamAssistant: () =>
      Stream.fromIterable([
        { _tag: "textDelta" as const, text: "manual summary" },
        { _tag: "done" as const, stopReason: "done" as const },
      ]),
  };
  const journalLayer = JournalMemory(createMemoryJournalBacking());
  const mailboxLayer = MailboxLive().pipe(Layer.provide(journalLayer));
  const dependencies = Layer.mergeAll(
    journalLayer,
    mailboxLayer,
    ProgressHubLive(),
    Layer.succeed(Provider, provider),
  );
  const layer = Layer.mergeAll(
    dependencies,
    CompactionLive({ retainedTailCount: 0, sliceBudget: 256 }).pipe(Layer.provide(dependencies)),
  );

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const compaction = yield* Compaction;
      const journal = yield* Journal;
      const mailbox = yield* Mailbox;
      const progress = yield* ProgressHub;
      const session = yield* journal.createSession();
      yield* mailbox.activate(session.id);
      const subscription = yield* Effect.fork(
        Stream.runForEach(progress.subscribe(session.id), (item) =>
          Effect.sync(() => observed.push(item)),
        ),
      );
      yield* Effect.yieldNow();
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: { content: "Manual Context.", role: "user" },
        }),
      );
      const compacted = yield* compaction.compactNow(session.id);
      yield* Fiber.interrupt(subscription);
      return { branch: yield* journal.readBranch(session.id), compacted };
    }).pipe(Effect.provide(layer), Effect.provide(tracerLayer(spans))),
  );

  expect(result.branch.filter((entry) => entry.kind === "compaction")).toHaveLength(1);
  const commandSpan = spans.find(
    (span) => span.name === "kernel.command" && span.attributes.get("command") === "compact",
  );
  expect(commandSpan).toBeDefined();
  const compactionSpan = spans.find((span) => span.name === "kernel.compaction");
  expect(compactionSpan?.attributes.get("entriesCovered")).toBe(1);
  expect(compactionSpan?.attributes.get("sessionId")).toEqual(expect.any(String));
  expect(compactionSpan?.attributes.get("sliceCount")).toBe(1);
  expect(compactionSpan?.attributes.get("summaryLength")).toBe(14);
  expect(result.compacted).toMatchObject({
    entriesCovered: 1,
    sliceCount: 1,
    summaryLength: 14,
  });
  expect(observed.filter((item) => item._tag === "phaseChanged")).toEqual([
    { _tag: "phaseChanged", phase: "IDLE" },
  ]);
  expect(observed.map((item) => item._tag)).toContain("compactionStarted");
  expect(observed.map((item) => item._tag)).toContain("compactionApplied");
});

test("Compaction policy exposes a configurable survival instruction and a fixed budget floor", () => {
  expect(DEFAULT_COMPACTION_POLICY.summarizationInstruction).toContain("decisions");
  expect(DEFAULT_COMPACTION_POLICY.summarizationInstruction).toContain("open tool state");
  expect(DEFAULT_COMPACTION_POLICY.summarizationInstruction).toContain("file paths");
  expect(DEFAULT_COMPACTION_POLICY.summarizationInstruction).toContain("user intent");
  expect(
    resolveCompactionPolicyOptions({}, { summarizationInstruction: "Preserve marker values." })
      .summarizationInstruction,
  ).toBe("Preserve marker values.");
  expect(() => resolveCompactionPolicyOptions({}, { sliceBudget: 199 })).toThrow(
    "Compaction slice budget must be a safe integer of at least 200.",
  );
});

test("compactNow fails typed when the branch has nothing to compact", async () => {
  const provider: ProviderService = { streamAssistant: () => Stream.empty };
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const compaction = yield* Compaction;
      const journal = yield* Journal;
      const mailbox = yield* Mailbox;
      const session = yield* journal.createSession();
      yield* mailbox.activate(session.id);
      return yield* Effect.flip(compaction.compactNow(session.id));
    }).pipe(Effect.provide(testLayer(provider))),
  );

  expect(error).toMatchObject({
    _tag: "NothingToCompact",
    message: "Compaction requires at least one unsummarized Entry.",
  });
});

test("compactNow fails typed when Compaction policy is disabled", async () => {
  let requests = 0;
  const provider: ProviderService = {
    streamAssistant: () => {
      requests += 1;
      return Stream.empty;
    },
  };
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const compaction = yield* Compaction;
      const journal = yield* Journal;
      const mailbox = yield* Mailbox;
      const session = yield* journal.createSession();
      yield* mailbox.activate(session.id);
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({ kind: "message", payload: { content: "Keep", role: "user" } }),
      );
      return yield* Effect.flip(compaction.compactNow(session.id));
    }).pipe(Effect.provide(testLayer(provider, { enabled: false }))),
  );

  expect(error).toMatchObject({
    _tag: "CompactionDisabled",
    message: "Compaction is disabled by policy.",
  });
  expect(requests).toBe(0);
});

test("compactNow surfaces a D-028 Journal rejection without remapping it", async () => {
  const base = JournalMemory(createMemoryJournalBacking());
  const rejectingJournal = Layer.effect(
    Journal,
    Effect.gen(function* () {
      const journal = yield* Journal;
      return {
        ...journal,
        appendCompaction: () =>
          Effect.fail(
            new JournalDraftRejected({
              kind: "compaction",
              message: "Injected D-028 rejection.",
              reason: "invalid_payload",
            }),
          ),
      } satisfies JournalService;
    }),
  ).pipe(Layer.provide(base));
  const provider: ProviderService = {
    streamAssistant: () =>
      Stream.fromIterable([
        { _tag: "textDelta" as const, text: "summary" },
        { _tag: "done" as const, stopReason: "done" as const },
      ]),
  };
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const compaction = yield* Compaction;
      const journal = yield* Journal;
      const mailbox = yield* Mailbox;
      const session = yield* journal.createSession();
      yield* mailbox.activate(session.id);
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({ kind: "message", payload: { content: "Keep", role: "user" } }),
      );
      return yield* Effect.flip(compaction.compactNow(session.id));
    }).pipe(Effect.provide(testLayer(provider, {}, rejectingJournal))),
  );

  expect(error).toMatchObject({
    _tag: "JournalDraftRejected",
    message: "Injected D-028 rejection.",
  });
});

test("compactNow is serialized behind an active mailbox command", async () => {
  const provider: ProviderService = {
    streamAssistant: () =>
      Stream.fromIterable([
        { _tag: "textDelta" as const, text: "summary" },
        { _tag: "done" as const, stopReason: "done" as const },
      ]),
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const compaction = yield* Compaction;
      const journal = yield* Journal;
      const mailbox = yield* Mailbox;
      const session = yield* journal.createSession();
      yield* mailbox.activate(session.id);
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({ kind: "message", payload: { content: "Keep", role: "user" } }),
      );
      const entered = yield* Effect.makeSemaphore(0);
      const release = yield* Effect.makeSemaphore(0);
      const blocker = yield* Effect.fork(
        mailbox.enqueue(session.id, {
          name: "blocker",
          run: () => entered.release(1).pipe(Effect.zipRight(release.take(1))),
        }),
      );
      yield* entered.take(1);
      const compacting = yield* Effect.fork(compaction.compactNow(session.id));
      yield* Effect.yieldNow();
      const whileBlocked = yield* Fiber.poll(compacting);
      yield* release.release(1);
      yield* Fiber.join(blocker);
      const compacted = yield* Fiber.join(compacting);
      return { compacted, whileBlocked };
    }).pipe(Effect.provide(testLayer(provider))),
  );

  expect(Option.isNone(result.whileBlocked)).toBe(true);
  expect(result.compacted.entriesCovered).toBe(1);
});
