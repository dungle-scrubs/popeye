import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JournalError } from "@peye/journal";
import {
  type ContextBudgetExceeded,
  createMemoryJournalBacking,
  EntryDraftSchema,
  foldContext,
  Journal,
  JournalJsonl,
  JournalMemory,
  type SessionId,
} from "@peye/journal";
import { Chunk, Deferred, Effect, Fiber, Layer, Ref, Schema, Stream } from "effect";
import { expect, test } from "vitest";

import { entryToContextItem } from "./compaction-policy.js";
import { Driver, DriverDefault, DriverSnapshotSchema } from "./driver.js";
import type { Progress } from "./progress.js";
import type { ProviderService, ProviderStreamOptions } from "./provider.js";
import { type ContextItem, Provider } from "./provider.js";
import { defineTool, type Tool, ToolRegistryLive } from "./tool.js";

const driverLayer = (
  providerService: ProviderService,
  toolLayer = ToolRegistryLive([]),
  journalLayer: Layer.Layer<Journal, JournalError> = JournalMemory(createMemoryJournalBacking()),
) => {
  const providerLayer = Layer.succeed(Provider, providerService);
  return DriverDefault().pipe(
    Layer.provide(Layer.mergeAll(journalLayer, providerLayer, toolLayer)),
  );
};

interface ScriptResult {
  readonly afterAbort: Schema.Schema.Type<typeof DriverSnapshotSchema>;
  readonly afterBranchPrompt: Schema.Schema.Type<typeof DriverSnapshotSchema>;
  readonly afterFollowUp: Schema.Schema.Type<typeof DriverSnapshotSchema>;
  readonly afterToolTurn: Schema.Schema.Type<typeof DriverSnapshotSchema>;
  readonly branched: Schema.Schema.Type<typeof DriverSnapshotSchema>;
  readonly createdRevision: number;
  readonly final: Schema.Schema.Type<typeof DriverSnapshotSchema>;
  readonly progress: ReadonlyArray<Progress>;
  readonly sessionId: SessionId;
}

const runCanonicalScript = async (
  journalLayer: Layer.Layer<Journal, JournalError> = JournalMemory(createMemoryJournalBacking()),
): Promise<ScriptResult> => {
  const toolStarted = await Effect.runPromise(Deferred.make<void>());
  const releaseTool = await Effect.runPromise(Deferred.make<void>());
  const hangingStarted = await Effect.runPromise(Deferred.make<void>());
  let turnRequest = 0;
  const provider: ProviderService = {
    streamAssistant: (_context, options) => {
      if (options.purpose === "compaction") {
        return Stream.fromIterable([
          { _tag: "textDelta", text: "Canonical compacted transcript." },
          { _tag: "done", stopReason: "done" },
        ]);
      }
      turnRequest += 1;
      if (turnRequest === 1) {
        return Stream.fromIterable([
          {
            _tag: "toolCall",
            argumentsJson: '{"path":"src/main.ts"}',
            id: "read-call",
            name: "read-file",
          },
          { _tag: "done", stopReason: "toolCalls" },
        ]);
      }
      if (turnRequest === 4) {
        return Stream.fromEffect(
          Deferred.succeed(hangingStarted, undefined).pipe(
            Effect.as({ _tag: "textDelta" as const, text: "Partial answer." }),
          ),
        ).pipe(Stream.concat(Stream.never));
      }
      const text =
        turnRequest === 2
          ? "Tool turn complete with steering."
          : turnRequest === 3
            ? "Follow-up complete."
            : "Branched answer.";
      return Stream.fromIterable([
        { _tag: "textDelta", text },
        { _tag: "done", stopReason: "done" },
      ]);
    },
  };
  const readFile: Tool<{ readonly path: string }> = {
    description: "Reads a deterministic fixture file.",
    execute: ({ path }) =>
      Deferred.succeed(toolStarted, undefined).pipe(
        Effect.zipRight(Deferred.await(releaseTool)),
        Effect.as({ content: `contents:${path}` }),
      ),
    name: "read-file",
    parameters: Schema.Struct({ path: Schema.String }),
  };

  return Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      const observedProgress = yield* Ref.make<ReadonlyArray<Progress>>([]);
      const subscriptionReady = yield* Deferred.make<void>();
      const progressFiber = yield* Effect.fork(
        Stream.runForEach(driver.subscribeProgress(created.id), (item) =>
          Ref.update(observedProgress, (current) => [...current, item]).pipe(
            Effect.zipRight(Deferred.succeed(subscriptionReady, undefined)),
            Effect.asVoid,
          ),
        ),
      );
      yield* Deferred.await(subscriptionReady);

      const toolTurn = yield* Effect.fork(driver.prompt(created.id, "Inspect the file."));
      yield* Deferred.await(toolStarted);
      yield* driver.steer(created.id, "Also report the exported name.");
      yield* Deferred.succeed(releaseTool, undefined);
      yield* Fiber.join(toolTurn);
      const afterToolTurn = yield* driver.getSnapshot(created.id);

      yield* driver.prompt(created.id, "Give the short follow-up.", {
        deliveryMode: "followUp",
        expectedRevision: afterToolTurn.revision,
      });
      const afterFollowUp = yield* driver.getSnapshot(created.id);

      const hangingTurn = yield* Effect.fork(
        driver.prompt(created.id, "This request will be aborted.", {
          expectedRevision: afterFollowUp.revision,
        }),
      );
      yield* Deferred.await(hangingStarted);
      yield* driver.abortTurn(created.id);
      yield* Fiber.join(hangingTurn);
      const afterAbort = yield* driver.getSnapshot(created.id);

      const branchPoint = afterToolTurn.leaf.id;
      const branched = yield* driver.branch(created.id, branchPoint);
      yield* driver.prompt(created.id, "Answer from the earlier branch.", {
        expectedRevision: branched.revision,
      });
      const afterBranchPrompt = yield* driver.getSnapshot(created.id);
      yield* driver.compactNow(created.id);
      const final = yield* driver.getSnapshot(created.id);
      const progress = yield* Ref.get(observedProgress);
      yield* Fiber.interrupt(progressFiber);

      return {
        afterAbort,
        afterBranchPrompt,
        afterFollowUp,
        afterToolTurn,
        branched,
        createdRevision: created.revision,
        final,
        progress,
        sessionId: created.id,
      };
    }).pipe(
      Effect.provide(driverLayer(provider, ToolRegistryLive([defineTool(readFile)]), journalLayer)),
    ),
  );
};

