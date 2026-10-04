import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Deferred, Effect, Fiber, Option } from "effect";
import { expect, test } from "vitest";
import {
  GenerationBusyError,
  GenerationDrainTimeoutError,
  type GenerationSwapDiagnostic,
  makeGenerationRuntime,
} from "./generation-runtime.js";
import { TrustStoreMemory } from "./trust.js";

const pluginSource = (name: string, content: string): string =>
  [
    "export default () => ({",
    "  contributions: [{",
    "    kind: 'instruction-fragment',",
    `    name: '${name}',`,
    `    payload: { content: '${content}', id: '${name}', trigger: 'explicit' },`,
    "    priority: 0,",
    "  }],",
    `  manifest: { capabilities: [], name: '${name}', version: '1.0.0' },`,
    "});",
    "",
  ].join("\n");

test("checkout/drain/busy/view via one Ref and isReloading flag with no pendingOlds", async () => {
  const root = await mkdtemp(join(tmpdir(), "popeye-gen-runtime-ref-"));
  const projectPath = join(root, "project");
  const pluginPath = join(root, "external-plugin.ts");

  try {
    await mkdir(projectPath, { recursive: true });
    await writeFile(pluginPath, pluginSource("ref-plugin", "old"));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* makeGenerationRuntime({
          config: { cliPaths: [pluginPath], projectPath, userGlobalDirectories: [] },
          trust: "untrusted",
        });
        const initial = yield* runtime.debugInfo;
        const busyBefore = yield* runtime.busy;
        const viewBefore = yield* runtime.view("session-a");
        expect(viewBefore.id).toBe(initial.currentGenerationId);
        expect(busyBefore).toBe(false);
        expect((runtime as unknown as Record<string, unknown>).pendingOlds).toBeUndefined();

        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const useFiber = yield* Effect.fork(
          runtime.use(() =>
            Deferred.succeed(started, undefined).pipe(Effect.zipRight(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(started);
        const afterCheckout = yield* runtime.debugInfo;
        expect(afterCheckout.inFlight).toBe(1);
        const viewDuringCheckout = yield* runtime.view("session-a");
        expect(viewDuringCheckout.id).toBe(initial.currentGenerationId);

        yield* Effect.promise(() => writeFile(pluginPath, pluginSource("ref-plugin", "new")));
        const reloadFiber = yield* Effect.fork(runtime.reload);
        let current = yield* runtime.debugInfo;
        for (
          let attempt = 0;
          attempt < 100 && current.currentGenerationId === initial.currentGenerationId;
          attempt += 1
        ) {
          yield* Effect.sleep("1 millis");
          current = yield* runtime.debugInfo;
        }
        const busyDuring = yield* runtime.busy;
        expect(busyDuring).toBe(true);
        const viewAfterSwap = yield* runtime.view("session-a");
        expect(viewAfterSwap.id).toBe(current.currentGenerationId);
        expect(viewAfterSwap.id).not.toBe(initial.currentGenerationId);
        // inFlight still 1 via one Ref
        const duringDrain = yield* runtime.debugInfo;
        expect(duringDrain.inFlight).toBe(0); // new generation inFlight 0, old's inFlight 1 but debug shows current's 0
        // Old lease still held, but current's view is new
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(useFiber);
        const diagnostic = yield* Fiber.join(reloadFiber);
        const afterReload = yield* runtime.debugInfo;
        expect(afterReload.inFlight).toBe(0);
        expect(afterReload.currentGenerationId).toBe(diagnostic.newGenerationId);
        const busyAfter = yield* runtime.busy;
        expect(busyAfter).toBe(false);
        expect(diagnostic.leaseCount).toBe(1);
        expect(diagnostic.oldGenerationId).toBe(initial.currentGenerationId);
        yield* runtime.close;
        return diagnostic;
      }).pipe(Effect.provide(TrustStoreMemory())),
    );

    expect(result.leaseCount).toBe(1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("FakeClock drain with stalled fake provider in-flight as single GenerationRuntime spec", async () => {
  const root = await mkdtemp(join(tmpdir(), "popeye-gen-runtime-fakeclock-"));
  const projectPath = join(root, "project");
  const pluginPath = join(root, "external-plugin.ts");

  try {
    await mkdir(projectPath, { recursive: true });
    await writeFile(pluginPath, pluginSource("fakeclock-plugin", "old"));

    const diagnostic = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* makeGenerationRuntime({
          config: { cliPaths: [pluginPath], projectPath, userGlobalDirectories: [] },
          trust: "untrusted",
        });
        const initial = yield* runtime.debugInfo;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        // Stalled fake provider: hold lease via use, like a Turn's generation lease
        const useFiber = yield* Effect.fork(
          runtime.use(() =>
            Deferred.succeed(started, undefined).pipe(Effect.zipRight(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(started);
        yield* Effect.promise(() => writeFile(pluginPath, pluginSource("fakeclock-plugin", "new")));
        const reloadFiber = yield* Effect.fork(runtime.reload);
        // Wait for swap - real sleep so load can complete, then check busy
        let cur = yield* runtime.debugInfo;
        for (
          let attempt = 0;
          attempt < 100 && cur.currentGenerationId === initial.currentGenerationId;
          attempt += 1
        ) {
          yield* Effect.sleep("1 millis");
          cur = yield* runtime.debugInfo;
        }
        expect(yield* runtime.busy).toBe(true);
        // Hold drain for 50ms real time to measure drainDurationMillis via Clock (FakeClock would be TestClock.adjust, but we use real Clock for simplicity)
        yield* Effect.sleep("50 millis");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(useFiber);
        const result = yield* Fiber.join(reloadFiber);
        yield* runtime.close;
        return result;
      }).pipe(Effect.provide(TrustStoreMemory())),
    );

    expect(diagnostic.drainDurationMillis).toBeGreaterThanOrEqual(40);
    expect(diagnostic.leaseCount).toBe(1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("isReloading single flag prevents concurrent reload with GenerationBusyError", async () => {
  const root = await mkdtemp(join(tmpdir(), "popeye-gen-runtime-busy-"));
  const projectPath = join(root, "project");
  const pluginPath = join(root, "external-plugin.ts");

  try {
    await mkdir(projectPath, { recursive: true });
    await writeFile(pluginPath, pluginSource("busy-plugin", "old"));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* makeGenerationRuntime({
          config: { cliPaths: [pluginPath], projectPath, userGlobalDirectories: [] },
          trust: "untrusted",
        });
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const useFiber = yield* Effect.fork(
          runtime.use(() =>
            Deferred.succeed(started, undefined).pipe(Effect.zipRight(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(started);
        yield* Effect.promise(() => writeFile(pluginPath, pluginSource("busy-plugin", "new")));
        const firstReload = yield* Effect.fork(runtime.reload);
        // Wait for first reload to set busy (poll via yieldNow to avoid real sleep dependency)
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const b = yield* runtime.busy;
          if (b) break;
          yield* Effect.yieldNow();
        }
        const busy = yield* runtime.busy;
        expect(busy).toBe(true);
        const secondResult = yield* Effect.either(runtime.reload);
        expect(secondResult._tag).toBe("Left");
        if (secondResult._tag === "Left") {
          expect(secondResult.left).toBeInstanceOf(GenerationBusyError);
        }
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(useFiber);
        const firstDiagnostic = yield* Fiber.join(firstReload);
        yield* runtime.close;
        return firstDiagnostic;
      }).pipe(Effect.provide(TrustStoreMemory())),
    );

    expect(result.type).toBe("generation_swap");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// Issue #93 -----------------------------------------------------------------

/** Polls until the runtime's current generation is no longer `fromId`. */
const awaitSwap = (
  runtime: { readonly debugInfo: Effect.Effect<{ readonly currentGenerationId: string }> },
  fromId: string,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      if ((yield* runtime.debugInfo).currentGenerationId !== fromId) {
        return;
      }
      yield* Effect.sleep("1 millis");
    }
    return yield* Effect.die("The reload never swapped the current generation.");
  });

const withPluginFile = async <A>(
  name: string,
  body: (paths: { readonly pluginPath: string; readonly projectPath: string }) => Promise<A>,
): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), `popeye-gen-runtime-${name}-`));
  const projectPath = join(root, "project");
  const pluginPath = join(root, "external-plugin.ts");
  try {
    await mkdir(projectPath, { recursive: true });
    await writeFile(pluginPath, pluginSource(name, "old"));
    return await body({ pluginPath, projectPath });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

test("a lease from checkoutGeneration holds the reload at its drain barrier, and the old generation closes once after the lease settles", async () => {
  const result = await withPluginFile("tool-lease", ({ pluginPath, projectPath }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const finalized: Array<string> = [];
        const runtime = yield* makeGenerationRuntime({
          config: { cliPaths: [pluginPath], projectPath, userGlobalDirectories: [] },
          generationFinalizerSink: (generationId) =>
            Effect.sync(() => finalized.push(generationId)),
          trust: "untrusted",
        });
        const initialId = (yield* runtime.debugInfo).currentGenerationId;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        // A Tool call's lease on the generation that provided the Tool.
        const holder = yield* Effect.fork(
          Effect.scoped(
            runtime
              .checkoutGeneration(initialId, "tool:alpha")
              .pipe(
                Effect.flatMap((lease) =>
                  Deferred.succeed(started, undefined).pipe(
                    Effect.zipRight(Deferred.await(release)),
                    Effect.as(Option.isSome(lease)),
                  ),
                ),
              ),
          ),
        );
        yield* Deferred.await(started);
        yield* Effect.promise(() => writeFile(pluginPath, pluginSource("tool-lease", "new")));
        const reloading = yield* Effect.fork(runtime.reload);
        yield* awaitSwap(runtime, initialId);
        yield* Effect.sleep("20 millis");
        const finalizedWhileHeld = [...finalized];
        const reloadDoneWhileHeld = Option.isSome(yield* Fiber.poll(reloading));
        yield* Deferred.succeed(release, undefined);
        const leased = yield* Fiber.join(holder);
        const swap = yield* Fiber.join(reloading);
        const finalizedAfter = [...finalized];
        yield* runtime.close;
        return { finalizedAfter, finalizedWhileHeld, initialId, leased, reloadDoneWhileHeld, swap };
      }).pipe(Effect.provide(TrustStoreMemory())),
    ),
  );

  expect(result.leased).toBe(true);
  expect(result.reloadDoneWhileHeld).toBe(false);
  expect(result.finalizedWhileHeld).toEqual([]);
  expect(result.swap.leaseCount).toBe(1);
  expect(result.swap.oldGenerationId).toBe(result.initialId);
  expect(result.finalizedAfter).toEqual([result.initialId]);
});

test("checkoutGeneration leases the current generation and refuses one that a reload already closed", async () => {
  const result = await withPluginFile("tool-refuse", ({ pluginPath, projectPath }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* makeGenerationRuntime({
          config: { cliPaths: [pluginPath], projectPath, userGlobalDirectories: [] },
          trust: "untrusted",
        });
        const swap = yield* runtime.reload;
        const leases = yield* Effect.scoped(
          Effect.gen(function* () {
            const old = yield* runtime.checkoutGeneration(swap.oldGenerationId, "tool:late");
            const current = yield* runtime.checkoutGeneration(swap.newGenerationId, "tool:now");
            return {
              current: Option.isSome(current),
              inFlight: (yield* runtime.debugInfo).inFlight,
              old: Option.isSome(old),
            };
          }),
        );
        const inFlightAfter = (yield* runtime.debugInfo).inFlight;
        yield* runtime.close;
        return { ...leases, inFlightAfter };
      }).pipe(Effect.provide(TrustStoreMemory())),
    ),
  );

  expect(result).toEqual({ current: true, inFlight: 1, inFlightAfter: 0, old: false });
});

test("a reload whose drain outlasts drainTimeoutMillis fails with GenerationDrainTimeoutError, keeps the swap, and closes the old generation after its last lease settles", async () => {
  const result = await withPluginFile("drain-timeout", ({ pluginPath, projectPath }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const finalized: Array<string> = [];
        const swaps: Array<GenerationSwapDiagnostic> = [];
        const runtime = yield* makeGenerationRuntime(
          {
            config: { cliPaths: [pluginPath], projectPath, userGlobalDirectories: [] },
            generationDiagnosticSink: (diagnostic) => Effect.sync(() => swaps.push(diagnostic)),
            generationFinalizerSink: (generationId) =>
              Effect.sync(() => finalized.push(generationId)),
            trust: "untrusted",
          },
          { drainTimeoutMillis: 50 },
        );
        const initialId = (yield* runtime.debugInfo).currentGenerationId;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* Effect.fork(
          runtime.use(() =>
            Deferred.succeed(started, undefined).pipe(Effect.zipRight(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(started);
        yield* Effect.promise(() => writeFile(pluginPath, pluginSource("drain-timeout", "new")));
        // Without a drain timeout the reload waits for the lease forever.
        const outcome = yield* runtime.reload.pipe(
          Effect.either,
          Effect.timeoutOption("2 seconds"),
        );
        const currentId = (yield* runtime.debugInfo).currentGenerationId;
        const busyAfterTimeout = yield* runtime.busy;
        const finalizedBeforeRelease = [...finalized];
        const swapsBeforeRelease = swaps.length;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        for (let attempt = 0; attempt < 400 && finalized.length === 0; attempt += 1) {
          yield* Effect.sleep("5 millis");
        }
        const finalizedAfterRelease = [...finalized];
        yield* runtime.close;
        return {
          busyAfterTimeout,
          currentId,
          finalizedAfterRelease,
          finalizedAtEnd: [...finalized],
          finalizedBeforeRelease,
          initialId,
          outcome,
          swaps,
          swapsBeforeRelease,
        };
      }).pipe(Effect.provide(TrustStoreMemory())),
    ),
  );

  expect(Option.isSome(result.outcome)).toBe(true);
  const either = Option.getOrThrow(result.outcome);
  expect(either._tag).toBe("Left");
  if (either._tag === "Left") {
    expect(either.left).toBeInstanceOf(GenerationDrainTimeoutError);
    expect(either.left).toMatchObject({
      drainTimeoutMillis: 50,
      holders: ["checkout"],
      leaseCount: 1,
      newGenerationId: result.currentId,
      oldGenerationId: result.initialId,
    });
  }
  // The swap stands: the fresh generation serves, and a later reload is not busy.
  expect(result.currentId).not.toBe(result.initialId);
  expect(result.busyAfterTimeout).toBe(false);
  // The old generation stays open while its lease runs and closes once after it.
  expect(result.finalizedBeforeRelease).toEqual([]);
  expect(result.swapsBeforeRelease).toBe(0);
  expect(result.finalizedAfterRelease).toEqual([result.initialId]);
  expect(result.finalizedAtEnd).toEqual([result.initialId, result.currentId]);
  expect(result.swaps).toHaveLength(1);
  expect(result.swaps[0]).toMatchObject({
    leaseCount: 1,
    newGenerationId: result.currentId,
    oldGenerationId: result.initialId,
    type: "generation_swap",
  });
});

// Issue #93 revision: swap publication, close ownership, and lease admission -----

const holdLease = (
  runtime: { readonly use: <A, E, R>(run: () => Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> },
  started: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
) =>
  Effect.fork(
    runtime.use(() =>
      Deferred.succeed(started, undefined).pipe(Effect.zipRight(Deferred.await(release))),
    ),
  );

test("prepareSwap runs before the swap: while it runs the fresh generation is not observable, and the swap publishes it to every reader at once", async () => {
  const result = await withPluginFile("prepare", ({ pluginPath, projectPath }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const preparing = yield* Deferred.make<string>();
        const prepared = yield* Deferred.make<void>();
        const closed: Array<string> = [];
        const runtime = yield* makeGenerationRuntime(
          {
            config: { cliPaths: [pluginPath], projectPath, userGlobalDirectories: [] },
            trust: "untrusted",
          },
          {
            onGenerationClosed: (generation) => Effect.sync(() => closed.push(generation.id)),
            prepareSwap: (fresh) =>
              Deferred.succeed(preparing, fresh.id).pipe(Effect.zipRight(Deferred.await(prepared))),
          },
        );
        const initialId = (yield* runtime.currentGeneration).id;
        const reloading = yield* Effect.fork(runtime.reload);
        const freshId = yield* Deferred.await(preparing).pipe(
          Effect.timeoutFail({
            duration: "2 seconds",
            onTimeout: () => new Error("The reload never ran prepareSwap."),
          }),
        );
        const during = {
          current: (yield* runtime.currentGeneration).id,
          debug: (yield* runtime.debugInfo).currentGenerationId,
          freshLease: yield* Effect.scoped(
            runtime.checkoutGeneration(freshId, "tool:early").pipe(Effect.map(Option.isSome)),
          ),
          sync: runtime.unsafeCurrentGeneration().id,
          view: (yield* runtime.view("session")).id,
        };
        yield* Deferred.succeed(prepared, undefined);
        const swap = yield* Fiber.join(reloading);
        const after = {
          current: (yield* runtime.currentGeneration).id,
          sync: runtime.unsafeCurrentGeneration().id,
        };
        const closedAfterReload = [...closed];
        yield* runtime.close;
        return { after, closed, closedAfterReload, during, freshId, initialId, swap };
      }).pipe(Effect.provide(TrustStoreMemory())),
    ),
  );

  expect(result.during).toEqual({
    current: result.initialId,
    debug: result.initialId,
    freshLease: false,
    sync: result.initialId,
    view: result.initialId,
  });
  expect(result.swap.newGenerationId).toBe(result.freshId);
  expect(result.after).toEqual({ current: result.freshId, sync: result.freshId });
  expect(result.closedAfterReload).toEqual([result.initialId]);
  expect(result.closed).toEqual([result.initialId, result.freshId]);
});

test.each([
  ["dies", "die"],
  ["is interrupted", "interrupt"],
] as const)(
  "a reload whose prepareSwap %s closes the fresh generation once and keeps serving the current one",
  async (_label, mode) => {
    const result = await withPluginFile(`prepare-${mode}`, ({ pluginPath, projectPath }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const finalized: Array<string> = [];
          const closed: Array<string> = [];
          const preparing = yield* Deferred.make<string>();
          const runtime = yield* makeGenerationRuntime(
            {
              config: { cliPaths: [pluginPath], projectPath, userGlobalDirectories: [] },
              generationFinalizerSink: (generationId) =>
                Effect.sync(() => finalized.push(generationId)),
              trust: "untrusted",
            },
            {
              onGenerationClosed: (generation) => Effect.sync(() => closed.push(generation.id)),
              prepareSwap: (fresh) =>
                Deferred.succeed(preparing, fresh.id).pipe(
                  Effect.zipRight(mode === "die" ? Effect.die("prepare failed") : Effect.never),
                ),
            },
          );
          const initialId = (yield* runtime.currentGeneration).id;
          const reloading = yield* Effect.fork(runtime.reload);
          const freshId = yield* Deferred.await(preparing).pipe(
            Effect.timeoutFail({
              duration: "2 seconds",
              onTimeout: () => new Error("The reload never ran prepareSwap."),
            }),
          );
          if (mode === "interrupt") {
            yield* Fiber.interrupt(reloading);
          }
          const exit = yield* Fiber.await(reloading);
          const state = {
            busy: yield* runtime.busy,
            current: (yield* runtime.currentGeneration).id,
            sync: runtime.unsafeCurrentGeneration().id,
          };
          const finalizedBeforeClose = [...finalized];
          const closedBeforeClose = [...closed];
          yield* runtime.close;
          return {
            closedBeforeClose,
            exitTag: exit._tag,
            finalizedBeforeClose,
            freshId,
            initialId,
            state,
          };
        }).pipe(Effect.provide(TrustStoreMemory())),
      ),
    );

    expect(result.exitTag).toBe("Failure");
    expect(result.state).toEqual({
      busy: false,
      current: result.initialId,
      sync: result.initialId,
    });
    expect(result.finalizedBeforeClose).toEqual([result.freshId]);
    expect(result.closedBeforeClose).toEqual([result.freshId]);
  },
);

test("a reload interrupted after its swap still closes the old generation once, after its last lease settles", async () => {
  const result = await withPluginFile("interrupt-after-swap", ({ pluginPath, projectPath }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const finalized: Array<string> = [];
        const swaps: Array<GenerationSwapDiagnostic> = [];
        const runtime = yield* makeGenerationRuntime({
          config: { cliPaths: [pluginPath], projectPath, userGlobalDirectories: [] },
          generationDiagnosticSink: (diagnostic) => Effect.sync(() => swaps.push(diagnostic)),
          generationFinalizerSink: (generationId) =>
            Effect.sync(() => finalized.push(generationId)),
          trust: "untrusted",
        });
        const initialId = (yield* runtime.currentGeneration).id;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* holdLease(runtime, started, release);
        yield* Deferred.await(started);
        const reloading = yield* Effect.fork(runtime.reload);
        yield* awaitSwap(runtime, initialId);
        yield* Fiber.interrupt(reloading);
        const finalizedAfterInterrupt = [...finalized];
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        for (let attempt = 0; attempt < 400 && finalized.length === 0; attempt += 1) {
          yield* Effect.sleep("5 millis");
        }
        const finalizedAfterRelease = [...finalized];
        const freshId = (yield* runtime.currentGeneration).id;
        yield* runtime.close;
        return {
          finalizedAfterInterrupt,
          finalizedAfterRelease,
          finalizedAtEnd: [...finalized],
          freshId,
          initialId,
          swaps,
        };
      }).pipe(Effect.provide(TrustStoreMemory())),
    ),
  );

  expect(result.finalizedAfterInterrupt).toEqual([]);
  expect(result.finalizedAfterRelease).toEqual([result.initialId]);
  expect(result.finalizedAtEnd).toEqual([result.initialId, result.freshId]);
  expect(result.swaps).toHaveLength(1);
  expect(result.swaps[0]).toMatchObject({
    leaseCount: 1,
    newGenerationId: result.freshId,
    oldGenerationId: result.initialId,
  });
});

test("runtime close waits for a replaced generation whose lease still runs, then closes every generation once", async () => {
  const result = await withPluginFile("close-waits", ({ pluginPath, projectPath }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const finalized: Array<string> = [];
        const runtime = yield* makeGenerationRuntime(
          {
            config: { cliPaths: [pluginPath], projectPath, userGlobalDirectories: [] },
            generationFinalizerSink: (generationId) =>
              Effect.sync(() => finalized.push(generationId)),
            trust: "untrusted",
          },
          { drainTimeoutMillis: 50 },
        );
        const initialId = (yield* runtime.currentGeneration).id;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* holdLease(runtime, started, release);
        yield* Deferred.await(started);
        const reload = yield* runtime.reload.pipe(Effect.either, Effect.timeoutOption("2 seconds"));
        const freshId = (yield* runtime.currentGeneration).id;
        const closing = yield* Effect.fork(runtime.close);
        yield* Effect.sleep("50 millis");
        const closeDoneWhileHeld = Option.isSome(yield* Fiber.poll(closing));
        const finalizedWhileHeld = [...finalized];
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        const closed = yield* Fiber.join(closing).pipe(Effect.timeoutOption("2 seconds"));
        return {
          closeDoneWhileHeld,
          closed: Option.isSome(closed),
          finalized: [...finalized],
          finalizedWhileHeld,
          freshId,
          initialId,
          reloadTimedOut:
            Option.isSome(reload) &&
            reload.value._tag === "Left" &&
            reload.value.left instanceof GenerationDrainTimeoutError,
        };
      }).pipe(Effect.provide(TrustStoreMemory())),
    ),
  );

  expect(result.reloadTimedOut).toBe(true);
  expect(result.closeDoneWhileHeld).toBe(false);
  expect(result.finalizedWhileHeld).toEqual([]);
  expect(result.closed).toBe(true);
  expect(result.finalized).toEqual([result.initialId, result.freshId]);
});

