import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type SessionId, SessionIdSchema } from "@dungle-scrubs/popeye-journal";
import type { ToolExecutionContext } from "@dungle-scrubs/popeye-kernel";
import {
  type CapabilityGrants,
  CurrentGrantsFiberRef,
  createCapabilityGrants,
  defineHookContribution,
  defineToolContribution,
  ToolContributionError,
} from "@dungle-scrubs/popeye-plugins";
import { Effect, Either, FiberRef, Logger, Option, Schema } from "effect";
import { expect, test } from "vitest";

import { composePluginRuntime } from "../plugins/pipeline.js";
import { adaptTools, generationCapabilityUnion } from "./adapter.js";

const testToolContext = (sessionId: SessionId): ToolExecutionContext => ({
  changeGoal: () => Effect.succeed(undefined),
  getGoal: () => Effect.succeed(undefined),
  sessionId,
});

const toolPluginSource = (pluginName: string, priority: number): string =>
  [
    `import { Effect, Schema } from ${JSON.stringify(new URL("../../node_modules/effect/dist/esm/index.js", import.meta.url).href)};`,
    "export default () => ({",
    "  contributions: [{",
    "    kind: 'tool',",
    "    name: 'shared-tool',",
    "    payload: {",
    "      description: 'Shared fixture Tool.',",
    `      execute: () => Effect.succeed({ content: '${pluginName}' }),`,
    "      name: 'shared-tool',",
    "      parameters: Schema.Struct({}),",
    "    },",
    `    priority: ${priority},`,
    "  }],",
    `  manifest: { capabilities: [], name: '${pluginName}', version: '1.0.0' },`,
    "});",
    "",
  ].join("\n");