const normalizeJournalText = (text: string): string => {
  const lines = text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const replacements = new Map<string, string>();
  let entryNumber = 0;
  let operationNumber = 0;
  let recordNumber = 0;
  let sessionNumber = 0;

  for (const line of lines) {
    const encodedPayload = line.payload;
    if (typeof encodedPayload !== "object" || encodedPayload === null) {
      continue;
    }
    const journalLine = encodedPayload as Record<string, unknown>;
    const sessionId = journalLine.sessionId;
    if (typeof sessionId === "string" && !replacements.has(sessionId)) {
      sessionNumber += 1;
      replacements.set(sessionId, `<session-${sessionNumber}>`);
    }
    const type = journalLine.type;
    const item = journalLine.item;
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const durable = item as { readonly id?: unknown; readonly payload?: unknown };
    if (typeof durable.id === "string" && !replacements.has(durable.id)) {
      if (type === "entry") {
        entryNumber += 1;
        replacements.set(durable.id, `<entry-${entryNumber}>`);
      } else if (type === "record") {
        recordNumber += 1;
        replacements.set(durable.id, `<record-${recordNumber}>`);
      }
    }
    if (typeof durable.payload === "object" && durable.payload !== null) {
      const operationId = (durable.payload as { readonly operationId?: unknown }).operationId;
      if (typeof operationId === "string" && !replacements.has(operationId)) {
        operationNumber += 1;
        replacements.set(operationId, `<operation-${operationNumber}>`);
      }
    }
  }

  const normalize = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") {
      return (
        replacements.get(value) ?? (key.toLowerCase().includes("timestamp") ? "<timestamp>" : value)
      );
    }
    if (typeof value === "number" && key.toLowerCase().includes("timestamp")) {
      return "<timestamp>";
    }
    if (Array.isArray(value)) {
      return value.map((item) => normalize(item));
    }
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([entryKey, item]) => [entryKey, normalize(item, entryKey)]),
      );
    }
    return value;
  };

  return `${lines.map((line) => JSON.stringify(normalize(line))).join("\n")}\n`;
};

