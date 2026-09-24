import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SessionIdSchema } from "@dungle-scrubs/popeye-journal";
import {
  CommandContributionKind,
  type CommandDeclaration,
  type CommandExecutionContext,
  createCapabilityGrants,
  type RegisteredContribution,
} from "@dungle-scrubs/popeye-plugins";
import { Effect, Logger, Schema } from "effect";
import { expect, test } from "vitest";

import { GenerationPluginHostLive, PluginHost } from "../compose.js";
import { compactPlugin } from "../features/compact.js";
import {
  composePluginRuntime,
  PluginPipelineConfigError,
  PluginPipelineError,
} from "./pipeline.js";

const testSessionId = (name: string) => Schema.decodeSync(SessionIdSchema)(name);

const testCommandContext = (name: string): CommandExecutionContext => ({
  compactNow: () =>
    Effect.succeed({
      compactionEntryId: "unused",
      entriesCovered: 0,
      sliceCount: 0,
      summaryLength: 0,
    }),
  sessionId: testSessionId(name),
  setSessionName: () => Effect.void,
});

type RegisteredCommand = RegisteredContribution<
  "command",
  CommandDeclaration<never, unknown, unknown, never, unknown>
>;

const invokeRegisteredCommand = (
  command: RegisteredCommand,
  args: unknown,
  context: CommandExecutionContext,
): Effect.Effect<unknown, unknown> =>
  Schema.decodeUnknown(command.payload.arguments)(args).pipe(
    Effect.flatMap((input) => command.payload.execute(input, context)),
  );

const commandPluginSource = (name: string, result: string): string =>
  [
    `import { Effect, Schema } from ${JSON.stringify(new URL("../../node_modules/effect/dist/esm/index.js", import.meta.url).href)};`,
    "export default () => ({",
    "  contributions: [{",
    "    kind: 'command',",
    `    name: '${name}',`,
    "    payload: {",
    "      arguments: Schema.Struct({}),",
    `      description: 'Run ${name}.',`,
    `      execute: () => Effect.succeed('${result}'),`,
    `      name: '${name}',`,
    "    },",
    "    priority: 0,",
    "  }],",
    `  manifest: { capabilities: [], name: '${name}', version: '1.0.0' },`,
    "});",
    "",
  ].join("\n");

test("first-party Plugin generation entries expose the same manifest accessor", async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "popeye-cli-plugin-pipeline-manifest-"));
  const userPluginDir = join(projectPath, "user-plugins");

  try {
    await mkdir(userPluginDir, { recursive: true });
    const generation = await Effect.runPromise(
      composePluginRuntime({
        noProjectPlugins: false,
        pluginPaths: [],
        projectPath,
        userPluginDir,
      }),
    );

    expect(
      generation.plugins.map((plugin) => ({
        manifestName: plugin.manifest.name,
        name: plugin.name,
      })),
    ).toEqual([
      { manifestName: "compact", name: "compact" },
      { manifestName: "reload", name: "reload" },
      { manifestName: "session-name", name: "session-name" },
    ]);
    await Effect.runPromise(generation.close);
  } finally {
    await rm(projectPath, { force: true, recursive: true });
  }
});

test("an empty project exposes only the invokable first-party commands", async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "popeye-cli-plugin-pipeline-empty-"));
  const userPluginDir = join(projectPath, "user-plugins");

  try {
    await mkdir(userPluginDir, { recursive: true });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const generation = yield* composePluginRuntime({
          noProjectPlugins: false,
          pluginPaths: [],
          projectPath,
          userPluginDir,
        });
        const grants = createCapabilityGrants(testSessionId("pipeline-test-session"));
        const commands = yield* generation.registry.list(CommandContributionKind, grants);
        const invocations: Array<string> = [];
        for (const command of commands) {
          yield* invokeRegisteredCommand(
            command,
            command.name === "session-name" ? { name: "Pipeline name" } : {},
            {
              compactNow: () =>
                Effect.sync(() => {
                  invocations.push("compact");
                  return {
                    compactionEntryId: "test-compaction",
                    entriesCovered: 0,
                    sliceCount: 0,
                    summaryLength: 0,
                  };
                }),
              sessionId: testSessionId("pipeline-test-session"),
              setSessionName: (name) =>
                Effect.sync(() => {
                  invocations.push(name);
                }),
            },
          );
        }
        yield* generation.close;
        return {
          commands: commands.map((command) => command.name).sort(),
          invocations,
          plugins: generation.plugins.map((plugin) => plugin.name).sort(),
        };
      }),
    );

    expect(result).toEqual({
      commands: ["compact", "reload", "session-name"],
      invocations: ["compact", "Pipeline name"],
      plugins: ["compact", "reload", "session-name"],
    });
  } finally {
    await rm(projectPath, { force: true, recursive: true });
  }
});

