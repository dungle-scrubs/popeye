import { SessionIdSchema } from "@dungle-scrubs/popeye-journal";
import { Effect, Schema } from "effect";
import { expect, test } from "vitest";

import { createCapabilityGrants } from "./capability.js";
import {
  contributionKey,
  defineContribution,
  defineHookContribution,
  defineInstructionFragmentContribution,
  defineToolContribution,
} from "./contribution.js";
import { defineHookPoint } from "./hook-points.js";
import {
  ContributionRegistry,
  ContributionRegistryLive,
  defineContributionKind,
  HookContributionKind,
  InstructionFragmentContributionKind,
  type RegistryDiagnostic,
  ToolContributionKind,
} from "./registry.js";

const manifest = (name: string, requiredCapabilities: ReadonlyArray<string> = []) => ({
  capabilities: requiredCapabilities.map((capability) => ({ name: capability, required: true })),
  name,
  version: "1.0.0",
});

const grants = (name: string, capabilities: ReadonlyArray<string> = []) =>
  createCapabilityGrants(Schema.decodeSync(SessionIdSchema)(name), capabilities);

test("Plugin registration is atomic when the third Contribution conflicts", async () => {
  const diagnostics: Array<RegistryDiagnostic> = [];
  const contributions = [
    defineInstructionFragmentContribution({ content: "one", id: "one", trigger: "explicit" }),
    defineInstructionFragmentContribution({ content: "two", id: "two", trigger: "explicit" }),
    defineInstructionFragmentContribution({ content: "two again", id: "two", trigger: "explicit" }),
  ];

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ContributionRegistry;
      const error = yield* Effect.flip(
        registry.registerPlugin(manifest("repo-tools"), contributions),
      );
      return {
        error,
        remaining: yield* registry.list(
          InstructionFragmentContributionKind,
          grants("atomic-session"),
        ),
      };
    }).pipe(
      Effect.provide(
        ContributionRegistryLive({
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
        }),
      ),
    ),
  );

  expect(result.error).toMatchObject({
    _tag: "ContributionRegistryError",
    key: contributionKey("repo-tools", "two"),
    reason: "priority_tie",
  });
  expect(result.remaining).toEqual([]);
  expect(diagnostics).toEqual([
    expect.objectContaining({
      existingPlugin: "repo-tools",
      incomingPlugin: "repo-tools",
      key: contributionKey("repo-tools", "two"),
      selectedPlugin: null,
      type: "contribution_conflict",
    }),
  ]);
});

test("Distinct Plugin namespaces do not conflict", async () => {
  const diagnostics: Array<RegistryDiagnostic> = [];
  const contribution = defineInstructionFragmentContribution({
    content: "scan",
    id: "scan",
    trigger: "explicit",
  });

  const listed = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("repo-tools"), [contribution]);
      yield* registry.registerPlugin(manifest("other-tools"), [contribution]);
      return yield* registry.list(InstructionFragmentContributionKind, grants("namespace-session"));
    }).pipe(
      Effect.provide(
        ContributionRegistryLive({
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
        }),
      ),
    ),
  );

  expect(listed.map((item) => item.key)).toEqual(["repo-tools/scan", "other-tools/scan"]);
  expect(diagnostics).toEqual([]);
});

test("Raw adversarial Contribution names fail through the typed registration channel", async () => {
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ContributionRegistry;
      return yield* Effect.flip(
        registry.registerPlugin(manifest("repo-tools"), [
          {
            kind: "instruction-fragment",
            name: "other-plugin/squat",
            payload: { content: "squat", id: "squat", trigger: "explicit" },
          },
        ]),
      );
    }).pipe(Effect.provide(ContributionRegistryLive())),
  );

  expect(error).toMatchObject({
    kind: "instruction-fragment",
    reason: "invalid_name",
  });
  expect(error.message).toContain("contribution name must use kebab-case");
});

test("registerPlugin atomically replaces an existing Plugin and removePlugin unloads it", async () => {
  const first = defineInstructionFragmentContribution({
    content: "first",
    id: "first",
    trigger: "explicit",
  });
  const second = defineInstructionFragmentContribution({
    content: "second",
    id: "second",
    trigger: "explicit",
  });

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("repo-tools"), [first]);
      yield* registry.registerPlugin(manifest("repo-tools"), [second]);
      const afterReplace = yield* registry.list(
        InstructionFragmentContributionKind,
        grants("replace-session"),
      );
      const removed = yield* registry.removePlugin("repo-tools");
      const afterRemove = yield* registry.list(
        InstructionFragmentContributionKind,
        grants("replace-session"),
      );
      return { afterRemove, afterReplace, removed };
    }).pipe(Effect.provide(ContributionRegistryLive())),
  );

  expect(result.afterReplace.map((item) => item.key)).toEqual(["repo-tools/second"]);
  expect(result.removed).toBe(true);
  expect(result.afterRemove).toEqual([]);
});