const foldSnapshot = (
  snapshot: Schema.Schema.Type<typeof DriverSnapshotSchema>,
): Effect.Effect<ReadonlyArray<ContextItem>, ContextBudgetExceeded | JournalError> =>
  foldContext<ContextItem>(snapshot.entries, {
    budget: 1_000_000,
    visibility: entryToContextItem,
  }).pipe(Effect.map((result) => result.items));

test("driver exposes every kernel primitive in-process", async () => {
  const providerOptions: Array<ProviderStreamOptions> = [];
  const provider: ProviderService = {
    streamAssistant: (_context, options) => {
      providerOptions.push(options);
      return Stream.fromIterable([
        { _tag: "textDelta", text: options.purpose === "compaction" ? "summary" : "reply" },
        { _tag: "done", stopReason: "done" },
      ]);
    },
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      yield* driver.setModel(created.id, "fixture-model", created.revision);
      const afterModel = yield* driver.getSnapshot(created.id);
      yield* driver.setThinkingLevel(created.id, "medium", afterModel.revision);
      const afterThinking = yield* driver.getSnapshot(created.id);
      const prompted = yield* driver.prompt(created.id, "Hello", {
        deliveryMode: "followUp",
        expectedRevision: afterThinking.revision,
      });
      const beforeCompaction = yield* driver.getSnapshot(created.id);
      const compacted = yield* driver.compactNow(created.id, beforeCompaction.revision);
      const afterCompaction = yield* driver.getSnapshot(created.id);
      const branched = yield* driver.branch(created.id, created.leaf.id, afterCompaction.revision);
      const forked = yield* driver.fork(created.id, created.leaf.id, branched.revision);
      const aborted = yield* driver.abortTurn(created.id);
      const steerFailure = yield* Effect.flip(driver.steer(created.id, "Too late"));
      const resumed = yield* driver.resumeSession(created.id);
      const listed = yield* driver.listSessions();
      const progress = driver.subscribeProgress(created.id);
      return {
        aborted,
        beforeCompaction,
        branched,
        compacted,
        created,
        forked,
        listed,
        progress,
        prompted,
        resumed,
        steerFailure,
      };
    }).pipe(Effect.provide(driverLayer(provider))),
  );

  await Effect.runPromise(Schema.decodeUnknown(DriverSnapshotSchema)(result.beforeCompaction));
  expect(result.prompted).toEqual({ stopReason: "done" });
  expect(result.beforeCompaction).toMatchObject({
    model: "fixture-model",
    phase: "IDLE",
    sessionId: result.created.id,
    thinkingLevel: "medium",
  });
  expect(result.compacted.entriesCovered).toBeGreaterThan(0);
  expect(result.branched.entries).toEqual([result.created.leaf]);
  expect(result.forked).toMatchObject({
    entries: [expect.objectContaining({ kind: "session_root" })],
    phase: "IDLE",
  });
  expect(result.forked.sessionId).not.toBe(result.created.id);
  expect(result.aborted).toEqual({ aborted: false, reason: "none", turnOrdinal: undefined });
  expect(result.steerFailure).toMatchObject({
    _tag: "ProtocolError",
    reason: "phase_invalid_command",
  });
  expect(result.resumed.id).toBe(result.created.id);
  expect(result.listed.map(({ id }: { readonly id: SessionId }) => id)).toEqual([
    result.created.id,
    result.forked.sessionId,
  ]);
  const initialProgress = await Effect.runPromise(
    result.progress.pipe(Stream.take(1), Stream.runCollect),
  );
  expect(Chunk.toReadonlyArray(initialProgress)).toEqual([{ _tag: "phaseChanged", phase: "IDLE" }]);
  expect(providerOptions).toEqual([
    expect.objectContaining({
      model: "fixture-model",
      purpose: "turn",
      thinkingLevel: "medium",
    }),
    expect.objectContaining({ purpose: "compaction" }),
  ]);
});