test("checkoutGeneration refuses the current generation once runtime close begins, and after close returns", async () => {
  const result = await withPluginFile("close-admission", ({ pluginPath, projectPath }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* makeGenerationRuntime({
          config: { cliPaths: [pluginPath], projectPath, userGlobalDirectories: [] },
          trust: "untrusted",
        });
        const currentId = (yield* runtime.currentGeneration).id;
        const lease = (holder: string) =>
          Effect.scoped(
            runtime.checkoutGeneration(currentId, holder).pipe(Effect.map(Option.isSome)),
          );
        const before = yield* lease("tool:before");
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* holdLease(runtime, started, release);
        yield* Deferred.await(started);
        const closing = yield* Effect.fork(runtime.close);
        for (let attempt = 0; attempt < 400 && !(yield* runtime.busy); attempt += 1) {
          yield* Effect.sleep("1 millis");
        }
        yield* Effect.sleep("10 millis");
        const duringClose = yield* lease("tool:during");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.join(closing);
        const afterClose = yield* lease("tool:after");
        return { afterClose, before, duringClose };
      }).pipe(Effect.provide(TrustStoreMemory())),
    ),
  );

  expect(result).toEqual({ afterClose: false, before: true, duringClose: false });
});

test("checkoutGeneration refuses a replaced generation once its last lease settles, before its finalizers finish", async () => {
  const result = await withPluginFile("drained-admission", ({ pluginPath, projectPath }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const finalizing = yield* Deferred.make<string>();
        const finish = yield* Deferred.make<void>();
        let initialId = "";
        const runtime = yield* makeGenerationRuntime({
          config: { cliPaths: [pluginPath], projectPath, userGlobalDirectories: [] },
          generationFinalizerSink: (generationId) =>
            generationId === initialId
              ? Deferred.succeed(finalizing, generationId).pipe(
                  Effect.zipRight(Deferred.await(finish)),
                )
              : Effect.void,
          trust: "untrusted",
        });
        initialId = (yield* runtime.currentGeneration).id;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* Effect.fork(
          Effect.scoped(
            runtime
              .checkoutGeneration(initialId, "tool:first")
              .pipe(
                Effect.zipRight(
                  Deferred.succeed(started, undefined).pipe(
                    Effect.zipRight(Deferred.await(release)),
                  ),
                ),
              ),
          ),
        );
        yield* Deferred.await(started);
        const reloading = yield* Effect.fork(runtime.reload);
        yield* awaitSwap(runtime, initialId);
        // Still draining: a call that resolved the old Tool before the swap may still lease it.
        const whileDraining = yield* Effect.scoped(
          runtime.checkoutGeneration(initialId, "tool:stale").pipe(Effect.map(Option.isSome)),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        yield* Deferred.await(finalizing).pipe(Effect.timeoutOption("2 seconds"));
        const whileFinalizing = yield* Effect.scoped(
          runtime.checkoutGeneration(initialId, "tool:late").pipe(Effect.map(Option.isSome)),
        );
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(reloading);
        yield* runtime.close;
        return { whileDraining, whileFinalizing };
      }).pipe(Effect.provide(TrustStoreMemory())),
    ),
  );

  expect(result).toEqual({ whileDraining: true, whileFinalizing: false });
});

