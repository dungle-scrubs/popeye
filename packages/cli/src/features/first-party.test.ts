import { createMemoryJournalBacking, JournalMemory } from "@dungle-scrubs/popeye-journal";
import { Effect, Layer, Stream } from "effect";
import { expect, test } from "vitest";

import {
  Driver,
  FirstPartyDriverDefault,
  type FirstPartyPluginHostOptions,
  Provider,
  type ProviderService,
  ToolRegistryLive,
} from "../compose.js";
import { makeCompactPlugin } from "./compact.js";

const provider: ProviderService = {
  streamAssistant: (_context, options) =>
    Stream.fromIterable([
      {
        _tag: "textDelta",
        text: options.purpose === "compaction" ? "compact summary" : "turn reply",
      },
      { _tag: "done", stopReason: "done" },
    ]),
};

const makeFirstPartyDriverLayer = (
  hostOptions: FirstPartyPluginHostOptions = {},
  providerService: ProviderService = provider,
) =>
  FirstPartyDriverDefault(
    { compaction: { retainedTailCount: 0, sliceBudget: 256 } },
    hostOptions,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        JournalMemory(createMemoryJournalBacking()),
        Layer.succeed(Provider, providerService),
        ToolRegistryLive([]),
      ),
    ),
  );

const firstPartyDriverLayer = makeFirstPartyDriverLayer();

test("Driver.invokeCommand dispatches the compact Plugin and appends a Compaction Entry", async () => {
  const snapshot = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      yield* driver.prompt(created.id, "Keep this Context.");
      yield* driver.invokeCommand(created.id, "compact", {});
      return yield* driver.getSnapshot(created.id);
    }).pipe(Effect.provide(firstPartyDriverLayer)),
  );

  expect(snapshot.entries.filter((entry) => entry.kind === "compaction")).toHaveLength(1);
});

test("Driver.invokeCommand dispatches the session-name Plugin and exposes the name in the Snapshot", async () => {
  const snapshot = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      yield* driver.invokeCommand(created.id, "session-name", { name: "Dogfood proof" });
      return yield* driver.getSnapshot(created.id);
    }).pipe(Effect.provide(firstPartyDriverLayer)),
  );

  expect(snapshot).toMatchObject({ name: "Dogfood proof" });
  expect(snapshot.entries).toContainEqual(
    expect.objectContaining({ kind: "session_name", payload: { name: "Dogfood proof" } }),
  );
});

test("compact Plugin gate returns a veto-specific command outcome with its reason", async () => {
  const blockedLayer = makeFirstPartyDriverLayer({
    plugins: [
      makeCompactPlugin({
        decideCompaction: () =>
          Effect.succeed({ action: "skip" as const, reason: "Compaction is paused." }),
      }),
    ],
  });

  const blocked = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      yield* driver.prompt(created.id, "Keep this Context.");
      const error = yield* Effect.flip(driver.invokeCommand(created.id, "compact", {}));
      const snapshot = yield* driver.getSnapshot(created.id);
      return { error, snapshot };
    }).pipe(Effect.provide(blockedLayer)),
  );
  const crashed = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      yield* driver.prompt(created.id, "Keep this Context.");
      return yield* Effect.flip(driver.invokeCommand(created.id, "compact", {}));
    }).pipe(
      Effect.provide(
        makeFirstPartyDriverLayer({
          plugins: [
            makeCompactPlugin({
              decideCompaction: () => Effect.die("Compaction gate crashed."),
            }),
          ],
        }),
      ),
    ),
  );

  expect(blocked.error).toMatchObject({
    message: "Compaction is paused.",
    reason: "command_vetoed",
  });
  expect(crashed).toMatchObject({ reason: "command_failed" });
  expect(blocked.snapshot.entries.some((entry) => entry.kind === "compaction")).toBe(false);
});