test("snapshot reads are atomic with concurrent turns", async () => {
  const provider: ProviderService = {
    streamAssistant: (_context, options) =>
      Stream.fromIterable([
        { _tag: "textDelta", text: `reply-${options.turnOrdinal}` },
        { _tag: "done", stopReason: "done" },
      ]),
  };

  const snapshots = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      const turns = Effect.forEach(
        Array.from({ length: 48 }, (_, index) => index),
        (index) => driver.prompt(created.id, `prompt-${index}`),
        { concurrency: "unbounded" },
      );
      const reads = Effect.forEach(
        Array.from({ length: 96 }),
        () => driver.getSnapshot(created.id),
        { concurrency: "unbounded" },
      );
      const [, observed] = yield* Effect.all([turns, reads], { concurrency: "unbounded" });
      return observed;
    }).pipe(Effect.provide(driverLayer(provider))),
  );

  const entriesByRevision = new Map<number, string>();
  for (const snapshot of snapshots) {
    const entryIds = snapshot.entries.map((entry) => entry.id).join(",");
    const prior = entriesByRevision.get(snapshot.revision);
    if (prior === undefined) {
      entriesByRevision.set(snapshot.revision, entryIds);
    } else {
      expect(entryIds).toBe(prior);
    }
    expect(snapshot.leaf).toEqual(snapshot.entries.at(-1));
  }
});

test("settings resolve inside turn command order", async () => {
  const firstStarted = await Effect.runPromise(Deferred.make<void>());
  const releaseFirst = await Effect.runPromise(Deferred.make<void>());
  const observed: Array<ProviderStreamOptions> = [];
  let request = 0;
  const provider: ProviderService = {
    streamAssistant: (_context, options) => {
      observed.push(options);
      request += 1;
      if (request === 1) {
        return Stream.fromEffect(
          Deferred.succeed(firstStarted, undefined).pipe(
            Effect.zipRight(Deferred.await(releaseFirst)),
            Effect.as({ _tag: "textDelta" as const, text: "first" }),
          ),
        ).pipe(
          Stream.concat(Stream.succeed({ _tag: "done" as const, stopReason: "done" as const })),
        );
      }
      return Stream.fromIterable([
        { _tag: "textDelta", text: "second" },
        { _tag: "done", stopReason: "done" },
      ]);
    },
  };

  await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      const first = yield* Effect.fork(driver.prompt(created.id, "first"));
      yield* Deferred.await(firstStarted);
      const setModel = yield* Effect.fork(driver.setModel(created.id, "fixture-model"));
      yield* Effect.yieldNow();
      const second = yield* Effect.fork(driver.prompt(created.id, "second"));
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(setModel);
      yield* Fiber.join(second);
    }).pipe(Effect.provide(driverLayer(provider))),
  );

  expect(observed).toHaveLength(2);
  expect(observed[0]?.model).toBeUndefined();
  expect(observed[1]?.model).toBe("fixture-model");
});

test("durable Branch settings survive a JSONL layer restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peye-kernel-settings-"));
  const provider: ProviderService = {
    streamAssistant: () =>
      Stream.fromIterable([
        { _tag: "textDelta", text: "reply" },
        { _tag: "done", stopReason: "done" },
      ]),
  };
  try {
    const sessionId = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const created = yield* driver.createSession();
        yield* driver.setModel(created.id, "fixture-model");
        yield* driver.setThinkingLevel(created.id, "xhigh");
        return created.id;
      }).pipe(Effect.provide(driverLayer(provider, ToolRegistryLive([]), JournalJsonl(directory)))),
    );

    const resumed = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        yield* driver.resumeSession(sessionId);
        return yield* driver.getSnapshot(sessionId);
      }).pipe(Effect.provide(driverLayer(provider, ToolRegistryLive([]), JournalJsonl(directory)))),
    );

    expect(resumed).toMatchObject({ model: "fixture-model", thinkingLevel: "xhigh" });
    expect(resumed.entries.slice(-2).map((entry) => entry.kind)).toEqual([
      "model_change",
      "thinking_change",
    ]);
    expect(
      resumed.entries
        .filter((entry) => entry.kind === "model_change" || entry.kind === "thinking_change")
        .every((entry) => entryToContextItem(entry) === undefined),
    ).toBe(true);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("branching before newer settings restores the earlier Branch-derived values", async () => {
  const provider: ProviderService = {
    streamAssistant: () => Stream.succeed({ _tag: "done", stopReason: "done" }),
  };

  const branched = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      yield* driver.setModel(created.id, "earlier-model");
      const earlier = yield* driver.getSnapshot(created.id);
      yield* driver.setModel(created.id, "fixture-model");
      yield* driver.setThinkingLevel(created.id, "high");
      const changed = yield* driver.getSnapshot(created.id);
      return yield* driver.branch(created.id, earlier.leaf.id, changed.revision);
    }).pipe(Effect.provide(driverLayer(provider))),
  );

  expect(branched.model).toBe("earlier-model");
  expect(branched.thinkingLevel).toBeUndefined();
  expect(branched.entries).toHaveLength(2);
});

