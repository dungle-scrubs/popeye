import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Deferred, Effect, Fiber } from "effect";
import { expect, test } from "vitest";
import { GenerationBusyError, makeGenerationRuntime } from "./generation-runtime.js";
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
  const root = await mkdtemp(join(tmpdir(), "peye-gen-runtime-ref-"));
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
  const root = await mkdtemp(join(tmpdir(), "peye-gen-runtime-fakeclock-"));
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
  const root = await mkdtemp(join(tmpdir(), "peye-gen-runtime-busy-"));
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