test("Tool shadowing follows scope, contribution priority, and lexical Plugin-name order", async () => {
  const root = await mkdtemp(join(tmpdir(), "popeye-cli-tool-adapter-shadowing-"));
  const projectPath = join(root, "project");
  const projectPluginDir = join(projectPath, ".popeye", "plugins");
  const userPluginDir = join(root, "user-plugins");
  const externalPluginPath = join(root, "external-plugin.ts");
  const logs: Array<string> = [];
  const logger = Logger.make<unknown, void>(({ message }) => logs.push(String(message)));
  const firstPartyPlugin = {
    contributions: [
      defineToolContribution(
        {
          description: "First-party shared Tool.",
          execute: () => Effect.succeed({ content: "z-first-party" }),
          name: "shared-tool",
          parameters: Schema.Struct({}),
        },
        100,
      ),
    ],
    manifest: {
      capabilities: [],
      name: "z-first-party",
      version: "1.0.0",
    },
  } as const;

  try {
    await mkdir(projectPluginDir, { recursive: true });
    await mkdir(userPluginDir, { recursive: true });
    await writeFile(externalPluginPath, toolPluginSource("z-external", 90));
    await writeFile(join(projectPluginDir, "a-high.ts"), toolPluginSource("a-project-high", 10));
    await writeFile(join(projectPluginDir, "b-low.ts"), toolPluginSource("b-project-low", 9));
    await writeFile(join(projectPluginDir, "z-high.ts"), toolPluginSource("z-project-high", 10));
    const generation = await Effect.runPromise(
      composePluginRuntime({
        firstPartyPlugins: [firstPartyPlugin],
        noProjectPlugins: false,
        pluginPaths: [externalPluginPath],
        projectPath,
        userPluginDir,
      }),
    );
    const grants = createCapabilityGrants(SessionIdSchema.make("shadowing-session"));
    const tools = await Effect.runPromise(
      adaptTools(generation, grants).pipe(
        Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
      ),
    );
    const tool = tools[0];
    if (tool === undefined) {
      throw new Error("Tool shadowing did not select a survivor.");
    }
    const result = await Effect.runPromise(
      Effect.scoped(tool.execute({} as never, testToolContext(grants.sessionId))),
    );
    await Effect.runPromise(generation.close);

    expect(tools).toHaveLength(1);
    expect(result).toEqual({ content: "a-project-high" });
    expect(logs.map((log) => JSON.parse(log) as unknown)).toEqual(
      expect.arrayContaining([
        {
          plugins: ["a-project-high", "z-project-high"],
          survivor: "a-project-high",
          tool: "shared-tool",
          type: "tool_shadowed",
        },
        {
          plugins: ["a-project-high", "b-project-low"],
          survivor: "a-project-high",
          tool: "shared-tool",
          type: "tool_shadowed",
        },
        {
          plugins: ["a-project-high", "z-external"],
          survivor: "a-project-high",
          tool: "shared-tool",
          type: "tool_shadowed",
        },
        {
          plugins: ["a-project-high", "z-first-party"],
          survivor: "a-project-high",
          tool: "shared-tool",
          type: "tool_shadowed",
        },
      ]),
    );
    expect(logs).toHaveLength(4);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a Tool is skipped when its own Plugin manifest does not declare its Capabilities", async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "popeye-cli-tool-adapter-declaration-rule-"));
  const userPluginDir = join(projectPath, "user-plugins");
  const logs: Array<string> = [];
  const logger = Logger.make<unknown, void>(({ message }) => logs.push(String(message)));

  try {
    await mkdir(userPluginDir, { recursive: true });
    const generation = await Effect.runPromise(
      composePluginRuntime({
        firstPartyPlugins: [
          {
            contributions: [
              defineToolContribution({
                description: "Uses undeclared powers.",
                execute: () => Effect.succeed({ content: "should not run" }),
                name: "unsafe-tool",
                parameters: Schema.Struct({}),
                requiredCapabilities: ["shell", "filesystem-write", "shell"],
              }),
            ],
            manifest: {
              capabilities: [{ name: "network" }],
              name: "unsafe-plugin",
              version: "1.0.0",
            },
          },
        ],
        noProjectPlugins: false,
        pluginPaths: [],
        projectPath,
        userPluginDir,
      }),
    );
    const grants = createCapabilityGrants(SessionIdSchema.make("declaration-rule-session"), [
      "filesystem-write",
      "network",
      "shell",
    ]);
    const tools = await Effect.runPromise(
      adaptTools(generation, grants).pipe(
        Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
      ),
    );
    await Effect.runPromise(generation.close);

    expect(tools).toEqual([]);
    expect(logs).toEqual([
      '{"missingCapabilities":["filesystem-write","shell"],"plugin":"unsafe-plugin","type":"tool_capability_undeclared"}',
    ]);
  } finally {
    await rm(projectPath, { force: true, recursive: true });
  }
});

test("generation Capability union is sorted and deduplicated across Plugin manifests", async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "popeye-cli-tool-adapter-grants-"));
  const userPluginDir = join(projectPath, "user-plugins");

  try {
    await mkdir(userPluginDir, { recursive: true });
    const generation = await Effect.runPromise(
      composePluginRuntime({
        firstPartyPlugins: [
          {
            contributions: [],
            manifest: {
              capabilities: [{ name: "network", required: true }, { name: "filesystem-read" }],
              name: "grant-alpha",
              version: "1.0.0",
            },
          },
          {
            contributions: [],
            manifest: {
              capabilities: [{ name: "shell" }, { name: "network" }],
              name: "grant-beta",
              version: "1.0.0",
            },
          },
        ],
        noProjectPlugins: false,
        pluginPaths: [],
        projectPath,
        userPluginDir,
      }),
    );

    expect(generationCapabilityUnion(generation)).toEqual(["filesystem-read", "network", "shell"]);
    await Effect.runPromise(generation.close);
  } finally {
    await rm(projectPath, { force: true, recursive: true });
  }
});

test("a grant-visible Plugin tool preserves its declaration and execution outcomes", async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "popeye-cli-tool-adapter-declaration-"));
  const userPluginDir = join(projectPath, "user-plugins");
  const parameters = Schema.Struct({ value: Schema.String });
  const plugin = {
    contributions: [
      defineToolContribution({
        description: "Echo a value or fail.",
        execute: ({ value }) =>
          value === "fail"
            ? Effect.fail(
                new ToolContributionError({
                  message: "fixture failure",
                  toolCallId: "call-1",
                  toolName: "echo",
                }),
              )
            : Effect.succeed({ content: value, isError: false }),
        executionMode: "sequential",
        name: "echo",
        parameters,
        replay: "safe",
        requiredCapabilities: ["filesystem-read"],
      }),
    ],
    manifest: {
      capabilities: [{ name: "filesystem-read", required: true }],
      name: "adapter-fixture",
      version: "1.0.0",
    },
  } as const;

  try {
    await mkdir(userPluginDir, { recursive: true });
    const generation = await Effect.runPromise(
      composePluginRuntime({
        firstPartyPlugins: [plugin],
        noProjectPlugins: false,
        pluginPaths: [],
        projectPath,
        userPluginDir,
      }),
    );
    const grants = createCapabilityGrants(SessionIdSchema.make("adapter-session"), [
      "filesystem-read",
    ]);
    const tools = await Effect.runPromise(adaptTools(generation, grants));
    const tool = tools[0];
    if (tool === undefined) {
      throw new Error("The adapter did not return the fixture Tool.");
    }

    const success = await Effect.runPromise(
      Effect.scoped(tool.execute({ value: "echoed" } as never, testToolContext(grants.sessionId))),
    );
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.either(tool.execute({ value: "fail" } as never, testToolContext(grants.sessionId))),
      ),
    );
    await Effect.runPromise(generation.close);

    expect(tool).toMatchObject({
      description: "Echo a value or fail.",
      executionMode: "sequential",
      name: "echo",
      parameters,
      replay: "safe",
      requiredCapabilities: ["filesystem-read"],
    });
    expect(success).toEqual({ content: "echoed", isError: false });
    expect(Either.isLeft(failure)).toBe(true);
    if (Either.isLeft(failure)) {
      expect(failure.left).toMatchObject({
        _tag: "ToolError",
        message: "fixture failure",
        toolCallId: "call-1",
        toolName: "echo",
      });
    }
  } finally {
    await rm(projectPath, { force: true, recursive: true });
  }
});

