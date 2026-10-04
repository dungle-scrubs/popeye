/**
 * Integration coverage for RFC-04 slice 1: Agent definitions load and
 * --agent starts a persona session. Runs the built bin against the fake
 * Provider so every case is deterministic and offline.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { FAKE_PROVIDER_PROMPT, fakeProviderEnvironment, runBuiltBin } from "../test-support/cli.js";
import { composeAppendedSystemPrompt } from "./cli-entry.js";

const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const tempDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "popeye-agents-"));
  temporaryDirectories.push(directory);
  return directory;
};

const writeAgent = (dir: string, fileName: string, content: string): string => {
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, fileName);
  writeFileSync(filePath, content, "utf8");
  return filePath;
};

const userAgent = (dir: string, name: string, extra = ""): string =>
  writeAgent(
    dir,
    `${name}.md`,
    `---\nname: ${name}\ndescription: ${name} agent\n${extra}---\n${name} persona body.\n`,
  );

/** A project root contributing one known tool named project-tool (see bin.test.ts). */
const projectWithToolPlugin = (): string => {
  const projectPath = tempDirectory();
  const projectPluginDir = join(projectPath, ".popeye", "plugins");
  mkdirSync(projectPluginDir, { recursive: true });
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
    "utf8",
  );
  return projectPath;
};

/**
 * The fake-Provider environment with an empty user Plugin directory, so Tool
 * counts never depend on Plugins installed in the real home directory.
 */
const isolatedEnvironment = (): NodeJS.ProcessEnv => ({
  ...fakeProviderEnvironment(),
  POPEYE_USER_PLUGIN_DIR: tempDirectory(),
});

const runAsAgent = (args: ReadonlyArray<string>, options: { agentsDir: string; cwd?: string }) =>
  runBuiltBin(["-p", "--session-dir", tempDirectory(), ...args, FAKE_PROVIDER_PROMPT], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...isolatedEnvironment(), POPEYE_AGENTS_DIR: options.agentsDir },
  });

test("the composed append text places the agent body first and drops empty bodies", () => {
  const agent = {
    body: "Persona body.",
    filePath: "/a.md",
    model: undefined,
    name: "a",
    tools: undefined,
  };
  const flagOnly = composeAppendedSystemPrompt({
    agent: undefined,
    appendSystemPrompt: "Flag fragment.",
  });
  const bodyOnly = composeAppendedSystemPrompt({ agent, appendSystemPrompt: undefined });
  const both = composeAppendedSystemPrompt({ agent, appendSystemPrompt: "Flag fragment." });
  const emptyBody = composeAppendedSystemPrompt({
    agent: { ...agent, body: "" },
    appendSystemPrompt: "Flag fragment.",
  });
  const neither = composeAppendedSystemPrompt({ agent: undefined, appendSystemPrompt: undefined });

  expect(flagOnly).toBe("Flag fragment.");
  expect(bodyOnly).toBe("Persona body.");
  expect(both).toBe("Persona body.\n\nFlag fragment.");
  expect(emptyBody).toBe("Flag fragment.");
  expect(neither).toBe("");
});

test("unknown --agent names fail startup listing available agents", () => {
  const agentsDir = tempDirectory();
  userAgent(agentsDir, "scout");
  const projectPath = tempDirectory();
  userAgent(join(projectPath, ".popeye", "agents"), "planner");

  const result = runBuiltBin(
    ["--agent", "ghost", "-p", "--session-dir", tempDirectory(), FAKE_PROVIDER_PROMPT],
    { cwd: projectPath, env: { ...fakeProviderEnvironment(), POPEYE_AGENTS_DIR: agentsDir } },
  );

  expect(result.status).toBe(2);
  expect(result.stderr).toContain(
    'ERROR CliConfigError: Unknown agent "ghost". Available agents: scout (user), planner (project).',
  );
});

test("--agent with --mode rpc is refused and points at the create and resume agent field", () => {
  const agentsDir = tempDirectory();
  userAgent(agentsDir, "scout");

  const result = runBuiltBin(
    ["--agent", "scout", "--mode", "rpc", "--session-dir", tempDirectory()],
    {
      env: { ...fakeProviderEnvironment(), POPEYE_AGENTS_DIR: agentsDir },
    },
  );

  expect(result.status).toBe(2);
  expect(result.stderr).toContain(
    "--agent is not accepted in RPC mode: name the Agent per Session with the agent field of the create and resume commands.",
  );
  expect(result.stderr).not.toContain("--agent have no RPC wire carrier");
}, 15_000);

