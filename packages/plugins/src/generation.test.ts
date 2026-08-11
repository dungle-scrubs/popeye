import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionIdSchema } from "@peye/journal";
import { Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Tracer } from "effect";
import { expect, test } from "vitest";

import { createCapabilityGrants } from "./capability.js";
import type { GenerationSwapDiagnostic } from "./generation.js";
import { loadGeneration, makePluginRuntime } from "./generation.js";
import { InstructionFragmentContributionKind } from "./registry.js";
import { TrustStoreMemory } from "./trust.js";

const grants = createCapabilityGrants(
  Schema.decodeSync(SessionIdSchema)("generation-test-session"),
);

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

test("two-phase loading never imports project-local code on the untrusted path", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-generation-untrusted-"));
  const projectPath = join(root, "project");
  const projectPluginDirectory = join(projectPath, ".peye", "plugins");
  const markerPath = join(root, "project-plugin-imported");
  const externalPath = join(root, "external-plugin.ts");

  try {
    await mkdir(projectPluginDirectory, { recursive: true });
    await writeFile(externalPath, pluginSource("external-plugin", "external"));
    await writeFile(
      join(projectPluginDirectory, "local-plugin.ts"),
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(markerPath)}, 'imported');`,
        pluginSource("local-plugin", "local"),
      ].join("\n"),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const generation = yield* loadGeneration({
          config: {
            cliPaths: [externalPath],
            projectPath,
            userGlobalDirectories: [],
          },
          trust: "untrusted",
        });
        const contributions = yield* generation.registry.list(
          InstructionFragmentContributionKind,
          grants,
        );
        yield* generation.close;
        return { contributions, plugins: generation.plugins };
      }).pipe(Effect.provide(TrustStoreMemory())),
    );

    expect(result.plugins.map((plugin) => plugin.name)).toEqual(["external-plugin"]);
    expect(result.contributions.map((contribution) => contribution.key)).toEqual([
      "external-plugin/external-plugin",
    ]);
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("reload swaps the generation and work admitted after the swap uses only the new generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-generation-swap-"));
  const projectPath = join(root, "project");
  const pluginPath = join(root, "external-plugin.ts");

  try {
    await mkdir(projectPath, { recursive: true });
    await writeFile(pluginPath, pluginSource("reload-plugin", "old"));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* makePluginRuntime({
          config: { cliPaths: [pluginPath], projectPath, userGlobalDirectories: [] },
          trust: "untrusted",
        });
        const before = yield* runtime.use((generation) =>
          generation.registry.list(InstructionFragmentContributionKind, grants).pipe(
            Effect.map((contributions) => ({
              content: contributions[0]?.payload.content,
              generationId: generation.id,
            })),
          ),
        );
        yield* Effect.promise(() => writeFile(pluginPath, pluginSource("reload-plugin", "new")));
        yield* runtime.reload;
        const after = yield* runtime.use((generation) =>
          generation.registry.list(InstructionFragmentContributionKind, grants).pipe(
            Effect.map((contributions) => ({
              content: contributions[0]?.payload.content,
              generationId: generation.id,
            })),
          ),
        );
        yield* runtime.close;
        return { after, before };
      }).pipe(Effect.provide(TrustStoreMemory())),
    );

    expect(result.before.content).toBe("old");
    expect(result.after.content).toBe("new");
    expect(result.after.generationId).not.toBe(result.before.generationId);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("in-flight work finishes on its old generation after reload swaps to the new generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-generation-in-flight-"));
  const projectPath = join(root, "project");
  const pluginPath = join(root, "external-plugin.ts");

  try {
    await mkdir(projectPath, { recursive: true });
    await writeFile(pluginPath, pluginSource("drain-plugin", "old"));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* makePluginRuntime({
          config: { cliPaths: [pluginPath], projectPath, userGlobalDirectories: [] },
          trust: "untrusted",
        });
        const initial = yield* runtime.debugInfo;
        const oldStarted = yield* Deferred.make<void>();
        const releaseOld = yield* Deferred.make<void>();
        const oldFiber = yield* Effect.fork(
          runtime.use((generation) =>
            Deferred.succeed(oldStarted, undefined).pipe(
              Effect.zipRight(Deferred.await(releaseOld)),
              Effect.as(generation.id),
            ),
          ),
        );
        yield* Deferred.await(oldStarted);
        yield* Effect.promise(() => writeFile(pluginPath, pluginSource("drain-plugin", "new")));
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
        const newWorkGenerationId = yield* runtime.use((generation) =>
          Effect.succeed(generation.id),
        );
        yield* Deferred.succeed(releaseOld, undefined);
        const oldWorkGenerationId = yield* Fiber.join(oldFiber);
        const diagnostic = yield* Fiber.join(reloadFiber);
        yield* runtime.close;
        return { diagnostic, initial, newWorkGenerationId, oldWorkGenerationId };
      }).pipe(Effect.provide(TrustStoreMemory())),
    );

    expect(result.oldWorkGenerationId).toBe(result.initial.currentGenerationId);
    expect(result.newWorkGenerationId).toBe(result.diagnostic.newGenerationId);
    expect(result.newWorkGenerationId).not.toBe(result.oldWorkGenerationId);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the old generation Scope closes exactly once after its last in-flight work settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-generation-scope-close-"));
  const projectPath = join(root, "project");
  const pluginPath = join(root, "external-plugin.ts");

  try {
    await mkdir(projectPath, { recursive: true });
    await writeFile(pluginPath, pluginSource("scope-plugin", "old"));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* makePluginRuntime({
          config: { cliPaths: [pluginPath], projectPath, userGlobalDirectories: [] },
          trust: "untrusted",
        });
        const initial = yield* runtime.debugInfo;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const workFiber = yield* Effect.fork(
          runtime.use(() =>
            Deferred.succeed(started, undefined).pipe(Effect.zipRight(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(started);
        yield* Effect.promise(() => writeFile(pluginPath, pluginSource("scope-plugin", "new")));
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
        const beforeSettle = yield* Fiber.poll(reloadFiber);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(workFiber);
        const diagnostic = yield* Fiber.join(reloadFiber);
        yield* runtime.close;
        return { beforeSettle, diagnostic };
      }).pipe(Effect.provide(TrustStoreMemory())),
    );

    expect(Option.isNone(result.beforeSettle)).toBe(true);
    expect(result.diagnostic.closedResources).toBe(1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("reload is serialized and cannot import a new generation during a running gate hook", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-generation-serialized-"));
  const projectPath = join(root, "project");
  const pluginPath = join(root, "external-plugin.ts");
  const reloadImportMarker = join(root, "reload-imported");

  try {
    await mkdir(projectPath, { recursive: true });
    await writeFile(pluginPath, pluginSource("gate-plugin", "old"));

    const markerWasAbsent = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* makePluginRuntime({
          config: { cliPaths: [pluginPath], projectPath, userGlobalDirectories: [] },
          trust: "untrusted",
        });
        const gateStarted = yield* Deferred.make<void>();
        const releaseGate = yield* Deferred.make<void>();
        const gateFiber = yield* Effect.fork(
          runtime.useSerialized(() =>
            Deferred.succeed(gateStarted, undefined).pipe(
              Effect.zipRight(Deferred.await(releaseGate)),
            ),
          ),
        );
        yield* Deferred.await(gateStarted);
        yield* Effect.promise(() =>
          writeFile(
            pluginPath,
            [
              'import { writeFileSync } from "node:fs";',
              `writeFileSync(${JSON.stringify(reloadImportMarker)}, 'imported');`,
              pluginSource("gate-plugin", "new"),
            ].join("\n"),
          ),
        );
        const reloadFiber = yield* Effect.fork(runtime.reload);
        yield* Effect.sleep("10 millis");
        const absent = yield* Effect.promise(() =>
          access(reloadImportMarker).then(
            () => false,
            () => true,
          ),
        );
        yield* Deferred.succeed(releaseGate, undefined);
        yield* Fiber.join(gateFiber);
        yield* Fiber.join(reloadFiber);
        yield* runtime.close;
        return absent;
      }).pipe(Effect.provide(TrustStoreMemory())),
    );

    expect(markerWasAbsent).toBe(true);
    await expect(access(reloadImportMarker)).resolves.toBeUndefined();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("generation-swap diagnostics and the plugins.reload span report ids, drain, resources, and Plugin changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-generation-observability-"));
  const projectPath = join(root, "project");
  const pluginDirectory = join(projectPath, ".peye", "plugins");
  const keptPath = join(pluginDirectory, "kept.ts");
  const removedPath = join(pluginDirectory, "removed.ts");
  const addedPath = join(pluginDirectory, "added.ts");
  const diagnostics: Array<GenerationSwapDiagnostic> = [];
  const spans: Array<CapturedSpan> = [];

  try {
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(keptPath, pluginSource("kept-plugin", "old"));
    await writeFile(removedPath, pluginSource("removed-plugin", "removed"));

    const returned = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* makePluginRuntime({
          config: { cliPaths: [], projectPath, userGlobalDirectories: [] },
          generationDiagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
          trust: "trusted",
        });
        yield* Effect.promise(() => writeFile(keptPath, pluginSource("kept-plugin", "new")));
        yield* Effect.promise(() => rm(removedPath));
        yield* Effect.promise(() => writeFile(addedPath, pluginSource("added-plugin", "added")));
        const diagnostic = yield* runtime.reload;
        yield* runtime.close;
        return diagnostic;
      }).pipe(Effect.provide(TrustStoreMemory()), Effect.provide(tracerLayer(spans))),
    );

    expect(diagnostics).toEqual([returned]);
    expect(returned).toMatchObject({
      closedResources: 1,
      drainDurationMillis: expect.any(Number),
      newGenerationId: expect.any(String),
      oldGenerationId: expect.any(String),
      pluginsAdded: ["added-plugin"],
      pluginsRemoved: ["removed-plugin"],
      pluginsReplaced: ["kept-plugin"],
      type: "generation_swap",
    });
    const reloadSpan = spans.find((span) => span.name === "plugins.reload");
    expect(reloadSpan).toBeDefined();
    expect(Object.fromEntries(reloadSpan?.attributes ?? [])).toMatchObject({
      closedResources: 1,
      newGenerationId: returned.newGenerationId,
      oldGenerationId: returned.oldGenerationId,
    });
    expect(reloadSpan?.exit !== undefined && Exit.isSuccess(reloadSpan.exit)).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("generation reload passes a 120-iteration admission, interruption, swap, and drain race", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-generation-race-"));
  const projectPath = join(root, "project");
  const pluginPath = join(root, "external-plugin.ts");

  try {
    await mkdir(projectPath, { recursive: true });
    await writeFile(pluginPath, pluginSource("race-plugin", "0"));

    const iterations = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* makePluginRuntime({
          config: { cliPaths: [pluginPath], projectPath, userGlobalDirectories: [] },
          generationDiagnosticSink: () => Effect.void,
          trust: "untrusted",
          trustDiagnosticSink: () => Effect.void,
        });
        for (let iteration = 1; iteration <= 120; iteration += 1) {
          const initial = yield* runtime.debugInfo;
          const release = yield* Deferred.make<void>();
          const firstStarted = yield* Deferred.make<string>();
          const secondStarted = yield* Deferred.make<string>();
          const firstFiber = yield* Effect.fork(
            runtime.use((generation) =>
              Deferred.succeed(firstStarted, generation.id).pipe(
                Effect.zipRight(Deferred.await(release)),
                Effect.as(generation.id),
              ),
            ),
          );
          const secondFiber = yield* Effect.fork(
            runtime.use((generation) =>
              Deferred.succeed(secondStarted, generation.id).pipe(
                Effect.zipRight(Deferred.await(release)),
                Effect.as(generation.id),
              ),
            ),
          );
          const oldIds = yield* Effect.all([
            Deferred.await(firstStarted),
            Deferred.await(secondStarted),
          ]);
          yield* Effect.promise(() =>
            writeFile(pluginPath, pluginSource("race-plugin", String(iteration))),
          );
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
          const newId = yield* runtime.use((generation) => Effect.succeed(generation.id));
          if (iteration % 2 === 0) {
            yield* Fiber.interrupt(firstFiber);
          }
          yield* Deferred.succeed(release, undefined);
          yield* Effect.all([Fiber.await(firstFiber), Fiber.await(secondFiber)]);
          const diagnostic = yield* Fiber.join(reloadFiber);
          expect(oldIds).toEqual([initial.currentGenerationId, initial.currentGenerationId]);
          expect(newId).toBe(diagnostic.newGenerationId);
          expect(diagnostic.closedResources).toBe(1);
        }
        yield* runtime.close;
        return 120;
      }).pipe(Effect.provide(TrustStoreMemory())),
    );

    expect(iterations).toBe(120);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 20_000);

test("unsupported syntax and build failures during reload leave the old generation intact", async () => {
  const root = await mkdtemp(join(tmpdir(), ".loader-generation-atomic-"));
  const projectPath = join(root, "project");
  const pluginPath = join(root, "external-plugin.ts");

  try {
    await mkdir(projectPath, { recursive: true });
    await writeFile(pluginPath, pluginSource("atomic-plugin", "old"));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* makePluginRuntime({
          config: { cliPaths: [pluginPath], projectPath, userGlobalDirectories: [] },
          generationDiagnosticSink: () => Effect.void,
          trust: "untrusted",
          trustDiagnosticSink: () => Effect.void,
        });
        const initial = yield* runtime.debugInfo;
        yield* Effect.promise(() =>
          writeFile(
            pluginPath,
            [
              "enum ReloadMode { New }",
              "void ReloadMode.New;",
              pluginSource("atomic-plugin", "enum"),
            ].join("\n"),
          ),
        );
        const syntaxError = yield* Effect.flip(runtime.reload);
        const afterSyntax = yield* runtime.debugInfo;
        yield* Effect.promise(() =>
          writeFile(pluginPath, "export default () => { throw new Error('build exploded'); };\n"),
        );
        const buildError = yield* Effect.flip(runtime.reload);
        const afterBuild = yield* runtime.debugInfo;
        const contributions = yield* runtime.use((generation) =>
          generation.registry.list(InstructionFragmentContributionKind, grants),
        );
        yield* runtime.close;
        return { afterBuild, afterSyntax, buildError, contributions, initial, syntaxError };
      }).pipe(Effect.provide(TrustStoreMemory())),
    );

    expect(result.syntaxError).toMatchObject({ cause: "unsupported_syntax" });
    expect(result.buildError).toMatchObject({ cause: "build_failed" });
    expect(result.afterSyntax.currentGenerationId).toBe(result.initial.currentGenerationId);
    expect(result.afterBuild.currentGenerationId).toBe(result.initial.currentGenerationId);
    expect(result.contributions[0]?.payload.content).toBe("old");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a Trust resolver runs after user-global Plugins load and before trusted project-local Plugins load", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-generation-trust-resolver-"));
  const projectPath = join(root, "project");
  const projectPluginDirectory = join(projectPath, ".peye", "plugins");
  const userGlobalDirectory = join(root, "user-plugins");
  const externalMarker = join(root, "external-imported");
  const projectMarker = join(root, "project-imported");

  try {
    await mkdir(projectPluginDirectory, { recursive: true });
    await mkdir(userGlobalDirectory, { recursive: true });
    await writeFile(
      join(userGlobalDirectory, "external.ts"),
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(externalMarker)}, 'imported');`,
        pluginSource("user-plugin", "external"),
      ].join("\n"),
    );
    await writeFile(
      join(projectPluginDirectory, "project.ts"),
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(projectMarker)}, 'imported');`,
        pluginSource("project-plugin", "project"),
      ].join("\n"),
    );

    const names = await Effect.runPromise(
      Effect.gen(function* () {
        const generation = yield* loadGeneration({
          config: { cliPaths: [], projectPath, userGlobalDirectories: [userGlobalDirectory] },
          trust: () =>
            Effect.promise(async () => {
              await access(externalMarker);
              await access(projectMarker).then(
                () => Promise.reject(new Error("project Plugin imported before Trust")),
                () => undefined,
              );
              return "trusted" as const;
            }),
        });
        const loadedNames = generation.plugins.map((plugin) => plugin.name);
        yield* generation.close;
        return loadedNames;
      }).pipe(Effect.provide(TrustStoreMemory())),
    );

    expect(names).toEqual(["user-plugin", "project-plugin"]);
    await expect(access(projectMarker)).resolves.toBeUndefined();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
