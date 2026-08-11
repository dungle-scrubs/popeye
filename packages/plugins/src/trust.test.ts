import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionIdSchema } from "@peye/journal";
import { Context, Effect, Exit, Layer, Schema, Tracer } from "effect";
import { expect, test } from "vitest";

import { createCapabilityGrants } from "./capability.js";
import { defineHookContribution } from "./contribution.js";
import type { PluginDiscoveryConfig } from "./discovery.js";
import { HookEmitter, HookEmitterLive } from "./emitter.js";
import { ContributionRegistry, ContributionRegistryLive } from "./registry.js";
import {
  checkTrust,
  recordDecision,
  revokeTrust,
  TrustStore,
  TrustStoreLive,
  TrustStoreMemory,
} from "./trust.js";

const trustConfig = (
  projectPath: string,
  cliPaths: ReadonlyArray<string> = [],
  digestLimits?: PluginDiscoveryConfig["digestLimits"],
): PluginDiscoveryConfig => ({
  cliPaths,
  ...(digestLimits === undefined ? {} : { digestLimits }),
  projectPath,
  userGlobalDirectories: [],
});

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
        const initial = yield* checkTrust(trustConfig(projectPath));
        if (initial.kind !== "prompt_required") {
          return yield* Effect.dieMessage(`Expected prompt_required, got ${initial.kind}.`);
        }
        const record = yield* recordDecision(
          trustConfig(projectPath),
          "trusted",
          initial.currentDigest,
          "user",
        );
        return { initial, record };
      }).pipe(Effect.provide(TrustStoreMemory())),
    );

    expect(result.record).toMatchObject({
      decidedBy: "user",
      decision: "trusted",
      digest: result.initial.currentDigest,
      projectPath: await realpath(projectPath),
    });
    expect(result.record.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.record.digest).toMatch(/^[a-f\d]{64}$/);
    expect(result.record.files.map((file) => file.path)).toEqual([
      ".peye/plugins/nested/a.ts",
      ".peye/plugins/z.ts",
    ]);
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
        const initial = yield* checkTrust(trustConfig(projectPath));
        if (initial.kind !== "prompt_required") {
          return yield* Effect.dieMessage(`Expected prompt_required, got ${initial.kind}.`);
        }
        yield* recordDecision(trustConfig(projectPath), "untrusted", initial.currentDigest, "user");
      }).pipe(Effect.provide(TrustStoreLive({ path: storePath }))),
    );
    const reopened = await Effect.runPromise(
      checkTrust(trustConfig(projectPath)).pipe(
        Effect.provide(TrustStoreLive({ path: storePath })),
      ),
    );

    expect(reopened).toEqual({ decidedBy: "user", kind: "untrusted" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a trusted project can be revoked without supplying its digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-plugin-trust-revoke-"));
  const projectPath = join(root, "project");
  const pluginDirectory = join(projectPath, ".peye", "plugins");

  try {
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(join(pluginDirectory, "plugin.ts"), "export const trusted = true;\n");

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const initial = yield* checkTrust(trustConfig(projectPath));
        if (initial.kind !== "prompt_required") {
          return yield* Effect.dieMessage(`Expected prompt_required, got ${initial.kind}.`);
        }
        yield* recordDecision(trustConfig(projectPath), "trusted", initial.currentDigest, "user");
        const before = yield* checkTrust(trustConfig(projectPath));
        yield* revokeTrust(projectPath);
        const after = yield* checkTrust(trustConfig(projectPath));
        return { after, before };
      }).pipe(Effect.provide(TrustStoreMemory())),
    );

    expect(result.before).toMatchObject({ decidedBy: "user", kind: "trusted" });
    expect(result.after).toEqual({ decidedBy: "revoked", kind: "untrusted" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a legacy Trust record without provenance decodes as a user decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-plugin-trust-legacy-provenance-"));
  const projectPath = join(root, "project");
  const storePath = join(root, "settings", "trust.json");

  try {
    await mkdir(projectPath, { recursive: true });
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        const initial = yield* checkTrust(trustConfig(projectPath));
        if (initial.kind !== "prompt_required") {
          return yield* Effect.dieMessage(`Expected prompt_required, got ${initial.kind}.`);
        }
        return yield* recordDecision(
          trustConfig(projectPath),
          "trusted",
          initial.currentDigest,
          "user",
        );
      }).pipe(Effect.provide(TrustStoreMemory())),
    );
    await mkdir(join(root, "settings"), { recursive: true });
    await writeFile(
      storePath,
      `${JSON.stringify({
        format: "peye_trust",
        records: [
          {
            decidedAt: record.decidedAt,
            decision: record.decision,
            digest: record.digest,
            files: record.files,
            projectPath: record.projectPath,
          },
        ],
        version: 1,
      })}\n`,
    );

    const result = await Effect.runPromise(
      checkTrust(trustConfig(projectPath)).pipe(
        Effect.provide(TrustStoreLive({ path: storePath })),
      ),
    );

    expect(result).toMatchObject({ decidedBy: "user", kind: "trusted" });
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
        const initial = yield* checkTrust(trustConfig(projectPath));
        if (initial.kind !== "prompt_required") {
          return yield* Effect.dieMessage(`Expected prompt_required, got ${initial.kind}.`);
        }
        yield* recordDecision(trustConfig(projectPath), "trusted", initial.currentDigest, "user");
        yield* Effect.promise(() =>
          writeFile(join(pluginDirectory, "modified.ts"), "export const value = 2;\n"),
        );
        yield* Effect.promise(() => rm(join(pluginDirectory, "removed.ts")));
        yield* Effect.promise(() =>
          writeFile(join(pluginDirectory, "added.ts"), "export const added = true;\n"),
        );
        return yield* checkTrust(trustConfig(projectPath));
      }).pipe(Effect.provide(TrustStoreMemory())),
    );

    expect(result).toEqual({
      changeSummary: {
        added: [".peye/plugins/added.ts"],
        modified: [".peye/plugins/modified.ts"],
        removed: [".peye/plugins/removed.ts"],
      },
      currentDigest: expect.stringMatching(/^[a-f\d]{64}$/),
      decidedBy: "user",
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
    const canonicalProjectPath = await realpath(projectPath);

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
          "external",
        );
        const grants = createCapabilityGrants(
          Schema.decodeSync(SessionIdSchema)("trust-hook-session"),
        );
        const first = yield* checkTrust(trustConfig(projectPath), { grants, hookEmitter: emitter });
        const second = yield* checkTrust(trustConfig(projectPath), {
          grants,
          hookEmitter: emitter,
        });
        const store = yield* TrustStore;
        const stored = yield* store.get(canonicalProjectPath);
        return { first, second, stored };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.first).toMatchObject({ decidedBy: "hook", kind: "trusted" });
    expect(result.second).toEqual(result.first);
    expect(result.stored).toMatchObject({
      _tag: "Some",
      value: { decidedBy: "hook", decision: "trusted" },
    });
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
        const initial = yield* checkTrust(trustConfig(projectPath), {
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
        });
        if (initial.kind !== "prompt_required") {
          return yield* Effect.dieMessage(`Expected prompt_required, got ${initial.kind}.`);
        }
        yield* recordDecision(trustConfig(projectPath), "trusted", initial.currentDigest, "user");
        yield* Effect.promise(() =>
          writeFile(join(pluginDirectory, "plugin.ts"), "export const value = 2;\n"),
        );
        return yield* checkTrust(trustConfig(projectPath), {
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
        });
      }).pipe(Effect.provide(Layer.merge(TrustStoreMemory(), tracerLayer(spans)))),
    );
    if (result.kind !== "reprompt_required") {
      throw new Error(`Expected reprompt_required, got ${result.kind}.`);
    }
    const canonicalProjectPath = await realpath(projectPath);

    expect(diagnostics.at(-1)).toEqual({
      changeSummary: { added: [], modified: [".peye/plugins/plugin.ts"], removed: [] },
      decidedBy: "user",
      decision: "reprompt_required",
      digest: result.currentDigest,
      projectPath: canonicalProjectPath,
      scope: "project-local",
      type: "trust_decision",
    });
    expect(spans.map((span) => span.name)).toEqual(["plugins.trust", "plugins.trust"]);
    expect(Object.fromEntries(spans.at(-1)?.attributes ?? [])).toMatchObject({
      changeSummary: JSON.stringify({
        added: [],
        modified: [".peye/plugins/plugin.ts"],
        removed: [],
      }),
      decidedBy: "user",
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

test("a nested project Plugin symlink escape fails typed and names the link", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-plugin-trust-symlink-escape-"));
  const projectPath = join(root, "project");
  const pluginDirectory = join(projectPath, ".peye", "plugins");
  const nestedDirectory = join(pluginDirectory, "nested");
  const inTreeTarget = join(projectPath, "in-tree-plugin.ts");
  const outsideTarget = join(root, "outside-plugin.ts");
  const escapingLink = join(nestedDirectory, "escaped.ts");
  const diagnostics: Array<unknown> = [];

  try {
    await mkdir(nestedDirectory, { recursive: true });
    await writeFile(join(nestedDirectory, "local.ts"), "export const local = true;\n");
    await writeFile(inTreeTarget, "export const inTree = true;\n");
    await writeFile(outsideTarget, "export const outside = 1;\n");
    await symlink(inTreeTarget, escapingLink);

    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const initial = yield* checkTrust(trustConfig(projectPath));
          if (initial.kind !== "prompt_required") {
            return yield* Effect.dieMessage(`Expected prompt_required, got ${initial.kind}.`);
          }
          yield* recordDecision(trustConfig(projectPath), "trusted", initial.currentDigest, "user");
          yield* Effect.promise(async () => {
            await rm(escapingLink);
            await symlink(outsideTarget, escapingLink);
          });
          return yield* checkTrust(trustConfig(projectPath), {
            diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
          });
        }).pipe(Effect.provide(TrustStoreMemory())),
      ),
    );
    const canonicalEscapingLink = join(await realpath(nestedDirectory), "escaped.ts");

    expect(error).toMatchObject({
      _tag: "PluginDigestError",
      path: canonicalEscapingLink,
      reason: "digest_error",
      violation: "symlink_escape",
    });
    expect(diagnostics).toContainEqual({
      path: canonicalEscapingLink,
      reason: "symlink_escape",
      type: "plugin_digest_rejected",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a corrupt JSON Trust store recovers as no decisions and preserves the corrupt bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-plugin-trust-corrupt-"));
  const projectPath = join(root, "project");
  const storePath = join(root, "trust.json");

  try {
    await mkdir(projectPath, { recursive: true });
    await writeFile(storePath, "{}\n");

    const result = await Effect.runPromise(
      checkTrust(trustConfig(projectPath)).pipe(
        Effect.provide(TrustStoreLive({ path: storePath })),
      ),
    );

    expect(result).toMatchObject({ kind: "prompt_required" });
    expect(await readFile(storePath, "utf8")).toBe("{}\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the digest walk memoizes real subtrees across sibling symlink fanout and fails its file budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-plugin-trust-fanout-"));
  const projectPath = join(root, "project");
  const pluginDirectory = join(projectPath, ".peye", "plugins");
  const sharedRoot = join(projectPath, "shared");

  try {
    await mkdir(pluginDirectory, { recursive: true });
    for (let depth = 0; depth <= 16; depth += 1) {
      await mkdir(join(sharedRoot, `level-${depth}`), { recursive: true });
    }
    for (let depth = 0; depth < 16; depth += 1) {
      const current = join(sharedRoot, `level-${depth}`);
      const next = join(sharedRoot, `level-${depth + 1}`);
      await symlink(next, join(current, "left"));
      await symlink(next, join(current, "right"));
    }
    await writeFile(join(sharedRoot, "level-16", "payload.mjs"), "export const payload = true;\n");
    await symlink(join(sharedRoot, "level-0"), join(pluginDirectory, "fanout"));

    const startedAt = performance.now();
    const error = await Effect.runPromise(
      Effect.flip(
        checkTrust(trustConfig(projectPath, [], { maxFileCount: 0 })).pipe(
          Effect.provide(TrustStoreMemory()),
        ),
      ),
    );

    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(error).toMatchObject({
      _tag: "PluginDigestError",
      reason: "digest_error",
      violation: "file_count_exceeded",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the digest walk fails typed when the total-byte budget is exceeded", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-plugin-trust-byte-budget-"));
  const projectPath = join(root, "project");
  const pluginDirectory = join(projectPath, ".peye", "plugins");

  try {
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(join(pluginDirectory, "payload.mjs"), "12345");

    const error = await Effect.runPromise(
      Effect.flip(
        checkTrust(trustConfig(projectPath, [], { maxTotalBytes: 4 })).pipe(
          Effect.provide(TrustStoreMemory()),
        ),
      ),
    );

    expect(error).toMatchObject({
      _tag: "PluginDigestError",
      reason: "digest_error",
      violation: "total_bytes_exceeded",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("editing a project-local CLI Plugin requires a new Trust decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-plugin-trust-cli-digest-"));
  const projectPath = join(root, "project");
  const cliPluginPath = join(projectPath, "cli-plugin.mjs");
  const config = trustConfig(projectPath, [cliPluginPath]);

  try {
    await mkdir(projectPath, { recursive: true });
    await writeFile(cliPluginPath, "export const value = 1;\n");

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const initial = yield* checkTrust(config);
        if (initial.kind !== "prompt_required") {
          return yield* Effect.dieMessage(`Expected prompt_required, got ${initial.kind}.`);
        }
        yield* recordDecision(config, "trusted", initial.currentDigest, "user");
        yield* Effect.promise(() => writeFile(cliPluginPath, "export const value = 2;\n"));
        return yield* checkTrust(config);
      }).pipe(Effect.provide(TrustStoreMemory())),
    );

    expect(result).toMatchObject({
      changeSummary: { added: [], modified: ["cli-plugin.mjs"], removed: [] },
      kind: "reprompt_required",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a project-local Trust hook cannot approve its own project", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-plugin-trust-local-hook-"));
  const projectPath = join(root, "project");
  const registryLayer = ContributionRegistryLive();
  const layer = Layer.mergeAll(
    TrustStoreMemory(),
    registryLayer,
    HookEmitterLive().pipe(Layer.provide(registryLayer)),
  );
  let hookCalls = 0;

  try {
    await mkdir(projectPath, { recursive: true });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const emitter = yield* HookEmitter;
        const registry = yield* ContributionRegistry;
        yield* registry.registerPlugin(
          { capabilities: [], name: "local-trust-policy", version: "1.0.0" },
          [
            defineHookContribution({
              mergeClass: "FirstWins",
              name: "self-approve",
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
          "project-local",
        );
        const grants = createCapabilityGrants(
          Schema.decodeSync(SessionIdSchema)("local-trust-hook-session"),
        );
        return yield* checkTrust(trustConfig(projectPath), { grants, hookEmitter: emitter });
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toMatchObject({ kind: "prompt_required" });
    expect(hookCalls).toBe(0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("interleaved Trust store writes cannot resurrect a revoked decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-plugin-trust-interleaved-"));
  const storePath = join(root, "settings", "trust.json");
  const firstProjectPath = join(root, "first-project");
  const secondProjectPath = join(root, "second-project");
  const record = (
    projectPath: string,
    decision: "trusted" | "untrusted",
    decidedBy: "revoked" | "user" = "user",
  ) => ({
    decidedAt: "2026-08-11T00:00:00.000Z",
    decidedBy,
    decision,
    digest: "a".repeat(64),
    files: [],
    projectPath,
  });

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* TrustStore;
        yield* store.put(record(firstProjectPath, "trusted"));
      }).pipe(Effect.provide(TrustStoreLive({ path: storePath }))),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const contextA = yield* Layer.build(TrustStoreLive({ path: storePath }));
          const contextB = yield* Layer.build(TrustStoreLive({ path: storePath }));
          const storeA = Context.get(contextA, TrustStore);
          const storeB = Context.get(contextB, TrustStore);
          yield* storeA.put(record(firstProjectPath, "untrusted", "revoked"));
          yield* storeB.put(record(secondProjectPath, "trusted"));
        }),
      ),
    );

    const stored = JSON.parse(await readFile(storePath, "utf8")) as {
      readonly records: ReadonlyArray<{ readonly decision: string; readonly projectPath: string }>;
    };
    expect(stored.records).toContainEqual({
      decidedAt: "2026-08-11T00:00:00.000Z",
      decidedBy: "revoked",
      decision: "untrusted",
      digest: "a".repeat(64),
      files: [],
      projectPath: firstProjectPath,
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Trust store writes use a private directory and a unique exclusive temporary file", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-plugin-trust-atomic-"));
  const projectPath = join(root, "project");
  const settingsPath = join(root, "settings");
  const storePath = join(settingsPath, "trust.json");
  const oldTemporaryPath = `${storePath}.tmp`;

  try {
    await mkdir(projectPath, { recursive: true });
    await mkdir(settingsPath, { mode: 0o755 });
    await writeFile(oldTemporaryPath, "attacker-controlled sentinel\n");
    await Effect.runPromise(
      Effect.gen(function* () {
        const initial = yield* checkTrust(trustConfig(projectPath));
        if (initial.kind !== "prompt_required") {
          return yield* Effect.dieMessage(`Expected prompt_required, got ${initial.kind}.`);
        }
        yield* recordDecision(trustConfig(projectPath), "untrusted", initial.currentDigest, "user");
      }).pipe(Effect.provide(TrustStoreLive({ path: storePath }))),
    );

    expect((await stat(settingsPath)).mode & 0o777).toBe(0o700);
    expect(await readFile(oldTemporaryPath, "utf8")).toBe("attacker-controlled sentinel\n");
    expect((await readdir(settingsPath)).filter((name) => name.endsWith(".tmp"))).toEqual([
      "trust.json.tmp",
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("an auto-record digest mismatch emits the re-prompt diagnostic before it fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "peye-plugin-trust-auto-record-race-"));
  const projectPath = join(root, "project");
  const pluginDirectory = join(projectPath, ".peye", "plugins");
  const pluginPath = join(pluginDirectory, "plugin.mjs");
  const diagnostics: Array<unknown> = [];
  const registryLayer = ContributionRegistryLive();
  const layer = Layer.mergeAll(
    TrustStoreMemory(),
    registryLayer,
    HookEmitterLive().pipe(Layer.provide(registryLayer)),
  );

  try {
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(pluginPath, "export const value = 1;\n");

    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const emitter = yield* HookEmitter;
          const registry = yield* ContributionRegistry;
          yield* registry.registerPlugin(
            { capabilities: [], name: "racing-trust-policy", version: "1.0.0" },
            [
              defineHookContribution({
                mergeClass: "FirstWins",
                name: "mutate-before-record",
                point: "trust",
                run: () =>
                  Effect.promise(async () => {
                    await writeFile(pluginPath, "export const value = 2;\n");
                    return {
                      decision: "replace" as const,
                      value: { decision: "trusted" as const },
                    };
                  }),
              }),
            ],
            "external",
          );
          const grants = createCapabilityGrants(
            Schema.decodeSync(SessionIdSchema)("racing-trust-hook-session"),
          );
          return yield* checkTrust(trustConfig(projectPath), {
            diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
            grants,
            hookEmitter: emitter,
          });
        }).pipe(Effect.provide(layer)),
      ),
    );

    expect(error).toMatchObject({ _tag: "TrustStoreError", reason: "digest_mismatch" });
    expect(diagnostics.at(-1)).toMatchObject({
      changeSummary: {
        added: [],
        modified: [".peye/plugins/plugin.mjs"],
        removed: [],
      },
      decision: "reprompt_required",
      type: "trust_decision",
    });
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
          "external",
        );
        const grants = createCapabilityGrants(
          Schema.decodeSync(SessionIdSchema)("trust-block-session"),
        );
        const blocked = yield* checkTrust(trustConfig(projectPath), {
          grants,
          hookEmitter: emitter,
        });
        yield* registry.removePlugin("trust-blocker");
        const afterRemoval = yield* checkTrust(trustConfig(projectPath), {
          grants,
          hookEmitter: emitter,
        });
        return { afterRemoval, blocked };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.blocked).toEqual({ decidedBy: "hook", kind: "untrusted" });
    expect(result.afterRemoval).toMatchObject({ kind: "prompt_required" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