test("a project Plugin loads in phase 2 and its command is invokable", async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "popeye-cli-plugin-pipeline-project-"));
  const projectPluginDir = join(projectPath, ".popeye", "plugins");
  const userPluginDir = join(projectPath, "user-plugins");
  const pluginPath = join(projectPluginDir, "project-command.ts");

  try {
    await mkdir(projectPluginDir, { recursive: true });
    await mkdir(userPluginDir, { recursive: true });
    await writeFile(pluginPath, commandPluginSource("project-command", "project-result"));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const generation = yield* composePluginRuntime({
          noProjectPlugins: false,
          pluginPaths: [],
          projectPath,
          userPluginDir,
        });
        const grants = createCapabilityGrants(testSessionId("pipeline-project-session"));
        const commands = yield* generation.registry.list(CommandContributionKind, grants);
        const projectCommand = commands.find((command) => command.name === "project-command");
        if (projectCommand === undefined) {
          return yield* Effect.die("Project command was not registered.");
        }
        const output = yield* invokeRegisteredCommand(
          projectCommand,
          {},
          testCommandContext("pipeline-project-session"),
        );
        yield* generation.close;
        return { output, plugins: generation.plugins };
      }),
    );

    expect(result.output).toBe("project-result");
    expect(result.plugins.map(({ name, scope }) => ({ name, scope }))).toEqual([
      { name: "compact", scope: "external" },
      { name: "reload", scope: "external" },
      { name: "session-name", scope: "external" },
      { name: "project-command", scope: "project-local" },
    ]);
  } finally {
    await rm(projectPath, { force: true, recursive: true });
  }
});