test.each([
  ["a calling Session", "calling-session", "calling-session", "calling-session"],
  // Defensive branch (#89 Decision 1): a context without a Session id keeps
  // the adaptation grants, and the gate input omits sessionId. Passes today.
  ["no Session", undefined, undefined, "adapting-view"],
] as const)(
  "an adapted Tool's tool-call-gate Hooks run with %s's grants id and the adaptation grants' Capabilities",
  async (_label, callerId, expectedGateSessionId, expectedGrantsSessionId) => {
    // Issue #89: the CLI registry executes a wrapper adapted for whichever view
    // last refreshed its cache, so the adaptation grants' id is not the caller's.
    const projectPath = await mkdtemp(join(tmpdir(), "popeye-cli-tool-adapter-call-grants-"));
    const observed: Array<{
      readonly gateSessionId: string | undefined;
      readonly grants: CapabilityGrants | undefined;
    }> = [];
    const plugin = {
      contributions: [
        defineToolContribution({
          description: "Probe Tool.",
          execute: () => Effect.succeed({ content: "probed" }),
          name: "probe",
          parameters: Schema.Struct({}),
        }),
        defineHookContribution({
          mergeClass: "FirstWins",
          name: "grants-probe",
          point: "tool-call-gate",
          run: (input: { readonly sessionId?: string | undefined }) =>
            FiberRef.get(CurrentGrantsFiberRef).pipe(
              Effect.map((grants) => {
                observed.push({
                  gateSessionId: input.sessionId,
                  grants: Option.getOrUndefined(grants),
                });
                return { decision: "continue" as const };
              }),
            ),
        }),
      ],
      manifest: {
        capabilities: [{ name: "shell" }],
        name: "call-grants-fixture",
        version: "1.0.0",
      },
    } as const;

    try {
      const generation = await Effect.runPromise(
        composePluginRuntime({
          firstPartyPlugins: [plugin],
          noProjectPlugins: true,
          pluginPaths: [],
          projectPath,
        }),
      );
      const adaptationGrants = createCapabilityGrants(SessionIdSchema.make("adapting-view"), [
        "shell",
      ]);
      const tools = await Effect.runPromise(adaptTools(generation, adaptationGrants));
      const tool = tools.find((candidate) => candidate.name === "probe");
      if (tool === undefined) {
        throw new Error("The adapter did not return the probe Tool.");
      }
      const caller =
        callerId === undefined
          ? (undefined as unknown as SessionId)
          : SessionIdSchema.make(callerId);
      const result = await Effect.runPromise(
        Effect.scoped(tool.execute({} as never, testToolContext(caller))),
      );
      await Effect.runPromise(generation.close);

      expect(result).toEqual({ content: "probed" });
      expect(observed).toHaveLength(1);
      // Already correct today: the gate input names the caller.
      expect(observed[0]?.gateSessionId).toBe(expectedGateSessionId);
      // The Hook's grants carry the caller's id and exactly the adaptation
      // grants' Capabilities, so no grant decision changes.
      expect(observed[0]?.grants?.sessionId).toBe(expectedGrantsSessionId);
      expect(observed[0]?.grants?.capabilities).toEqual(["shell"]);
    } finally {
      await rm(projectPath, { force: true, recursive: true });
    }
  },
);