test("a blocking Compaction gate prevents overflow-triggered Compaction", async () => {
  const requestKinds: Array<string | undefined> = [];
  const blockingProvider: ProviderService = {
    streamAssistant: (_context, options) => {
      requestKinds.push(options.purpose);
      return Stream.fromIterable([
        { _tag: "textDelta", text: "unexpected" },
        { _tag: "done", stopReason: "done" },
      ]);
    },
  };
  const blockedLayer = makeFirstPartyDriverLayer(
    {
      plugins: [
        makeCompactPlugin({
          decideCompaction: () =>
            Effect.succeed({
              action: "skip" as const,
              reason: "Keep the full Context for review.",
            }),
        }),
      ],
    },
    blockingProvider,
  );

  const snapshot = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      yield* driver.prompt(created.id, "Overflow before the Provider request.", {
        contextBudget: 0,
      });
      return yield* driver.getSnapshot(created.id);
    }).pipe(Effect.provide(blockedLayer)),
  );

  expect(requestKinds).toEqual([]);
  expect(snapshot.entries.filter((entry) => entry.kind === "compaction")).toHaveLength(0);
  expect(snapshot.entries.at(-1)).toMatchObject({
    payload: {
      diagnostic: {
        detail: expect.stringContaining("Keep the full Context for review."),
        reason: "budget_exceeded",
      },
      role: "assistant",
      stopReason: "error",
    },
  });
  expect(JSON.stringify(snapshot.entries.at(-1)?.payload)).toContain(
    "Branch to an earlier Entry or start a new Session.",
  );
});

test("invokeCommand rejects a stale expectedRevision before mutation", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      const error = yield* Effect.flip(
        driver.invokeCommand(created.id, "session-name", { name: "Rejected" }, 0),
      );
      return { error, snapshot: yield* driver.getSnapshot(created.id) };
    }).pipe(Effect.provide(firstPartyDriverLayer)),
  );

  expect(result.error).toMatchObject({ _tag: "StaleRevision", actual: 1, expected: 0 });
  expect(result.snapshot.name).toBeUndefined();
});

test("session-name rejects empty, whitespace-only, and overlong names", async () => {
  const errors = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      return yield* Effect.forEach(["", "   ", "x".repeat(201)], (name) =>
        Effect.flip(driver.invokeCommand(created.id, "session-name", { name })),
      );
    }).pipe(Effect.provide(firstPartyDriverLayer)),
  );

  expect(errors).toHaveLength(3);
  for (const error of errors) {
    expect(error).toMatchObject({ reason: "arguments_invalid" });
  }
});

test("Session name survives resume and reverts with the Branch", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      yield* driver.invokeCommand(created.id, "session-name", { name: "Earlier name" });
      const earlier = yield* driver.getSnapshot(created.id);
      yield* driver.resumeSession(created.id);
      const resumed = yield* driver.getSnapshot(created.id);
      yield* driver.invokeCommand(created.id, "session-name", { name: "Later name" });
      const later = yield* driver.getSnapshot(created.id);
      const branched = yield* driver.branch(created.id, earlier.leaf.id, later.revision);
      return { branched, resumed };
    }).pipe(Effect.provide(firstPartyDriverLayer)),
  );

  expect(result.resumed.name).toBe("Earlier name");
  expect(result.branched.name).toBe("Earlier name");
});

test("session_name never enters Provider request Context", async () => {
  const contexts: Array<ReadonlyArray<unknown>> = [];
  const capturingProvider: ProviderService = {
    streamAssistant: (context) => {
      contexts.push(context);
      return Stream.fromIterable([
        { _tag: "textDelta", text: "reply" },
        { _tag: "done", stopReason: "done" },
      ]);
    },
  };

  await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      yield* driver.invokeCommand(created.id, "session-name", { name: "Provider secret name" });
      yield* driver.prompt(created.id, "Visible user input");
    }).pipe(Effect.provide(makeFirstPartyDriverLayer({}, capturingProvider))),
  );

  expect(contexts).toEqual([[{ content: "Visible user input", role: "user" }]]);
  expect(JSON.stringify(contexts)).not.toContain("Provider secret name");
  expect(JSON.stringify(contexts)).not.toContain("session_name");
});
