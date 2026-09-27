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

const runAsAgent = (args: ReadonlyArray<string>, options: { agentsDir: string; cwd?: string }) =>
  runBuiltBin(["-p", "--session-dir", tempDirectory(), ...args, FAKE_PROVIDER_PROMPT], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...fakeProviderEnvironment(), POPEYE_AGENTS_DIR: options.agentsDir },
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

test("--agent with --mode rpc is refused like --system-prompt", () => {
  const agentsDir = tempDirectory();
  userAgent(agentsDir, "scout");

  const result = runBuiltBin(
    ["--agent", "scout", "--mode", "rpc", "--session-dir", tempDirectory()],
    {
      env: { ...fakeProviderEnvironment(), POPEYE_AGENTS_DIR: agentsDir },
    },
  );

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("--agent have no RPC wire carrier");
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
  expect(result.stderr).toContain("lists only tools unknown to this process");
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
