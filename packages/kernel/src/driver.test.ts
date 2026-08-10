import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journal, JournalError } from "@peye/journal";
import {
  createMemoryJournalBacking,
  JournalJsonl,
  JournalMemory,
  type SessionId,
} from "@peye/journal";
import { Chunk, Deferred, Effect, Fiber, Layer, Ref, Schema, Stream } from "effect";
import { expect, test } from "vitest";

import { CompactionLive } from "./compaction-policy.js";
import { Driver, DriverLive, DriverSnapshotSchema } from "./driver.js";
import { MailboxLive } from "./mailbox.js";
import { type Progress, ProgressHubLive } from "./progress.js";
import type { ProviderService, ProviderStreamOptions } from "./provider.js";
import { Provider } from "./provider.js";
import { SessionsLive } from "./sessions.js";
import { defineTool, type Tool, ToolRegistryLive } from "./tool.js";
import { TurnsLive } from "./turn.js";

const driverLayer = (
  providerService: ProviderService,
  toolLayer = ToolRegistryLive([]),
  journalLayer: Layer.Layer<Journal, JournalError> = JournalMemory(createMemoryJournalBacking()),
) => {
  const mailboxLayer = MailboxLive().pipe(Layer.provide(journalLayer));
  const progressLayer = ProgressHubLive();
  const providerLayer = Layer.succeed(Provider, providerService);
  const base = Layer.mergeAll(journalLayer, mailboxLayer, progressLayer, providerLayer, toolLayer);
  const compactionLayer = CompactionLive().pipe(Layer.provide(base));
  const kernel = Layer.mergeAll(base, compactionLayer);
  const sessionsLayer = SessionsLive().pipe(Layer.provide(kernel));
  const turnsLayer = TurnsLive().pipe(Layer.provide(kernel));
  const dependencies = Layer.mergeAll(kernel, sessionsLayer, turnsLayer);
  return DriverLive.pipe(Layer.provide(dependencies));
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
      const attached = yield* driver.attach(created.id);
      yield* driver.setModel(created.id, "fixture-model");
      yield* driver.setThinkingLevel(created.id, "medium");
      const prompted = yield* driver.prompt(created.id, "Hello", {
        deliveryMode: "followUp",
        expectedRevision: created.revision,
      });
      const beforeCompaction = yield* driver.getSnapshot(created.id);
      const compacted = yield* driver.compactNow(created.id);
      const branched = yield* driver.branch(created.id, created.leaf.id);
      const forked = yield* driver.fork(created.id, created.leaf.id);
      const aborted = yield* driver.abortTurn(created.id);
      const steerFailure = yield* Effect.flip(driver.steer(created.id, "Too late"));
      const resumed = yield* driver.resumeSession(created.id);
      const listed = yield* driver.listSessions();
      const progress = driver.subscribeProgress(created.id);
      yield* driver.detach(created.id);
      return {
        aborted,
        attached,
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
  expect(result.attached).toMatchObject({ phase: "IDLE", revision: 1 });
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
    model: "fixture-model",
    phase: "IDLE",
    thinkingLevel: "medium",
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

    expect(normalizeJournalText(recorded)).toBe(golden);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
