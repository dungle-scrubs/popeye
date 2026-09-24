import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  BUILT_BIN_PATH,
  FAKE_PROVIDER_PROMPT,
  fakeProviderEnvironment,
  runBuiltBin,
} from "../test-support/cli.js";

const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const sessionDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "popeye-cli-bin-"));
  temporaryDirectories.push(directory);
  return directory;
};

const startupRecords = (stderr: string): ReadonlyArray<Record<string, unknown>> =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith("STARTUP "))
    .map((line) => JSON.parse(line.slice("STARTUP ".length)) as Record<string, unknown>);

test("the built bin reports the package version and help without Provider config", () => {
  expect(readFileSync(BUILT_BIN_PATH, "utf8")).toMatch(/^#!\/usr\/bin\/env node\n/u);

  const version = runBuiltBin(["--version"]);
  const help = runBuiltBin(["--help"]);

  expect(version.status).toBe(0);
  expect(version.stdout).toBe("0.1.3\n");
  expect(version.stderr).toBe("");
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('popeye -p --mode json "<prompt>"');
  expect(help.stdout).toContain("popeye -p --mode rpc");
  expect(help.stdout).toContain("2  Invalid arguments, missing configuration, or an aborted turn.");
  expect(help.stdout).toContain("Read stderr to distinguish exit 2 causes.");
  expect(help.stderr).toBe("");
}, 10_000);

test("the built help documents plugin flags in alphabetical order", () => {
  const help = runBuiltBin(["--help"]);
  const options = help.stdout.slice(
    help.stdout.indexOf("Options:"),
    help.stdout.indexOf("\n\nLoopback"),
  );
  const orderedFlags = [
    "--base-url",
    "--headless",
    "--help",
    "--mode",
    "--model",
    "--no-project-plugins",
    "--plugin",
    "--resume",
    "--session-dir",
    "--version",
  ];

  expect(help.status).toBe(0);
  expect(options).toContain("--no-project-plugins");
  expect(options).toContain("--plugin <path>");
  for (const [index, flag] of orderedFlags.entries()) {
    const nextFlag = orderedFlags[index + 1];
    if (nextFlag !== undefined) {
      expect(options.indexOf(flag)).toBeLessThan(options.indexOf(nextFlag));
    }
  }
});

test("the built print Head accepts positional and piped prompts with pure stdout", () => {
  const positional = runBuiltBin(
    ["-p", "--session-dir", sessionDirectory(), FAKE_PROVIDER_PROMPT],
    {
      env: fakeProviderEnvironment(),
    },
  );
  const piped = runBuiltBin(["-p", "--session-dir", sessionDirectory()], {
    env: fakeProviderEnvironment(),
    input: `${FAKE_PROVIDER_PROMPT}\n`,
  });

  for (const result of [positional, piped]) {
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Fake provider answer.\n");
    expect(startupRecords(result.stderr)).toEqual([
      {
        baseUrlHost: "127.0.0.1",
        mode: "print",
        model: "fake-model",
        sessionAction: "create",
        toolCount: 0,
      },
    ]);
  }
}, 15_000);

test("the built bin reports the adapted project Plugin Tool count", () => {
  const projectPath = sessionDirectory();
  const projectPluginDir = join(projectPath, ".popeye", "plugins");
  const sessionDir = join(projectPath, "sessions");
  const userPluginDir = join(projectPath, "user-plugins");
  mkdirSync(projectPluginDir, { recursive: true });
  mkdirSync(userPluginDir, { recursive: true });
  writeFileSync(
    join(projectPluginDir, "project-tool.ts"),
    [
      `import { Effect, Schema } from ${JSON.stringify(new URL("../../node_modules/effect/dist/esm/index.js", import.meta.url).href)};`,
      "export default () => ({",
      "  contributions: [{",
      "    kind: 'tool',",
      "    name: 'project-tool',",
      "    payload: {",
      "      description: 'Run project-tool.',",
      "      execute: () => Effect.succeed({ content: 'project-tool-result' }),",
      "      name: 'project-tool',",
      "      parameters: Schema.Struct({}),",
      "    },",
      "    priority: 0,",
      "  }],",
      "  manifest: { capabilities: [], name: 'project-tool-plugin', version: '1.0.0' },",
      "});",
      "",
    ].join("\n"),
  );

  const result = runBuiltBin(["-p", "--session-dir", sessionDir, FAKE_PROVIDER_PROMPT], {
    cwd: projectPath,
    env: { ...fakeProviderEnvironment(), POPEYE_USER_PLUGIN_DIR: userPluginDir },
  });

  expect(result.status).toBe(0);
  expect(startupRecords(result.stderr)).toMatchObject([{ toolCount: 1 }]);
});

test("the built RPC Head Snapshot audits the loaded Plugin generation and sorted Capability grants", () => {
  const projectPath = sessionDirectory();
  const projectPluginDir = join(projectPath, ".popeye", "plugins");
  const sessionDir = join(projectPath, "sessions");
  const userPluginDir = join(projectPath, "user-plugins");
  mkdirSync(projectPluginDir, { recursive: true });
  mkdirSync(userPluginDir, { recursive: true });
  writeFileSync(
    join(projectPluginDir, "snapshot-audit.ts"),
    [
      "export default () => ({",
      "  contributions: [],",
      "  manifest: {",
      "    capabilities: [{ name: 'shell' }, { name: 'filesystem-read' }],",
      "    name: 'snapshot-audit',",
      "    version: '1.0.0',",
      "  },",
      "});",
      "",
    ].join("\n"),
  );

  const result = runBuiltBin(["-p", "--mode", "rpc", "--session-dir", sessionDir], {
    cwd: projectPath,
    env: { ...fakeProviderEnvironment(), POPEYE_USER_PLUGIN_DIR: userPluginDir },
    input: `${JSON.stringify({ _tag: "create", id: "create-audited-session" })}\n`,
  });

  expect(result.status, result.stderr).toBe(0);
  const response = JSON.parse(result.stdout.trimEnd()) as {
    readonly result?: Record<string, unknown>;
  };
  expect(response.result).toMatchObject({
    capabilityGrants: ["filesystem-read", "shell"],
    loadedGeneration: {
      id: expect.any(String),
      plugins: ["compact", "reload", "session-name", "snapshot-audit"],
    },
  });
});

test("the built JSON Head emits only parseable wire lines and can resume its Session", () => {
  const directory = sessionDirectory();
  const first = runBuiltBin(
    ["-p", "--mode", "json", "--session-dir", directory, FAKE_PROVIDER_PROMPT],
    {
      env: fakeProviderEnvironment(),
    },
  );

  expect(first.status).toBe(0);
  const frames = first.stdout
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(frames.length).toBeGreaterThan(1);
  expect(frames).toContainEqual({ _tag: "assistantText", text: "Fake provider answer." });
  const snapshot = frames.at(-1);
  const sessionId = snapshot?.sessionId;
  expect(sessionId).toBeTypeOf("string");
  if (typeof sessionId !== "string") {
    throw new Error("JSON Head Snapshot did not contain a Session id.");
  }

  const resumed = runBuiltBin(
    ["-p", "--resume", sessionId, "--session-dir", directory, FAKE_PROVIDER_PROMPT],
    {
      env: fakeProviderEnvironment(),
    },
  );
  expect(resumed.status, resumed.stderr).toBe(0);
  expect(resumed.stdout).toBe("Fake provider answer.\n");
  expect(startupRecords(resumed.stderr)).toMatchObject([
    { mode: "print", sessionAction: `resume:${sessionId}` },
  ]);
}, 15_000);

test("the built JSON Head Snapshot audits the current process after Session resume", () => {
  const directory = sessionDirectory();
  const first = runBuiltBin(
    ["-p", "--mode", "json", "--session-dir", directory, FAKE_PROVIDER_PROMPT],
    { env: fakeProviderEnvironment() },
  );
  expect(first.status, first.stderr).toBe(0);
  const firstFrames = first.stdout
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const firstSnapshot = firstFrames.at(-1);
  const sessionId = firstSnapshot?.sessionId;
  expect(sessionId).toBeTypeOf("string");
  if (typeof sessionId !== "string") {
    throw new Error("JSON Head Snapshot did not contain a Session id.");
  }

  const resumed = runBuiltBin(
    [
      "-p",
      "--mode",
      "json",
      "--resume",
      sessionId,
      "--session-dir",
      directory,
      FAKE_PROVIDER_PROMPT,
    ],
    { env: fakeProviderEnvironment() },
  );

  expect(resumed.status, resumed.stderr).toBe(0);
  const resumedFrames = resumed.stdout
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(resumedFrames.at(-1)).toMatchObject({
    capabilityGrants: [],
    loadedGeneration: {
      id: expect.any(String),
      plugins: ["compact", "reload", "session-name"],
    },
    sessionId,
  });
});

test("the built JSON CLI exposes invalid project Plugin Tool arguments to the Provider", () => {
  const projectPath = sessionDirectory();
  const projectPluginDir = join(projectPath, ".popeye", "plugins");
  const sessionDir = join(projectPath, "sessions");
  const userPluginDir = join(projectPath, "user-plugins");
  const providerScriptPath = join(projectPath, "tool-provider.json");
  const prompt = "Run the project echo Tool.";
  mkdirSync(projectPluginDir, { recursive: true });
  mkdirSync(userPluginDir, { recursive: true });
  writeFileSync(
    join(projectPluginDir, "project-echo.ts"),
    [
      `import { Effect, Schema } from ${JSON.stringify(new URL("../../node_modules/effect/dist/esm/index.js", import.meta.url).href)};`,
      "export default () => ({",
      "  contributions: [{",
      "    kind: 'tool',",
      "    name: 'project-echo',",
      "    payload: {",
      "      description: 'Echo a project value.',",
      "      execute: ({ value }) => Effect.succeed({ content: 'echo:' + value }),",
      "      name: 'project-echo',",
      "      parameters: Schema.Struct({ value: Schema.String }),",
      "    },",
      "    priority: 0,",
      "  }],",
      "  manifest: { capabilities: [], name: 'project-echo-plugin', version: '1.0.0' },",
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    providerScriptPath,
    JSON.stringify({
      responses: [
        {
          items: [
            {
              _tag: "toolCall",
              argumentsJson: JSON.stringify({ unexpected: true }),
              id: "project-echo-call",
              name: "project-echo",
            },
            { _tag: "done", stopReason: "toolCalls" },
          ],
          prompt,
        },
        {
          items: [
            { _tag: "textDelta", text: "Provider observed the Tool error." },
            { _tag: "done", stopReason: "done" },
          ],
          prompt,
        },
      ],
    }),
  );

  const result = runBuiltBin(["-p", "--mode", "json", "--session-dir", sessionDir, prompt], {
    cwd: projectPath,
    env: {
      ...fakeProviderEnvironment(),
      POPEYE_FAKE_PROVIDER_SCRIPT: providerScriptPath,
      POPEYE_USER_PLUGIN_DIR: userPluginDir,
    },
  });
  const frames = result.stdout
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const snapshot = frames.at(-1) as
    | { readonly entries?: ReadonlyArray<{ readonly payload?: Record<string, unknown> }> }
    | undefined;
  const toolResult = snapshot?.entries?.find(
    (entry) => entry.payload?.role === "toolResult",
  )?.payload;

  expect(result.status).toBe(0);
  expect(frames).toContainEqual({
    _tag: "toolStarted",
    name: "project-echo",
    toolCallId: "project-echo-call",
  });
  expect(frames).toContainEqual({
    _tag: "toolCompleted",
    isError: true,
    toolCallId: "project-echo-call",
  });
  expect(frames).toContainEqual({
    _tag: "assistantText",
    text: "Provider observed the Tool error.",
  });
  expect(toolResult).toMatchObject({
    isError: true,
    role: "toolResult",
    toolCallId: "project-echo-call",
    toolName: "project-echo",
  });
  expect(toolResult?.content).toEqual(
    expect.stringContaining("Invalid arguments for tool project-echo"),
  );
  expect(startupRecords(result.stderr)).toMatchObject([{ toolCount: 1 }]);
}, 15_000);

test("the built RPC Head serves LF-delimited commands until stdin closes", () => {
  const result = runBuiltBin(["-p", "--mode", "rpc", "--session-dir", sessionDirectory()], {
    env: fakeProviderEnvironment(),
    input: `${JSON.stringify({ _tag: "list", id: "list-process" })}\n`,
  });

  expect(result.status).toBe(0);
  expect(
    result.stdout
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toMatchObject([{ id: "list-process", result: { _tag: "sessionList", sessions: [] } }]);
  expect(startupRecords(result.stderr)).toMatchObject([
    { mode: "rpc", sessionAction: "rpc-managed" },
  ]);
});

test("the built RPC Head closes a session with the terminal closed shape", () => {
  const sessionDir = sessionDirectory();
  const create = runBuiltBin(["-p", "--mode", "rpc", "--session-dir", sessionDir], {
    env: fakeProviderEnvironment(),
    input: `${JSON.stringify({ _tag: "create", id: "create-close" })}\n`,
  });

  expect(create.status, create.stderr).toBe(0);
  const sessionId = (
    JSON.parse(create.stdout.trimEnd()) as {
      readonly result?: { readonly sessionId?: unknown };
    }
  ).result?.sessionId;
  expect(sessionId).toBeTypeOf("string");
  if (typeof sessionId !== "string") {
    throw new Error("RPC create response did not contain a Session id.");
  }

  const result = runBuiltBin(["-p", "--mode", "rpc", "--session-dir", sessionDir], {
    env: fakeProviderEnvironment(),
    input: `${[
      { _tag: "resume", id: "resume-close", sessionId },
      { _tag: "close", id: "close-close", sessionId },
    ]
      .map((frame) => JSON.stringify(frame))
      .join("\n")}\n`,
  });

  expect(result.status, result.stderr).toBe(0);
  const lines = result.stdout
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(lines).toMatchObject([
    { id: "resume-close", result: { _tag: "snapshot" } },
    {
      id: "close-close",
      result: {
        _tag: "closed",
        cause: "clean",
        drainedWithinGrace: true,
        exitCode: 0,
        sessionId,
      },
    },
  ]);
});

test("the built RPC Head invokes a project Plugin Command", () => {
  const projectPath = sessionDirectory();
  const projectPluginDir = join(projectPath, ".popeye", "plugins");
  const sessionDir = join(projectPath, "sessions");
  const userPluginDir = join(projectPath, "user-plugins");
  mkdirSync(projectPluginDir, { recursive: true });
  mkdirSync(userPluginDir, { recursive: true });
  writeFileSync(
    join(projectPluginDir, "project-command.ts"),
    [
      `import { Effect, Schema } from ${JSON.stringify(new URL("../../node_modules/effect/dist/esm/index.js", import.meta.url).href)};`,
      "export default () => ({",
      "  contributions: [{",
      "    kind: 'command',",
      "    name: 'project-command',",
      "    payload: {",
      "      arguments: Schema.Struct({}),",
      "      description: 'Run project-command.',",
      "      execute: () => Effect.succeed('project-result'),",
      "      name: 'project-command',",
      "    },",
      "    priority: 0,",
      "  }],",
      "  manifest: { capabilities: [], name: 'project-command', version: '1.0.0' },",
      "});",
      "",
    ].join("\n"),
  );
  const env = { ...fakeProviderEnvironment(), POPEYE_USER_PLUGIN_DIR: userPluginDir };
  const create = runBuiltBin(["-p", "--mode", "rpc", "--session-dir", sessionDir], {
    cwd: projectPath,
    env,
    input: `${JSON.stringify({ _tag: "create", id: "create-project-command" })}\n`,
  });

  expect(create.status).toBe(0);
  const created = JSON.parse(create.stdout.trimEnd()) as {
    readonly result?: { readonly sessionId?: unknown };
  };
  const sessionId = created.result?.sessionId;
  expect(sessionId).toBeTypeOf("string");
  if (typeof sessionId !== "string") {
    throw new Error("RPC create response did not contain a Session id.");
  }

  const invoke = runBuiltBin(["-p", "--mode", "rpc", "--session-dir", sessionDir], {
    cwd: projectPath,
    env,
    input: `${[
      { _tag: "resume", id: "resume-project-command", sessionId },
      {
        _tag: "invoke-command",
        args: {},
        id: "invoke-project-command",
        name: "project-command",
        sessionId,
      },
    ]
      .map((frame) => JSON.stringify(frame))
      .join("\n")}\n`,
  });

  expect(invoke.status).toBe(0);
  expect(
    invoke.stdout
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toContainEqual({
    id: "invoke-project-command",
    result: {
      _tag: "commandInvoked",
      commandName: "project-command",
      value: "project-result",
    },
  });
});

test("the built bin reports bad arguments and missing config on stderr", () => {
  const badArguments = runBuiltBin(["--api-key", "secret-value", "-p", FAKE_PROVIDER_PROMPT]);
  const missingConfig = runBuiltBin(["-p", FAKE_PROVIDER_PROMPT]);

  expect(badArguments.status).toBe(2);
  expect(badArguments.stdout).toBe("");
  expect(badArguments.stderr).toContain("ERROR CliArgsError");
  expect(badArguments.stderr).toContain("POPEYE_API_KEY");
  expect(badArguments.stderr).not.toContain("secret-value");
  expect(missingConfig.status).toBe(2);
  expect(missingConfig.stdout).toBe("");
  expect(missingConfig.stderr).toContain("--model <model> or POPEYE_MODEL");
});

test("the built bin rejects empty stdin and explicit empty provider flags", () => {
  const whitespacePrompt = runBuiltBin(["-p", "--session-dir", sessionDirectory()], {
    env: fakeProviderEnvironment(),
    input: " \n\t",
  });
  const emptyModel = runBuiltBin(
    ["-p", "--model", "", "--session-dir", sessionDirectory(), FAKE_PROVIDER_PROMPT],
    { env: fakeProviderEnvironment() },
  );
  const emptyBaseUrl = runBuiltBin(
    ["-p", "--base-url", "", "--session-dir", sessionDirectory(), FAKE_PROVIDER_PROMPT],
    { env: fakeProviderEnvironment() },
  );

  for (const [result, flag] of [
    [whitespacePrompt, "Use popeye -p"],
    [emptyModel, "--model"],
    [emptyBaseUrl, "--base-url"],
  ] as const) {
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(flag);
  }
});

test("the built bin exits 2 when a Plugin throws during composition", () => {
  const root = sessionDirectory();
  const pluginPath = join(root, "throwing-plugin.ts");
  const userPluginDir = join(root, "user-plugins");
  mkdirSync(userPluginDir, { recursive: true });
  writeFileSync(pluginPath, 'throw new Error("fixture import explosion");\n');

  const result = runBuiltBin(
    ["-p", "--plugin", pluginPath, "--session-dir", join(root, "sessions"), FAKE_PROVIDER_PROMPT],
    {
      env: { ...fakeProviderEnvironment(), POPEYE_USER_PLUGIN_DIR: userPluginDir },
    },
  );

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("ERROR CliRunError");
  expect(result.stderr).toContain("composition_failed");
  expect(result.stderr).toContain(pluginPath);
  expect(result.stderr).toContain("fixture import explosion");
  // Contract: STARTUP carries toolCount, so it is written only after composition succeeds.
  expect(startupRecords(result.stderr)).toEqual([]);
});

test("questions and memory flags are no-op divergences with identical output", () => {
  const plain = runBuiltBin(["-p", "--session-dir", sessionDirectory(), FAKE_PROVIDER_PROMPT], {
    env: fakeProviderEnvironment(),
  });
  const diverged = runBuiltBin(
    [
      "-p",
      "--session-dir",
      sessionDirectory(),
      "--questions",
      "ask",
      "--memory",
      "--effort",
      "medium",
      FAKE_PROVIDER_PROMPT,
    ],
    { env: fakeProviderEnvironment() },
  );

  for (const result of [plain, diverged]) {
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Fake provider answer.\n");
  }
  expect(diverged.stdout).toBe(plain.stdout);
}, 15_000);