test("an invalid definition is skipped with a diagnostic while a valid --agent run completes", () => {
  const agentsDir = tempDirectory();
  const brokenPath = writeAgent(
    agentsDir,
    "broken.md",
    "---\nname: broken\ndescription: [unclosed\n---\nBody.\n",
  );
  userAgent(agentsDir, "healthy");

  const result = runAsAgent(["--agent", "healthy"], { agentsDir });

  expect(result.status).toBe(0);
  expect(result.stderr).toContain("skipped");
  expect(result.stderr).toContain(brokenPath);
  expect(result.stderr).toContain("invalid YAML");
  expect(result.stderr).toContain('"agent":"healthy"');
});

test("two same-scope files with one name fail the load naming both files", () => {
  const agentsDir = tempDirectory();
  userAgent(agentsDir, "twin");
  writeAgent(agentsDir, "twin-again.md", "---\nname: twin\ndescription: d\n---\nB.\n");

  const result = runAsAgent(["--agent", "twin"], { agentsDir });

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Duplicate agent name");
  expect(result.stderr).toContain("twin.md");
  expect(result.stderr).toContain("twin-again.md");
});

test("a project-scope definition shadows the user-scope definition of the same name", () => {
  const agentsDir = tempDirectory();
  const projectPath = tempDirectory();
  userAgent(agentsDir, "shared");
  userAgent(join(projectPath, ".popeye", "agents"), "shared");

  // Shadowing is observable through the merged available-agents listing:
  // only the project-scope definition survives for that name.
  const result = runBuiltBin(
    ["--agent", "ghost", "-p", "--session-dir", tempDirectory(), FAKE_PROVIDER_PROMPT],
    { cwd: projectPath, env: { ...fakeProviderEnvironment(), POPEYE_AGENTS_DIR: agentsDir } },
  );

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Available agents: shared (project)");
  expect(result.stderr).not.toContain("shared (user)");
});

test("a tools list whose every name is unknown fails closed at startup", () => {
  const agentsDir = tempDirectory();
  userAgent(agentsDir, "locked", "tools: no-such-tool, also-missing\n");

  const result = runAsAgent(["--agent", "locked"], { agentsDir });

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Agent locked");
  expect(result.stderr).toContain("lists only tools this session does not grant");
  expect(result.stderr).toContain("no-such-tool");
  expect(result.stderr).toContain("also-missing");
});

test("partially unknown tool names ride the diagnostics channel and the run completes", () => {
  const agentsDir = tempDirectory();
  const projectPath = projectWithToolPlugin();
  userAgent(agentsDir, "mostly", "tools: project-tool, no-such-tool\n");

  const result = runAsAgent(["--agent", "mostly"], { agentsDir, cwd: projectPath });

  expect(result.status).toBe(0);
  expect(result.stderr).toContain("no-such-tool");
  expect(result.stderr).toContain('"agent":"mostly"');
  expect(startupAgentName(result.stderr)).toBe("mostly");
});

const startupAgentName = (stderr: string): string | undefined => {
  const line = stderr.split("\n").find((candidate) => candidate.startsWith("STARTUP "));
  if (line === undefined) {
    return undefined;
  }
  const record = JSON.parse(line.slice("STARTUP ".length)) as { agent?: string };
  return record.agent;
};

test("real pi agent files on this machine load and run unchanged through --agent", () => {
  const piAgentsDir = join(homedir(), ".pi", "agents");
  if (!existsSync(piAgentsDir)) {
    return; // Machine without pi agent files: nothing to prove here.
  }
  const piFile = readdirSync(piAgentsDir).find(
    (name) => name.endsWith(".md") && existsSync(join(piAgentsDir, name)),
  );
  if (piFile === undefined) {
    return;
  }
  const frontmatterName = /^name:\s*(\S+)\s*$/mu.exec(
    readFileSync(join(piAgentsDir, piFile), "utf8"),
  );
  const agentName = frontmatterName?.[1];
  if (agentName === undefined) {
    return;
  }

  const result = runAsAgent(["--agent", agentName], { agentsDir: piAgentsDir });

  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain("CliConfigError");
  expect(startupAgentName(result.stderr)).toBe(agentName);
});

test("a skip diagnostic is reported even when the selected name fails resolution", () => {
  const agentsDir = tempDirectory();
  const brokenPath = writeAgent(
    agentsDir,
    "broken.md",
    "---\nname: broken\ndescription: [unclosed\n---\nBody.\n",
  );

  const result = runBuiltBin(
    ["--agent", "missing", "-p", "--session-dir", tempDirectory(), FAKE_PROVIDER_PROMPT],
    { env: { ...fakeProviderEnvironment(), POPEYE_AGENTS_DIR: agentsDir } },
  );

  expect(result.status).toBe(2);
  expect(result.stderr).toContain(`Agent definition ${brokenPath} skipped`);
  expect(result.stderr).toContain("invalid YAML");
  expect(result.stderr).toContain('Unknown agent "missing"');
});

