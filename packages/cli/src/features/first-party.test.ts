import { createMemoryJournalBacking, JournalMemory } from "@peye/journal";
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

const makeFirstPartyDriverLayer = (hostOptions: FirstPartyPluginHostOptions = {}) =>
  FirstPartyDriverDefault(
    { compaction: { retainedTailCount: 0, sliceBudget: 256 } },
    hostOptions,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        JournalMemory(createMemoryJournalBacking()),
        Layer.succeed(Provider, provider),
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

test("compact Plugin gate vetoes and replaces Compaction through Driver.invokeCommand", async () => {
  const blockedLayer = makeFirstPartyDriverLayer({
    plugins: [
      makeCompactPlugin({
        decideCompaction: () =>
          Effect.succeed({ decision: "block" as const, reason: "Compaction is paused." }),
      }),
    ],
  });
  const replacedLayer = makeFirstPartyDriverLayer({
    plugins: [
      makeCompactPlugin({
        decideCompaction: () =>
          Effect.succeed({
            decision: "replace" as const,
            value: { action: "skip" as const, reason: "Use the retained Context." },
          }),
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
  const replaced = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      yield* driver.prompt(created.id, "Keep this Context.");
      const result = yield* driver.invokeCommand(created.id, "compact", {});
      const snapshot = yield* driver.getSnapshot(created.id);
      return { result, snapshot };
    }).pipe(Effect.provide(replacedLayer)),
  );

  expect(blocked.error).toMatchObject({ reason: "command_failed" });
  expect(blocked.snapshot.entries.some((entry) => entry.kind === "compaction")).toBe(false);
  expect(replaced.result).toEqual({ reason: "Use the retained Context.", skipped: true });
  expect(replaced.snapshot.entries.some((entry) => entry.kind === "compaction")).toBe(false);
});