test("A kind Schema decodes payloads for typed list and lookup results", async () => {
  const RendererPayloadSchema = Schema.Struct({ count: Schema.NumberFromString });
  const RendererKind = defineContributionKind("renderer", RendererPayloadSchema);
  const contribution = defineContribution("status-panel", "renderer", { count: "3" });
  const key = contributionKey("display", "status-panel");

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ContributionRegistry;
      yield* registry.registerKind(RendererKind);
      yield* registry.registerPlugin(manifest("display"), [contribution]);
      const listed = yield* registry.list(RendererKind, grants("typed-session"));
      const found = yield* registry.lookup(RendererKind, key, grants("typed-session"));
      return { found, listed };
    }).pipe(Effect.provide(ContributionRegistryLive())),
  );

  expect(result.listed[0]?.payload.count).toBe(3);
  expect(result.found?.payload.count).toBe(3);
});

test("Invalid payloads fail registration without changing the registry", async () => {
  const RendererKind = defineContributionKind(
    "renderer",
    Schema.Struct({ count: Schema.NumberFromString }),
  );

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ContributionRegistry;
      yield* registry.registerKind(RendererKind);
      const error = yield* Effect.flip(
        registry.registerPlugin(manifest("display"), [
          defineContribution("status-panel", "renderer", { count: "not-a-number" }),
        ]),
      );
      return { error, listed: yield* registry.list(RendererKind, grants("payload-session")) };
    }).pipe(Effect.provide(ContributionRegistryLive())),
  );

  expect(result.error).toMatchObject({ reason: "payload_invalid" });
  expect(result.listed).toEqual([]);
});

test("Manifest-required Capabilities gate every Contribution at query time", async () => {
  const instruction = defineInstructionFragmentContribution({
    content: "Uses a shell.",
    id: "shell-instructions",
    trigger: "explicit",
  });
  const tool = defineToolContribution({
    description: "Runs a shell command.",
    execute: () => Effect.succeed({ content: "done" }),
    name: "run-shell",
    parameters: Schema.Struct({ command: Schema.String }),
  });
  const toolKey = contributionKey("shell-plugin", "run-shell");

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("shell-plugin", ["shell"]), [instruction, tool]);
      return {
        privilegedInstructions: yield* registry.list(
          InstructionFragmentContributionKind,
          grants("privileged-session", ["shell"]),
        ),
        privilegedTools: yield* registry.list(
          ToolContributionKind,
          grants("privileged-session", ["shell"]),
        ),
        unprivilegedInstructions: yield* registry.list(
          InstructionFragmentContributionKind,
          grants("unprivileged-session"),
        ),
        unprivilegedLookup: yield* registry.lookup(
          ToolContributionKind,
          toolKey,
          grants("unprivileged-session"),
        ),
        unprivilegedTools: yield* registry.list(
          ToolContributionKind,
          grants("unprivileged-session"),
        ),
      };
    }).pipe(Effect.provide(ContributionRegistryLive())),
  );

  expect(result.unprivilegedInstructions).toEqual([]);
  expect(result.unprivilegedTools).toEqual([]);
  expect(result.unprivilegedLookup).toBeUndefined();
  expect(result.privilegedInstructions.map((item) => item.key)).toEqual([
    "shell-plugin/shell-instructions",
  ]);
  expect(result.privilegedTools.map((item) => item.key)).toEqual([toolKey]);
});

test("Capability diagnostics name every missing Capability and emit once per grant-set and key", async () => {
  const diagnostics: Array<RegistryDiagnostic> = [];
  const tool = defineToolContribution({
    description: "Writes over the network.",
    execute: () => Effect.succeed({ content: "written" }),
    name: "publish",
    parameters: Schema.Struct({ path: Schema.String }),
    requiredCapabilities: ["network", "filesystem-write"],
  });
  const sessionGrants = grants("diagnostic-session");

  await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ContributionRegistry;
      yield* registry.registerPlugin(manifest("publisher", ["shell"]), [tool]);
      yield* Effect.repeatN(registry.list(ToolContributionKind, sessionGrants), 9);
      yield* registry.lookup(
        ToolContributionKind,
        contributionKey("publisher", "publish"),
        sessionGrants,
      );
    }).pipe(
      Effect.provide(
        ContributionRegistryLive({
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
        }),
      ),
    ),
  );

  expect(diagnostics).toEqual([
    {
      cause: "capability_ungranted",
      key: contributionKey("publisher", "publish"),
      kind: "tool",
      missingCapabilities: ["filesystem-write", "network", "shell"],
      plugin: "publisher",
      type: "contribution_unavailable",
    },
  ]);
});