// ---------------------------------------------------------------------------
// Issue #53 / RFC-04 slice 2: the Agent tools list narrows the Tool grant.
// ---------------------------------------------------------------------------

/** Tools the multi-tool fixture contributes; the default grant adds manage-goal. */
const FIXTURE_TOOL_NAMES = ["read", "grep", "bash", "edit"] as const;
const DEFAULT_TOOL_COUNT = FIXTURE_TOOL_NAMES.length + 1;

/** A project root whose one Plugin contributes read, grep, bash, and edit. */
const projectWithFixtureTools = (): string => {
  const projectPath = tempDirectory();
  const projectPluginDir = join(projectPath, ".popeye", "plugins");
  mkdirSync(projectPluginDir, { recursive: true });
  writeFileSync(
    join(projectPluginDir, "fixture-tools.ts"),
    [
      `import { Effect, Schema } from ${JSON.stringify(new URL("../../node_modules/effect/dist/esm/index.js", import.meta.url).href)};`,
      `const names = ${JSON.stringify(FIXTURE_TOOL_NAMES)};`,
      "export default () => ({",
      "  contributions: names.map((name) => ({",
      "    kind: 'tool',",
      "    name,",
      "    payload: {",
      "      description: 'Run ' + name + '.',",
      "      execute: () => Effect.succeed({ content: name + '-result' }),",
      "      name,",
      "      parameters: Schema.Struct({}),",
      "    },",
      "    priority: 0,",
      "  })),",
      "  manifest: { capabilities: [], name: 'fixture-tools-plugin', version: '1.0.0' },",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  return projectPath;
};

const startupToolCount = (stderr: string): number | undefined => {
  const line = stderr.split("\n").find((candidate) => candidate.startsWith("STARTUP "));
  if (line === undefined) {
    return undefined;
  }
  const record = JSON.parse(line.slice("STARTUP ".length)) as { toolCount?: number };
  return record.toolCount;
};

const runFixtureAgent = (agentFrontmatter: string, flags: ReadonlyArray<string> = []) => {
  const agentsDir = tempDirectory();
  const projectPath = projectWithFixtureTools();
  const agentPath = userAgent(agentsDir, "narrow", agentFrontmatter);
  const result = runAsAgent(["--agent", "narrow", ...flags], { agentsDir, cwd: projectPath });
  return { agentPath, result };
};

test("the fixture Plugin grants every Tool without --agent", () => {
  const result = runBuiltBin(["-p", "--session-dir", tempDirectory(), FAKE_PROVIDER_PROMPT], {
    cwd: projectWithFixtureTools(),
    env: isolatedEnvironment(),
  });

  expect(result.status).toBe(0);
  expect(startupToolCount(result.stderr)).toBe(DEFAULT_TOOL_COUNT);
});

test("an agent with tools: read, bash is offered exactly that intersection", () => {
  const { result } = runFixtureAgent("tools: read, bash\n");

  expect(result.status).toBe(0);
  expect(startupToolCount(result.stderr)).toBe(2);
});

test("a Tool outside the agent's list is not offered: the model's call to it is unknown", () => {
  const agentsDir = tempDirectory();
  const projectPath = projectWithFixtureTools();
  userAgent(agentsDir, "narrow", "tools: read, bash\n");
  const prompt = "Call one granted and one withheld Tool.";
  const scriptPath = join(tempDirectory(), "agent-tools-provider.json");
  writeFileSync(
    scriptPath,
    JSON.stringify({
      responses: [
        {
          items: [
            { _tag: "toolCall", argumentsJson: "{}", id: "call-read", name: "read" },
            { _tag: "toolCall", argumentsJson: "{}", id: "call-edit", name: "edit" },
            { _tag: "done", stopReason: "toolCalls" },
          ],
          prompt,
        },
        {
          items: [
            { _tag: "textDelta", text: "Done." },
            { _tag: "done", stopReason: "done" },
          ],
          prompt,
        },
      ],
    }),
    "utf8",
  );

  const result = runBuiltBin(
    ["--agent", "narrow", "-p", "--mode", "json", "--session-dir", tempDirectory(), prompt],
    {
      cwd: projectPath,
      env: {
        ...isolatedEnvironment(),
        POPEYE_AGENTS_DIR: agentsDir,
        POPEYE_FAKE_PROVIDER_SCRIPT: scriptPath,
      },
    },
  );
  const frames = result.stdout
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const snapshot = frames.at(-1) as
    | { readonly entries?: ReadonlyArray<{ readonly payload?: Record<string, unknown> }> }
    | undefined;
  const toolResult = (toolCallId: string) =>
    snapshot?.entries?.find(
      (entry) => entry.payload?.role === "toolResult" && entry.payload.toolCallId === toolCallId,
    )?.payload;

  expect(result.status).toBe(0);
  expect(startupToolCount(result.stderr)).toBe(2);
  expect(frames).toContainEqual({ _tag: "toolCompleted", isError: false, toolCallId: "call-read" });
  expect(frames).toContainEqual({ _tag: "toolCompleted", isError: true, toolCallId: "call-edit" });
  expect(toolResult("call-read")?.content).toEqual(expect.stringContaining("read-result"));
  expect(toolResult("call-edit")?.content).toEqual(expect.stringContaining("Unknown tool: edit."));
}, 15_000);

test("--exclude-tools removes a Tool from the agent's intersection", () => {
  const { result } = runFixtureAgent("tools: read, bash\n", ["--exclude-tools", "bash"]);

  expect(result.status).toBe(0);
  expect(startupToolCount(result.stderr)).toBe(1);
});

test("--access read intersects the agent's list with the read preset", () => {
  const { result } = runFixtureAgent("tools: read, bash\n", ["--access", "read"]);

  expect(result.status).toBe(0);
  expect(startupToolCount(result.stderr)).toBe(1);
});

test("--tools intersects with the agent's list and never widens it", () => {
  const { result } = runFixtureAgent("tools: read, bash\n", ["--tools", "read,grep,edit"]);

  expect(result.status).toBe(0);
  expect(startupToolCount(result.stderr)).toBe(1);
});

test("an overlapping --exclude-tools still subtracts when --tools and the agent list both name the Tool", () => {
  const { result } = runFixtureAgent("tools: read, bash\n", [
    "--tools",
    "read,bash,edit",
    "--exclude-tools",
    "bash",
  ]);

  expect(result.status).toBe(0);
  expect(startupToolCount(result.stderr)).toBe(1);
});

test("an absent or empty tools key leaves the default grant unchanged", () => {
  for (const frontmatter of ["", 'tools: ""\n', "tools: []\n"]) {
    const { result } = runFixtureAgent(frontmatter);

    expect(result.status).toBe(0);
    // The discoverable definition also registers the delegate Tool (RFC-04 §6, issue #56).
    expect(startupToolCount(result.stderr)).toBe(DEFAULT_TOOL_COUNT + 1);
  }
}, 30_000);

test("partially unknown names print a diagnostic naming each and run with the known subset", () => {
  const { agentPath, result } = runFixtureAgent("tools: read, no-such-tool, also-missing\n");
  const lines = result.stderr.split("\n");
  const warningIndex = lines.indexOf(
    `Agent narrow (${agentPath}) names tools this session does not grant: no-such-tool, also-missing. The session runs with the granted subset: read.`,
  );
  const startupIndex = lines.findIndex((line) => line.startsWith("STARTUP "));

  expect(result.status).toBe(0);
  expect(warningIndex).toBeGreaterThanOrEqual(0);
  expect(startupIndex).toBeGreaterThan(warningIndex);
  expect(startupToolCount(result.stderr)).toBe(1);
});

test("native: names and duplicates reach the startup diagnostic stripped and deduplicated", () => {
  const { agentPath, result } = runFixtureAgent(
    "tools: native:read, native:read, no-such-tool, no-such-tool\n",
  );
  const lines = result.stderr.split("\n");
  const warnings = lines.filter((line) => line.startsWith("Agent narrow ("));
  const warningIndex = lines.indexOf(
    `Agent narrow (${agentPath}) names tools this session does not grant: no-such-tool. The session runs with the granted subset: native:read.`,
  );
  const startupIndex = lines.findIndex((line) => line.startsWith("STARTUP "));

  expect(result.status).toBe(0);
  expect(warnings).toHaveLength(1);
  expect(warningIndex).toBeGreaterThanOrEqual(0);
  expect(startupIndex).toBeGreaterThan(warningIndex);
  expect(startupToolCount(result.stderr)).toBe(1);
});

test("a list whose every name is outside the granted set fails closed, even when flags removed them", () => {
  const { result } = runFixtureAgent("tools: bash\n", ["--exclude-tools", "bash"]);

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("lists only tools this session does not grant: bash");
  expect(startupToolCount(result.stderr)).toBeUndefined();
});

test("--no-project-plugins makes a project-only --agent unknown and lists only user Agents", () => {
  const projectPath = tempDirectory();
  const agentsDir = tempDirectory();
  userAgent(join(projectPath, ".popeye", "agents"), "project-only");
  userAgent(agentsDir, "user-only");
  const result = runAsAgent(["--no-project-plugins", "--agent", "project-only"], {
    agentsDir,
    cwd: projectPath,
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain(
    'Unknown agent "project-only". Available agents: user-only (user).',
  );
  expect(result.stderr).not.toContain("project-only (project)");
}, 15_000);