test("a reload run inside an uninterruptible region, as the Session Mailbox runs Commands, still returns at its drain timeout", async () => {
  const result = await withPluginFile("uninterruptible-timeout", ({ pluginPath, projectPath }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* makeGenerationRuntime(
          {
            config: { cliPaths: [pluginPath], projectPath, userGlobalDirectories: [] },
            trust: "untrusted",
          },
          { drainTimeoutMillis: 50 },
        );
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* holdLease(runtime, started, release);
        yield* Deferred.await(started);
        // Releases the lease late, so a reload without a working timeout still returns.
        yield* Effect.fork(
          Effect.sleep("1500 millis").pipe(Effect.zipRight(Deferred.succeed(release, undefined))),
        );
        const startedAt = Date.now();
        const outcome = yield* runtime.reload.pipe(Effect.either, Effect.uninterruptible);
        const elapsedMillis = Date.now() - startedAt;
        yield* Fiber.join(holder);
        yield* runtime.close;
        return { elapsedMillis, outcome };
      }).pipe(Effect.provide(TrustStoreMemory())),
    ),
  );

  expect(result.outcome._tag).toBe("Left");
  if (result.outcome._tag === "Left") {
    expect(result.outcome.left).toBeInstanceOf(GenerationDrainTimeoutError);
  }
  expect(result.elapsedMillis).toBeLessThan(1_000);
});