test("Unregistered-kind queries and registrations fail typed", async () => {
  const RendererKind = defineContributionKind("renderer", Schema.Struct({ target: Schema.String }));

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ContributionRegistry;
      const queryError = yield* Effect.flip(
        registry.list(RendererKind, grants("unknown-kind-session")),
      );
      const registrationError = yield* Effect.flip(
        registry.registerPlugin(manifest("display"), [
          defineContribution("status", "renderer", { target: "status" }),
        ]),
      );
      return { queryError, registrationError };
    }).pipe(Effect.provide(ContributionRegistryLive())),
  );

  expect(result.queryError).toMatchObject({ kind: "renderer", reason: "unknown_kind" });
  expect(result.registrationError).toMatchObject({
    kind: "renderer",
    reason: "unknown_kind",
  });
});

test("Re-registering a kind with different options fails typed and emits a diagnostic", async () => {
  const diagnostics: Array<RegistryDiagnostic> = [];
  const schema = Schema.Struct({ target: Schema.String });
  const RendererKind = defineContributionKind("renderer", schema);
  const ConflictingRendererKind = defineContributionKind("renderer", schema, {
    requiredCapabilities: () => ["graphics"],
  });

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ContributionRegistry;
      yield* registry.registerKind(RendererKind);
      yield* registry.registerKind(RendererKind);
      return yield* Effect.flip(registry.registerKind(ConflictingRendererKind));
    }).pipe(
      Effect.provide(
        ContributionRegistryLive({
          diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
        }),
      ),
    ),
  );

  expect(error).toMatchObject({ kind: "renderer", reason: "kind_conflict" });
  expect(diagnostics).toEqual([{ kind: "renderer", type: "kind_registration_conflict" }]);
});

test("Hook registration rejects unknown points and merge-class mismatches atomically", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ContributionRegistry;
      const unknown = yield* Effect.flip(
        registry.registerPlugin(manifest("unknown-hook"), [
          defineHookContribution({
            mergeClass: "Chain",
            name: "unknown",
            point: "not-declared",
            run: (input: unknown) => Effect.succeed(input),
          }),
        ]),
      );
      const mismatch = yield* Effect.flip(
        registry.registerPlugin(manifest("mismatched-hook"), [
          defineHookContribution({
            mergeClass: "Tap",
            name: "mismatch",
            point: "tool-call-gate",
            run: () => Effect.void,
          }),
        ]),
      );
      return {
        mismatch,
        remaining: yield* registry.list(HookContributionKind, grants("hook-validation")),
        unknown,
      };
    }).pipe(Effect.provide(ContributionRegistryLive())),
  );

  expect(result.unknown).toMatchObject({ reason: "hook_point_unknown" });
  expect(result.mismatch).toMatchObject({ reason: "hook_merge_class_mismatch" });
  expect(result.remaining).toEqual([]);
});

test("defineHookPoint feeds the runtime registration API", async () => {
  const inputSchema = Schema.Struct({ value: Schema.String });
  const definition = defineHookPoint({
    conflictPolicy: null,
    failurePolicy: "skip",
    inputSchema,
    mergeClass: "Chain",
    name: "custom-context",
    outputSchema: inputSchema,
    resultSchema: inputSchema,
    timeout: "30 seconds",
  });

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ContributionRegistry;
      yield* registry.registerHookPoint(definition);
      yield* registry.registerPlugin(manifest("custom-hook"), [
        defineHookContribution({
          mergeClass: "Chain",
          name: "custom",
          point: "custom-context",
          run: (input: { readonly value: string }) => Effect.succeed(input),
        }),
      ]);
      return {
        definition: yield* registry.getHookPoint("custom-context"),
        hooks: yield* registry.list(HookContributionKind, grants("custom-hook")),
      };
    }).pipe(Effect.provide(ContributionRegistryLive())),
  );

  expect(result.definition).toBe(definition);
  expect(result.hooks.map((hook) => hook.payload.point)).toEqual(["custom-context"]);
});

test("registry revisions increase on successful registrations, replacement, and removal", async () => {
  const contribution = defineInstructionFragmentContribution({
    content: "one",
    id: "one",
    trigger: "explicit",
  });
  const revisions = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ContributionRegistry;
      const initial = yield* registry.revision;
      yield* registry.registerPlugin(manifest("revision-plugin"), [contribution]);
      const registered = yield* registry.revision;
      const [first] = yield* registry.list(
        InstructionFragmentContributionKind,
        grants("revision-session"),
      );
      yield* registry.registerPlugin(manifest("revision-plugin"), [contribution]);
      const replaced = yield* registry.revision;
      const [second] = yield* registry.list(
        InstructionFragmentContributionKind,
        grants("revision-session"),
      );
      yield* registry.removePlugin("revision-plugin");
      const removed = yield* registry.revision;
      return {
        entryRevisions: [first?.registrationRevision, second?.registrationRevision],
        initial,
        registered,
        removed,
        replaced,
      };
    }).pipe(Effect.provide(ContributionRegistryLive())),
  );

  expect(revisions).toEqual({
    entryRevisions: [1, 2],
    initial: 0,
    registered: 1,
    removed: 3,
    replaced: 2,
  });
});
