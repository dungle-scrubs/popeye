import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionIdSchema } from "@peye/journal";
import { Effect, Exit, Layer, Schema, Tracer } from "effect";
import { expect, test } from "vitest";

import { createCapabilityGrants } from "./capability.js";
import { defineHookContribution } from "./contribution.js";
import { HookEmitter, HookEmitterLive } from "./emitter.js";
import { ContributionRegistry, ContributionRegistryLive } from "./registry.js";
import { checkTrust, recordDecision, TrustStoreLive, TrustStoreMemory } from "./trust.js";

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

test("a Trust decision records a digest of sorted project Plugin files", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-plugin-trust-digest-"));
  const projectPath = join(root, "project");
  const pluginDirectory = join(projectPath, ".peye", "plugins");

  try {
    await mkdir(join(pluginDirectory, "nested"), { recursive: true });
    await writeFile(join(pluginDirectory, "z.ts"), "export const z = 1;\n");
    await writeFile(join(pluginDirectory, "nested", "a.ts"), "export const a = 2;\n");

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const initial = yield* checkTrust(projectPath);
        if (initial.kind !== "prompt_required") {
          return yield* Effect.dieMessage(`Expected prompt_required, got ${initial.kind}.`);
        }
        const record = yield* recordDecision(projectPath, "trusted", initial.currentDigest);
        return { initial, record };
      }).pipe(Effect.provide(TrustStoreMemory())),
    );

    expect(result.record).toMatchObject({
      decision: "trusted",
      digest: result.initial.currentDigest,
      projectPath: await realpath(projectPath),
    });
    expect(result.record.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.record.digest).toMatch(/^[a-f\d]{64}$/);
    expect(result.record.files.map((file) => file.path)).toEqual(["nested/a.ts", "z.ts"]);
    expect(result.record.files.every((file) => /^[a-f\d]{64}$/.test(file.digest))).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("an unchanged digest returns the recorded Trust decision without a re-prompt after store reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-plugin-trust-unchanged-"));
  const projectPath = join(root, "project");
  const pluginDirectory = join(projectPath, ".peye", "plugins");
  const storePath = join(root, "settings", "trust.json");

  try {
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(join(pluginDirectory, "plugin.ts"), "export const stable = true;\n");

    await Effect.runPromise(
      Effect.gen(function* () {
        const initial = yield* checkTrust(projectPath);
        if (initial.kind !== "prompt_required") {
          return yield* Effect.dieMessage(`Expected prompt_required, got ${initial.kind}.`);
        }
        yield* recordDecision(projectPath, "untrusted", initial.currentDigest);
      }).pipe(Effect.provide(TrustStoreLive({ path: storePath }))),
    );
    const reopened = await Effect.runPromise(
      checkTrust(projectPath).pipe(Effect.provide(TrustStoreLive({ path: storePath }))),
    );

    expect(reopened).toEqual({ kind: "untrusted" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a changed digest requires a re-prompt with added, removed, and modified Plugin files", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-plugin-trust-changed-"));
  const projectPath = join(root, "project");
  const pluginDirectory = join(projectPath, ".peye", "plugins");

  try {
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(join(pluginDirectory, "modified.ts"), "export const value = 1;\n");
    await writeFile(join(pluginDirectory, "removed.ts"), "export const removed = true;\n");

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const initial = yield* checkTrust(projectPath);
        if (initial.kind !== "prompt_required") {
          return yield* Effect.dieMessage(`Expected prompt_required, got ${initial.kind}.`);
        }
        yield* recordDecision(projectPath, "trusted", initial.currentDigest);
        yield* Effect.promise(() =>
          writeFile(join(pluginDirectory, "modified.ts"), "export const value = 2;\n"),
        );
        yield* Effect.promise(() => rm(join(pluginDirectory, "removed.ts")));
        yield* Effect.promise(() =>
          writeFile(join(pluginDirectory, "added.ts"), "export const added = true;\n"),
        );
        return yield* checkTrust(projectPath);
      }).pipe(Effect.provide(TrustStoreMemory())),
    );

    expect(result).toEqual({
      changeSummary: {
        added: ["added.ts"],
        modified: ["modified.ts"],
        removed: ["removed.ts"],
      },
      currentDigest: expect.stringMatching(/^[a-f\d]{64}$/),
      kind: "reprompt_required",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a phase-1 Trust hook can replace a prompt result with a digest-bound decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-plugin-trust-hook-"));
  const projectPath = join(root, "project");
  const pluginDirectory = join(projectPath, ".peye", "plugins");
  const registryLayer = ContributionRegistryLive();
  const layer = Layer.mergeAll(
    TrustStoreMemory(),
    registryLayer,
    HookEmitterLive().pipe(Layer.provide(registryLayer)),
  );
  let hookCalls = 0;

  try {
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(join(pluginDirectory, "plugin.ts"), "export const local = true;\n");

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const emitter = yield* HookEmitter;
        const registry = yield* ContributionRegistry;
        yield* registry.registerPlugin(
          { capabilities: [], name: "trust-policy", version: "1.0.0" },
          [
            defineHookContribution({
              mergeClass: "FirstWins",
              name: "approve-project",
              point: "trust",
              run: () =>
                Effect.sync(() => {
                  hookCalls += 1;
                  return {
                    decision: "replace" as const,
                    value: { decision: "trusted" as const },
                  };
                }),
            }),
          ],
        );
        const grants = createCapabilityGrants(
          Schema.decodeSync(SessionIdSchema)("trust-hook-session"),
        );
        const first = yield* checkTrust(projectPath, { grants, hookEmitter: emitter });
        const second = yield* checkTrust(projectPath, { grants, hookEmitter: emitter });
        return { first, second };
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toEqual({ first: { kind: "trusted" }, second: { kind: "trusted" } });
    expect(hookCalls).toBe(1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Trust checks emit structured diagnostics and a plugins.trust span", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-plugin-trust-observability-"));
  const projectPath = join(root, "project");
  const pluginDirectory = join(projectPath, ".peye", "plugins");
  const diagnostics: Array<unknown> = [];
  const spans: Array<CapturedSpan> = [];

  try {
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(join(pluginDirectory, "plugin.ts"), "export const value = 1;\n");

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const initial = yield* checkTrust(projectPath, {
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
        });
        if (initial.kind !== "prompt_required") {
          return yield* Effect.dieMessage(`Expected prompt_required, got ${initial.kind}.`);
        }
        yield* recordDecision(projectPath, "trusted", initial.currentDigest);
        yield* Effect.promise(() =>
          writeFile(join(pluginDirectory, "plugin.ts"), "export const value = 2;\n"),
        );
        return yield* checkTrust(projectPath, {
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
        });
      }).pipe(Effect.provide(Layer.merge(TrustStoreMemory(), tracerLayer(spans)))),
    );
    if (result.kind !== "reprompt_required") {
      throw new Error(`Expected reprompt_required, got ${result.kind}.`);
    }
    const canonicalProjectPath = await realpath(projectPath);

    expect(diagnostics.at(-1)).toEqual({
      changeSummary: { added: [], modified: ["plugin.ts"], removed: [] },
      decision: "reprompt_required",
      digest: result.currentDigest,
      projectPath: canonicalProjectPath,
      scope: "project-local",
      type: "trust_decision",
    });
    expect(spans.map((span) => span.name)).toEqual(["plugins.trust", "plugins.trust"]);
    expect(Object.fromEntries(spans.at(-1)?.attributes ?? [])).toMatchObject({
      changeSummary: JSON.stringify({ added: [], modified: ["plugin.ts"], removed: [] }),
      decision: "reprompt_required",
      digest: result.currentDigest,
      projectPath: canonicalProjectPath,
      scope: "project-local",
    });
    expect(spans.every((span) => span.exit !== undefined && Exit.isSuccess(span.exit))).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("digest binding follows in-tree Plugin symlinks and ignores symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-plugin-trust-symlinks-"));
  const projectPath = join(root, "project");
  const pluginDirectory = join(projectPath, ".peye", "plugins");
  const inTreeTarget = join(projectPath, "shared-plugin.ts");
  const outsideTarget = join(root, "outside-plugin.ts");

  try {
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(inTreeTarget, "export const shared = 1;\n");
    await writeFile(outsideTarget, "export const outside = 1;\n");
    await symlink(inTreeTarget, join(pluginDirectory, "linked.ts"));
    await symlink(outsideTarget, join(pluginDirectory, "escaped.ts"));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const initial = yield* checkTrust(projectPath);
        if (initial.kind !== "prompt_required") {
          return yield* Effect.dieMessage(`Expected prompt_required, got ${initial.kind}.`);
        }
        yield* recordDecision(projectPath, "trusted", initial.currentDigest);
        yield* Effect.promise(() => writeFile(outsideTarget, "export const outside = 2;\n"));
        const afterEscapeChanged = yield* checkTrust(projectPath);
        yield* Effect.promise(() => writeFile(inTreeTarget, "export const shared = 2;\n"));
        const afterInTreeChanged = yield* checkTrust(projectPath);
        return { afterEscapeChanged, afterInTreeChanged };
      }).pipe(Effect.provide(TrustStoreMemory())),
    );

    expect(result.afterEscapeChanged).toEqual({ kind: "trusted" });
    expect(result.afterInTreeChanged).toMatchObject({
      changeSummary: { added: [], modified: ["linked.ts"], removed: [] },
      kind: "reprompt_required",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a corrupt JSON Trust store fails typed and never becomes silent Trust", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-plugin-trust-corrupt-"));
  const projectPath = join(root, "project");
  const storePath = join(root, "trust.json");

  try {
    await mkdir(projectPath, { recursive: true });
    await writeFile(storePath, "{}\n");

    const error = await Effect.runPromise(
      Effect.flip(
        checkTrust(projectPath).pipe(Effect.provide(TrustStoreLive({ path: storePath }))),
      ),
    );

    expect(error).toMatchObject({
      _tag: "TrustStoreError",
      path: storePath,
      reason: "store_corrupt",
    });
    expect(await readFile(storePath, "utf8")).toBe("{}\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a blocking Trust hook fails closed without recording a replacement decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-plugin-trust-block-"));
  const projectPath = join(root, "project");
  const registryLayer = ContributionRegistryLive();
  const layer = Layer.mergeAll(
    TrustStoreMemory(),
    registryLayer,
    HookEmitterLive().pipe(Layer.provide(registryLayer)),
  );

  try {
    await mkdir(projectPath, { recursive: true });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const emitter = yield* HookEmitter;
        const registry = yield* ContributionRegistry;
        yield* registry.registerPlugin(
          { capabilities: [], name: "trust-blocker", version: "1.0.0" },
          [
            defineHookContribution({
              mergeClass: "FirstWins",
              name: "block-project",
              point: "trust",
              run: () =>
                Effect.succeed({ decision: "block" as const, reason: "policy blocked Trust" }),
            }),
          ],
        );
        const grants = createCapabilityGrants(
          Schema.decodeSync(SessionIdSchema)("trust-block-session"),
        );
        const blocked = yield* checkTrust(projectPath, { grants, hookEmitter: emitter });
        yield* registry.removePlugin("trust-blocker");
        const afterRemoval = yield* checkTrust(projectPath, { grants, hookEmitter: emitter });
        return { afterRemoval, blocked };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.blocked).toEqual({ kind: "untrusted" });
    expect(result.afterRemoval).toMatchObject({ kind: "prompt_required" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