test("every mutating Driver primitive rejects a stale expectedRevision", async () => {
  const provider: ProviderService = {
    streamAssistant: () =>
      Stream.fromIterable([
        { _tag: "textDelta", text: "summary" },
        { _tag: "done", stopReason: "done" },
      ]),
  };

  const errors = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      const stale = created.revision - 1;
      return yield* Effect.all([
        Effect.flip(driver.branch(created.id, created.leaf.id, stale)),
        Effect.flip(driver.fork(created.id, created.leaf.id, stale)),
        Effect.flip(driver.compactNow(created.id, stale)),
        Effect.flip(driver.invokeCommand(created.id, "missing", {}, stale)),
        Effect.flip(driver.setModel(created.id, "fixture-model", stale)),
        Effect.flip(driver.setThinkingLevel(created.id, "medium", stale)),
      ]);
    }).pipe(Effect.provide(driverLayer(provider))),
  );

  expect(errors).toHaveLength(6);
  for (const error of errors) {
    expect(error).toMatchObject({ _tag: "StaleRevision", actual: 1, expected: 0 });
  }
});

test("fork remaps Compaction before, at, and after its Entry and supports fork-of-fork", async () => {
  const provider: ProviderService = {
    streamAssistant: (_context, options) =>
      Stream.fromIterable([
        {
          _tag: "textDelta",
          text: options.purpose === "compaction" ? "compacted source" : "reply",
        },
        { _tag: "done", stopReason: "done" },
      ]),
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      yield* driver.prompt(created.id, "before");
      const before = yield* driver.getSnapshot(created.id);
      const forkBefore = yield* driver.fork(created.id, before.leaf.id);
      const compacted = yield* driver.compactNow(created.id);
      const at = yield* driver.getSnapshot(created.id);
      const forkAt = yield* driver.fork(created.id, compacted.compactionEntryId);
      yield* driver.prompt(created.id, "after");
      const after = yield* driver.getSnapshot(created.id);
      const forkAfter = yield* driver.fork(created.id, after.leaf.id);
      const forkOfFork = yield* driver.fork(forkAfter.sessionId, forkAfter.leaf.id);
      return {
        after,
        at,
        before,
        forkAfter,
        forkAt,
        forkBefore,
        forkOfFork,
      };
    }).pipe(Effect.provide(driverLayer(provider))),
  );

  expect(await Effect.runPromise(foldSnapshot(result.forkBefore))).toEqual(
    await Effect.runPromise(foldSnapshot(result.before)),
  );
  expect(await Effect.runPromise(foldSnapshot(result.forkAt))).toEqual(
    await Effect.runPromise(foldSnapshot(result.at)),
  );
  expect(await Effect.runPromise(foldSnapshot(result.forkAfter))).toEqual(
    await Effect.runPromise(foldSnapshot(result.after)),
  );
  expect(await Effect.runPromise(foldSnapshot(result.forkOfFork))).toEqual(
    await Effect.runPromise(foldSnapshot(result.forkAfter)),
  );
});

test("fork rejects an Entry that is no longer on the current Branch", async () => {
  const provider: ProviderService = {
    streamAssistant: () => Stream.succeed({ _tag: "done", stopReason: "done" }),
  };

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      yield* driver.prompt(created.id, "abandoned");
      const abandoned = yield* driver.getSnapshot(created.id);
      const branched = yield* driver.branch(created.id, created.leaf.id, abandoned.revision);
      return yield* Effect.flip(driver.fork(created.id, abandoned.leaf.id, branched.revision));
    }).pipe(Effect.provide(driverLayer(provider))),
  );

  expect(error).toMatchObject({
    _tag: "JournalError",
    corruptionClass: "dangling_leaf_reference",
  });
});