test("a user-global Plugin loads in phase 1", async () => {
  const root = await mkdtemp(join(tmpdir(), "popeye-cli-plugin-pipeline-user-global-"));
  const projectPath = join(root, "project");
  const userPluginDir = join(root, "user-plugins");
  const pluginPath = join(userPluginDir, "user-command.ts");

  try {
    await mkdir(projectPath, { recursive: true });
    await mkdir(userPluginDir, { recursive: true });
    await writeFile(pluginPath, commandPluginSource("user-command", "user-result"));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const generation = yield* composePluginRuntime({
          noProjectPlugins: false,
          pluginPaths: [],
          projectPath,
          userPluginDir,
        });
        const grants = createCapabilityGrants(testSessionId("pipeline-user-session"));
        const commands = yield* generation.registry.list(CommandContributionKind, grants);
        const command = commands.find((candidate) => candidate.name === "user-command");
        if (command === undefined) {
          return yield* Effect.die("User-global command was not registered.");
        }
        const output = yield* invokeRegisteredCommand(
          command,
          {},
          testCommandContext("pipeline-user-session"),
        );
        yield* generation.close;
        return {
          output,
          plugin: generation.plugins.find((plugin) => plugin.name === "user-command"),
        };
      }),
    );

    expect(result).toEqual({
      output: "user-result",
      plugin: {
        manifest: {
          capabilities: [],
          name: "user-command",
          version: "1.0.0",
        },
        name: "user-command",
        path: await realpath(pluginPath),
        scope: "external",
        version: "1.0.0",
      },
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a user-global Plugin cannot reuse a first-party manifest name", async () => {
  const root = await mkdtemp(join(tmpdir(), "popeye-cli-plugin-pipeline-first-party-collision-"));
  const projectPath = join(root, "project");
  const userPluginDir = join(root, "user-plugins");
  const pluginPath = join(userPluginDir, "compact.ts");

  try {
    await mkdir(projectPath, { recursive: true });
    await mkdir(userPluginDir, { recursive: true });
    await writeFile(
      pluginPath,
      commandPluginSource(compactPlugin.manifest.name, "user-compact-result"),
    );

    const error = await Effect.runPromise(
      Effect.flip(
        composePluginRuntime({
          noProjectPlugins: false,
          pluginPaths: [],
          projectPath,
          userPluginDir,
        }),
      ),
    );

    expect(error).toBeInstanceOf(PluginPipelineError);
    expect(error).toMatchObject({
      pluginName: compactPlugin.manifest.name,
      reason: "name_collision",
    });
    expect(String(error)).toContain(await realpath(pluginPath));
    expect(String(error)).toContain("features/compact");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("two external Plugins cannot share a manifest name", async () => {
  const root = await mkdtemp(join(tmpdir(), "popeye-cli-plugin-pipeline-external-collision-"));
  const projectPath = join(root, "project");
  const userPluginDir = join(root, "user-plugins");
  const userPluginPath = join(userPluginDir, "shared-user.ts");
  const cliPluginPath = join(root, "shared-cli.ts");

  try {
    await mkdir(projectPath, { recursive: true });
    await mkdir(userPluginDir, { recursive: true });
    await writeFile(userPluginPath, commandPluginSource("shared-external", "user-result"));
    await writeFile(cliPluginPath, commandPluginSource("shared-external", "cli-result"));

    const error = await Effect.runPromise(
      Effect.flip(
        composePluginRuntime({
          noProjectPlugins: false,
          pluginPaths: [cliPluginPath],
          projectPath,
          userPluginDir,
        }),
      ),
    );

    expect(error).toBeInstanceOf(PluginPipelineError);
    expect(error).toMatchObject({
      pluginName: "shared-external",
      reason: "name_collision",
    });
    expect(String(error)).toContain(await realpath(userPluginPath));
    expect(String(error)).toContain(await realpath(cliPluginPath));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("CLI Plugin paths use package classification for phase 1 outside and phase 2 inside the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "popeye-cli-plugin-pipeline-cli-paths-"));
  const projectPath = join(root, "project");
  const userPluginDir = join(root, "user-plugins");
  const externalPath = join(root, "external-command.ts");
  const projectLocalPath = join(projectPath, "local-command.ts");

  try {
    await mkdir(projectPath, { recursive: true });
    await mkdir(userPluginDir, { recursive: true });
    await writeFile(externalPath, commandPluginSource("external-command", "external-result"));
    await writeFile(projectLocalPath, commandPluginSource("local-command", "local-result"));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const generation = yield* composePluginRuntime({
          noProjectPlugins: false,
          pluginPaths: [projectLocalPath, externalPath],
          projectPath,
          userPluginDir,
        });
        const grants = createCapabilityGrants(testSessionId("pipeline-cli-paths-session"));
        const commands = yield* generation.registry.list(CommandContributionKind, grants);
        const outputs = yield* Effect.forEach(
          commands.filter((command) => command.name.endsWith("-command")),
          (command) =>
            invokeRegisteredCommand(command, {}, testCommandContext("pipeline-cli-paths-session")),
        );
        yield* generation.close;
        return {
          outputs: [...outputs].sort(),
          plugins: generation.plugins
            .filter((plugin) => plugin.name.endsWith("-command"))
            .map(({ name, scope }) => ({ name, scope })),
        };
      }),
    );

    expect(result).toEqual({
      outputs: ["external-result", "local-result"],
      plugins: [
        { name: "external-command", scope: "external" },
        { name: "local-command", scope: "project-local" },
      ],
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("noProjectPlugins skips discovered and CLI project-local Plugins but keeps phase-1 Plugins", async () => {
  const root = await mkdtemp(join(tmpdir(), "popeye-cli-plugin-pipeline-no-project-"));
  const projectPath = join(root, "project");
  const projectPluginDir = join(projectPath, ".popeye", "plugins");
  const userPluginDir = join(root, "user-plugins");
  const externalPath = join(root, "external-command.ts");
  const projectCliPath = join(projectPath, "local-cli-command.ts");

  try {
    await mkdir(projectPluginDir, { recursive: true });
    await mkdir(userPluginDir, { recursive: true });
    await writeFile(
      join(projectPluginDir, "discovered-command.ts"),
      commandPluginSource("discovered-command", "discovered-result"),
    );
    await writeFile(
      join(userPluginDir, "user-command.ts"),
      commandPluginSource("user-command", "user-result"),
    );
    await writeFile(externalPath, commandPluginSource("external-command", "external-result"));
    await writeFile(projectCliPath, commandPluginSource("local-cli-command", "local-result"));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const generation = yield* composePluginRuntime({
          noProjectPlugins: true,
          pluginPaths: [projectCliPath, externalPath],
          projectPath,
          userPluginDir,
        });
        const grants = createCapabilityGrants(testSessionId("pipeline-no-project-session"));
        const commands = yield* generation.registry.list(CommandContributionKind, grants);
        yield* generation.close;
        return {
          commands: commands.map((command) => command.name).sort(),
          plugins: generation.plugins.map((plugin) => plugin.name).sort(),
        };
      }),
    );

    expect(result).toEqual({
      commands: ["compact", "external-command", "reload", "session-name", "user-command"],
      plugins: ["compact", "external-command", "reload", "session-name", "user-command"],
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a user Plugin directory path that is a file fails as a pipeline config error", async () => {
  const root = await mkdtemp(join(tmpdir(), "popeye-cli-plugin-pipeline-user-file-"));
  const projectPath = join(root, "project");
  const userPluginDir = join(root, "user-plugins");

  try {
    await mkdir(projectPath, { recursive: true });
    await writeFile(userPluginDir, "not a directory");

    const error = await Effect.runPromise(
      Effect.flip(
        composePluginRuntime({
          noProjectPlugins: false,
          pluginPaths: [],
          projectPath,
          userPluginDir,
        }),
      ),
    );

    expect(error).toBeInstanceOf(PluginPipelineConfigError);
    expect(error).toMatchObject({
      cause: { code: "ENOTDIR" },
      path: userPluginDir,
      reason: "user_plugin_directory_unavailable",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("trusted composition uses fresh memory stores and never writes Trust state", async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "popeye-cli-plugin-pipeline-trust-memory-"));
  const projectPluginDir = join(projectPath, ".popeye", "plugins");
  const userPluginDir = join(projectPath, "user-plugins");

  try {
    await mkdir(projectPluginDir, { recursive: true });
    await mkdir(userPluginDir, { recursive: true });
    await writeFile(
      join(projectPluginDir, "trusted-command.ts"),
      commandPluginSource("trusted-command", "trusted-result"),
    );
    const options = {
      noProjectPlugins: false,
      pluginPaths: [],
      projectPath,
      userPluginDir,
    } as const;

    const loadedNames = await Effect.runPromise(
      Effect.forEach([1, 2], () =>
        Effect.gen(function* () {
          const generation = yield* composePluginRuntime(options);
          const names = generation.plugins.map((plugin) => plugin.name);
          yield* generation.close;
          return names;
        }),
      ),
    );
    const projectFiles = await readdir(projectPath, { recursive: true });

    expect(loadedNames).toEqual([
      ["compact", "reload", "session-name", "trusted-command"],
      ["compact", "reload", "session-name", "trusted-command"],
    ]);
    expect(projectFiles.filter((path) => path.toLowerCase().includes("trust"))).toEqual([
      ".popeye/plugins/trusted-command.ts",
    ]);
  } finally {
    await rm(projectPath, { force: true, recursive: true });
  }
});

test("phase-2 Plugins cannot displace phase-1 or first-party Plugin names", async () => {
  const root = await mkdtemp(join(tmpdir(), "popeye-cli-plugin-pipeline-displacement-"));
  const externalProjectPath = join(root, "external-project");
  const externalProjectPluginDir = join(externalProjectPath, ".popeye", "plugins");
  const firstPartyProjectPath = join(root, "first-party-project");
  const firstPartyProjectPluginDir = join(firstPartyProjectPath, ".popeye", "plugins");
  const userPluginDir = join(root, "user-plugins");
  const externalPath = join(root, "shared-external.ts");
  const projectPath = join(externalProjectPluginDir, "shared-project.ts");
  const compactDisplacerPath = join(firstPartyProjectPluginDir, "compact.ts");

  try {
    await mkdir(externalProjectPluginDir, { recursive: true });
    await mkdir(firstPartyProjectPluginDir, { recursive: true });
    await mkdir(userPluginDir, { recursive: true });
    await writeFile(externalPath, commandPluginSource("shared-plugin", "external"));
    await writeFile(projectPath, commandPluginSource("shared-plugin", "project"));
    await writeFile(compactDisplacerPath, commandPluginSource("compact", "displaced"));

    const [externalError, firstPartyError] = await Effect.runPromise(
      Effect.all([
        Effect.flip(
          composePluginRuntime({
            noProjectPlugins: false,
            pluginPaths: [externalPath],
            projectPath: externalProjectPath,
            userPluginDir,
          }),
        ),
        Effect.flip(
          composePluginRuntime({
            noProjectPlugins: false,
            pluginPaths: [],
            projectPath: firstPartyProjectPath,
            userPluginDir,
          }),
        ),
      ]),
    );

    expect(externalError).toMatchObject({
      phase1Path: await realpath(externalPath),
      phase2Path: await realpath(projectPath),
      pluginName: "shared-plugin",
      reason: "phase2_displacement",
    });
    expect(String(externalError)).toContain(await realpath(externalPath));
    expect(String(externalError)).toContain(await realpath(projectPath));
    expect(firstPartyError).toMatchObject({
      phase1Path: fileURLToPath(new URL("../features/compact.js", import.meta.url)),
      phase2Path: await realpath(compactDisplacerPath),
      pluginName: "compact",
      reason: "phase2_displacement",
    });
    expect(String(firstPartyError)).toContain("features/compact");
    expect(String(firstPartyError)).toContain(await realpath(compactDisplacerPath));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Plugin diagnostics are routed through the Effect logger with their sink family", async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "popeye-cli-plugin-pipeline-diagnostics-"));
  const userPluginDir = join(projectPath, "user-plugins");
  const logs: Array<string> = [];
  const logger = Logger.make<unknown, void>(({ message }) => logs.push(String(message)));

  try {
    await mkdir(userPluginDir, { recursive: true });
    await Effect.runPromise(
      Effect.gen(function* () {
        const generation = yield* composePluginRuntime({
          noProjectPlugins: false,
          pluginPaths: [],
          projectPath,
          userPluginDir,
        });
        yield* generation.close;
      }).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger))),
    );

    expect(logs).toContainEqual(expect.stringContaining('"diagnosticFamily":"trust"'));
    expect(logs).toContainEqual(expect.stringContaining('"type":"trust_decision"'));
  } finally {
    await rm(projectPath, { force: true, recursive: true });
  }
});

test("the generation-backed PluginHost invokes a discovered command", async () => {
  const root = await mkdtemp(join(tmpdir(), "popeye-cli-plugin-pipeline-host-"));
  const projectPath = join(root, "project");
  const userPluginDir = join(root, "user-plugins");
  const pluginPath = join(root, "host-command.ts");

  try {
    await mkdir(projectPath, { recursive: true });
    await mkdir(userPluginDir, { recursive: true });
    await writeFile(pluginPath, commandPluginSource("host-command", "host-result"));

    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const generation = yield* composePluginRuntime({
          noProjectPlugins: false,
          pluginPaths: [pluginPath],
          projectPath,
          userPluginDir,
        });
        const program = Effect.gen(function* () {
          const host = yield* PluginHost;
          return yield* host.invokeCommand(
            "host-command",
            {},
            {
              compactNow: () =>
                Effect.succeed({
                  compactionEntryId: "unused",
                  entriesCovered: 0,
                  sliceCount: 0,
                  summaryLength: 0,
                }),
              sessionId: testSessionId("pipeline-host-session"),
              setSessionName: () => Effect.void,
            },
          );
        }).pipe(Effect.provide(GenerationPluginHostLive(generation)));
        return yield* program.pipe(Effect.ensuring(generation.close));
      }),
    );

    expect(output).toBe("host-result");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