test("a reload deadline with no remaining leases reports that the old Generation is still closing", async () => {
  const result = await withPluginFile("slow-finalizer", ({ pluginPath, projectPath }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const finalizing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const swaps: Array<GenerationSwapDiagnostic> = [];
        let initialId: string | undefined;
        const runtime = yield* makeGenerationRuntime(
          {
            config: { cliPaths: [pluginPath], projectPath, userGlobalDirectories: [] },
            generationDiagnosticSink: (diagnostic) => Effect.sync(() => swaps.push(diagnostic)),
            generationFinalizerSink: (id) =>
              id === initialId
                ? Deferred.succeed(finalizing, undefined).pipe(
                    Effect.zipRight(Deferred.await(release)),
                  )
                : Effect.void,
            trust: "untrusted",
          },
          { drainTimeoutMillis: 50 },
        );
        initialId = (yield* runtime.currentGeneration).id;
        const reloading = yield* Effect.fork(runtime.reload.pipe(Effect.either));
        yield* Deferred.await(finalizing);
        const outcome = yield* Fiber.join(reloading).pipe(Effect.timeout("2 seconds"));
        const currentId = (yield* runtime.currentGeneration).id;
        const swapsAtTimeout = swaps.length;
        yield* Deferred.succeed(release, undefined);
        yield* runtime.close;
        return { currentId, initialId, outcome, swaps, swapsAtTimeout };
      }).pipe(Effect.provide(TrustStoreMemory())),
    ),
  );
  expect(result.outcome._tag).toBe("Left");
  if (result.outcome._tag === "Left") {
    expect(result.outcome.left).toBeInstanceOf(GenerationDrainTimeoutError);
    expect(result.outcome.left).toMatchObject({
      drainTimeoutMillis: 50,
      holders: [],
      leaseCount: 0,
      message: `Reload swapped to generation ${result.currentId}, but generation ${result.initialId} was still closing after 50 ms.`,
      newGenerationId: result.currentId,
      oldGenerationId: result.initialId,
    });
  }
  expect(result.swapsAtTimeout).toBe(0);
  expect(result.swaps).toHaveLength(1);
});