test("fork synthesizes interrupted results for unanswered tool calls", async () => {
  const backing = createMemoryJournalBacking();
  const journalLayer = JournalMemory(backing);
  const provider: ProviderService = {
    streamAssistant: () => Stream.succeed({ _tag: "done", stopReason: "done" }),
  };
  const layer = Layer.merge(
    driverLayer(provider, ToolRegistryLive([]), journalLayer),
    journalLayer,
  );

  const forked = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const created = yield* journal.createSession();
      const assistant = yield* journal.appendEntry(
        created.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: {
            content: "",
            role: "assistant",
            stopReason: "toolCalls",
            toolCalls: [{ argumentsJson: "{}", id: "open-call", name: "open-tool" }],
          },
        }),
      );
      const driver = yield* Driver;
      yield* driver.resumeSession(created.id);
      const snapshot = yield* driver.getSnapshot(created.id);
      return yield* driver.fork(created.id, assistant.id, snapshot.revision);
    }).pipe(Effect.provide(layer)),
  );

  expect(forked.entries.at(-1)).toMatchObject({
    kind: "message",
    payload: {
      content: "Tool execution interrupted by fork.",
      isError: true,
      role: "toolResult",
      toolCallId: "open-call",
      toolName: "open-tool",
    },
  });
  const folded = await Effect.runPromise(foldSnapshot(forked));
  const calls = folded.flatMap((item) => (item.role === "assistant" ? (item.toolCalls ?? []) : []));
  const answers = new Set(
    folded.flatMap((item) => (item.role === "toolResult" ? [item.toolCallId] : [])),
  );
  expect(calls.every((call) => answers.has(call.id))).toBe(true);
});

test("scripted session passes through prompt, tool, steer, abort, and branch with journal content", async () => {
  const result = await runCanonicalScript();

  expect(result.afterAbort.entries.at(-2)).toMatchObject({
    payload: { content: "This request will be aborted.", role: "user" },
  });
  expect(result.afterAbort.entries.at(-1)).toMatchObject({
    payload: { content: "Partial answer.", role: "assistant", stopReason: "aborted" },
  });
  expect(result.branched.leaf.id).toBe(result.afterToolTurn.leaf.id);
  expect(result.final.entries.map((entry) => entry.payload)).toMatchObject([
    {},
    { content: "Inspect the file.", role: "user" },
    {
      role: "assistant",
      stopReason: "toolCalls",
      toolCalls: [{ id: "read-call", name: "read-file" }],
    },
    {
      content: "contents:src/main.ts",
      role: "toolResult",
      toolCallId: "read-call",
      toolName: "read-file",
    },
    { content: "Also report the exported name.", deliveryMode: "steer", role: "user" },
    { content: "Tool turn complete with steering.", role: "assistant", stopReason: "done" },
    { content: "Answer from the earlier branch.", role: "user" },
    { content: "Branched answer.", role: "assistant", stopReason: "done" },
    {
      firstSummarizedId: expect.any(String),
      lastSummarizedId: expect.any(String),
      retainedTailIds: result.afterBranchPrompt.entries.slice(-2).map((entry) => entry.id),
      summary: "Canonical compacted transcript.",
    },
  ]);
  expect(result.final.phase).toBe("IDLE");
});

test("snapshot revision increments monotonically across the scripted session", async () => {
  const result = await runCanonicalScript();
  const revisions = [
    result.createdRevision,
    result.afterToolTurn.revision,
    result.afterFollowUp.revision,
    result.afterAbort.revision,
    result.branched.revision,
    result.afterBranchPrompt.revision,
    result.final.revision,
  ];

  expect(
    revisions.every((revision, index) => {
      const previous = revisions[index - 1];
      return previous === undefined || revision > previous;
    }),
  ).toBe(true);
});

test("progress subscription delivers items during the scripted session", async () => {
  const result = await runCanonicalScript();
  const tags = result.progress.map((item) => item._tag);

  expect(tags).toContain("toolStarted");
  expect(tags).toContain("toolCompleted");
  expect(tags).toContain("steeringQueued");
  expect(tags).toContain("steeringApplied");
  expect(tags).toContain("turnSettled");
  expect(tags).toContain("compactionStarted");
  expect(tags).toContain("compactionApplied");
  expect(
    result.progress.some((item) => item._tag === "turnSettled" && item.stopReason === "aborted"),
  ).toBe(true);
});

test("scripted session is captured as the canonical recorded-journal fixture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peye-kernel-m14-"));
  try {
    const result = await runCanonicalScript(JournalJsonl(directory));
    const recorded = await readFile(join(directory, `${result.sessionId}.jsonl`), "utf8");
    const golden = await readFile(
      new URL("../test-fixtures/canonical-driver-session.jsonl", import.meta.url),
      "utf8",
    );

    const normalized = normalizeJournalText(recorded);
    expect(normalized).toBe(golden);
    expect(normalizeJournalText(normalized)).toBe(normalized);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
