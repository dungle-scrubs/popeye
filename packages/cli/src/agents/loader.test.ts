import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Effect, Exit } from "effect";
import { expect, test } from "vitest";

import { AgentDiscoveryError, discoverAgents } from "./loader.js";

const makeTempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "popeye-agents-"));

const writeDefinition = async (dir: string, name: string, content: string): Promise<string> => {
  const filePath = join(dir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, content, "utf8");
  return filePath;
};

const PLANNER = `---
name: planner
description: Creates implementation plans
tools: read, grep, find
model: some-model
unknown-key: ignored
---

You are a planning specialist.
You must NOT make any changes.
`;

test("parses a pi-format definition: four keys, body, unknown keys ignored", async () => {
  const userDir = await makeTempDir();
  await writeDefinition(userDir, "planner.md", PLANNER);

  const result = await Effect.runPromise(
    discoverAgents({ projectPath: await makeTempDir(), userDir }),
  );

  const planner = result.agents.get("planner");
  expect(planner).toBeDefined();
  expect(planner).toMatchObject({
    body: "You are a planning specialist.\nYou must NOT make any changes.",
    description: "Creates implementation plans",
    model: "some-model",
    name: "planner",
    scope: "user",
    tools: ["read", "grep", "find"],
  });
  expect(result.diagnostics).toEqual([]);
});

test("normalizes a tools list: arrays, non-strings, blanks, and the empty result", async () => {
  const userDir = await makeTempDir();
  await writeDefinition(
    userDir,
    "mixed.md",
    '---\nname: mixed\ndescription: d\ntools: [" read ", "", 7, "grep"]\n---\nBody.\n',
  );
  await writeDefinition(
    userDir,
    "empty.md",
    '---\nname: empty\ndescription: d\ntools: [ "", 7 ]\n---\nBody.\n',
  );
  await writeDefinition(userDir, "absent.md", "---\nname: absent\ndescription: d\n---\nBody.\n");

  const result = await Effect.runPromise(
    discoverAgents({ projectPath: await makeTempDir(), userDir }),
  );

  expect(result.agents.get("mixed")?.tools).toEqual(["read", "grep"]);
  expect(result.agents.get("empty")?.tools).toBeUndefined();
  expect(result.agents.get("absent")?.tools).toBeUndefined();
});

test("an invalid YAML file is skipped with a diagnostic naming it; other agents still load", async () => {
  const userDir = await makeTempDir();
  await writeDefinition(
    userDir,
    "broken.md",
    "---\nname: broken\ndescription: [unclosed\n---\nBody.\n",
  );
  await writeDefinition(userDir, "healthy.md", "---\nname: healthy\ndescription: d\n---\nBody.\n");

  const result = await Effect.runPromise(
    discoverAgents({ projectPath: await makeTempDir(), userDir }),
  );

  expect(result.agents.has("broken")).toBe(false);
  expect(result.agents.get("healthy")?.name).toBe("healthy");
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.filePath).toBe(join(userDir, "broken.md"));
  expect(result.diagnostics[0]?.detail).toContain("invalid YAML");
});

test("files missing a string name or description are skipped with a diagnostic", async () => {
  const userDir = await makeTempDir();
  await writeDefinition(userDir, "nameless.md", "---\ndescription: d\n---\nBody.\n");
  await writeDefinition(userDir, "indescribeable.md", "---\nname: n\n---\nBody.\n");
  await writeDefinition(userDir, "scalar.md", "---\njust a scalar\n---\nBody.\n");

  const result = await Effect.runPromise(
    discoverAgents({ projectPath: await makeTempDir(), userDir }),
  );

  expect(result.agents.size).toBe(0);
  expect(result.diagnostics).toHaveLength(3);
  // Files are parsed in sorted-name order: indescribeable, nameless, scalar.
  expect(result.diagnostics.map((diagnostic) => diagnostic.detail)).toEqual([
    "frontmatter has no string description",
    "frontmatter has no string name",
    "frontmatter is not a mapping",
  ]);
});

test("a non-mapping tools value is a rejected shape, not a silent no-restriction", async () => {
  const userDir = await makeTempDir();
  await writeDefinition(
    userDir,
    "numeric.md",
    "---\nname: numeric\ndescription: d\ntools: 5\n---\nBody.\n",
  );

  const result = await Effect.runPromise(
    discoverAgents({ projectPath: await makeTempDir(), userDir }),
  );

  expect(result.agents.size).toBe(0);
  expect(result.diagnostics[0]?.detail).toContain(
    "tools must be a comma-separated string or a list",
  );
});

test("two same-scope files with one name fail the load naming both files", async () => {
  const userDir = await makeTempDir();
  await writeDefinition(userDir, "twin-a.md", "---\nname: twin\ndescription: d\n---\nA.\n");
  await writeDefinition(userDir, "twin-b.md", "---\nname: twin\ndescription: d\n---\nB.\n");

  const failure = await Effect.runPromiseExit(
    discoverAgents({ projectPath: await makeTempDir(), userDir }),
  );

  expect(Exit.isFailure(failure)).toBe(true);
  if (Exit.isFailure(failure)) {
    const error = Cause.squash(failure.cause);
    expect(error).toBeInstanceOf(AgentDiscoveryError);
    const discoveryError = error as AgentDiscoveryError;
    expect(discoveryError.reason).toBe("agent_duplicate_name");
    expect(discoveryError.message).toContain("twin-a.md");
    expect(discoveryError.message).toContain("twin-b.md");
  }
});

test("a project-scope definition shadows a user-scope definition with the same name", async () => {
  const userDir = await makeTempDir();
  const projectPath = await makeTempDir();
  await writeDefinition(
    userDir,
    "shared.md",
    "---\nname: shared\ndescription: user version\n---\nUser body.\n",
  );
  await writeDefinition(
    join(projectPath, ".popeye", "agents"),
    "shared.md",
    "---\nname: shared\ndescription: project version\n---\nProject body.\n",
  );
  await writeDefinition(
    userDir,
    "user-only.md",
    "---\nname: user-only\ndescription: d\n---\nBody.\n",
  );

  const result = await Effect.runPromise(discoverAgents({ projectPath, userDir }));

  const shared = result.agents.get("shared");
  expect(shared?.scope).toBe("project");
  expect(shared?.body).toBe("Project body.");
  expect(result.agents.get("user-only")?.scope).toBe("user");
  expect(result.agents.size).toBe(2);
});

test("a project-scope symlink that escapes the project is rejected", async () => {
  const userDir = await makeTempDir();
  const projectPath = await makeTempDir();
  const outsideDir = await makeTempDir();
  const outsideFile = await writeDefinition(
    outsideDir,
    "outside.md",
    "---\nname: outside\ndescription: d\n---\nBody.\n",
  );
  const projectAgentsDir = join(projectPath, ".popeye", "agents");
  await mkdir(projectAgentsDir, { recursive: true });
  await symlink(outsideFile, join(projectAgentsDir, "escaping.md"));

  const exit = await Effect.runPromiseExit(discoverAgents({ projectPath, userDir }));

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause);
    expect(error).toBeInstanceOf(AgentDiscoveryError);
    const discoveryError = error as AgentDiscoveryError;
    expect(discoveryError.reason).toBe("agent_symlink_escape");
    expect(discoveryError.message).toContain("escaping.md");
    expect(discoveryError.message).toContain("outside the project");
  }
});

test("a user-scope symlink loads normally", async () => {
  const realDir = await makeTempDir();
  const userDir = await makeTempDir();
  const realFile = await writeDefinition(
    realDir,
    "linked.md",
    "---\nname: linked\ndescription: d\n---\nBody.\n",
  );
  await symlink(realFile, join(userDir, "linked.md"));

  const result = await Effect.runPromise(
    discoverAgents({ projectPath: await makeTempDir(), userDir }),
  );

  expect(result.agents.get("linked")?.name).toBe("linked");
  expect(result.diagnostics).toEqual([]);
});

test("missing directories, non-markdown files, and nested directories are ignored", async () => {
  const userDir = await makeTempDir();
  const projectPath = await makeTempDir();
  await writeFile(join(userDir, "notes.txt"), "not an agent", "utf8");
  await mkdir(join(userDir, "nested.md"));
  await writeDefinition(
    join(userDir, "sub", "dir"),
    "nested.md",
    "---\nname: nested\ndescription: d\n---\nBody.\n",
  );

  const result = await Effect.runPromise(discoverAgents({ projectPath, userDir }));

  expect(result.agents.size).toBe(0);
  expect(result.diagnostics).toEqual([]);
});

test("an empty body is preserved as an empty string (appends nothing)", async () => {
  const userDir = await makeTempDir();
  await writeDefinition(userDir, "bare.md", "---\nname: bare\ndescription: d\n---\n");

  const result = await Effect.runPromise(
    discoverAgents({ projectPath: await makeTempDir(), userDir }),
  );

  expect(result.agents.get("bare")?.body).toBe("");
});

test("CRLF and BOM content parses unchanged, matching pi", async () => {
  const userDir = await makeTempDir();
  await writeDefinition(
    userDir,
    "windows.md",
    "---\r\nname: windows\r\ndescription: d\r\n---\r\n\r\nWindows body.\r\n",
  );

  const result = await Effect.runPromise(
    discoverAgents({ projectPath: await makeTempDir(), userDir }),
  );

  expect(result.agents.get("windows")?.body).toBe("Windows body.");
});

test("resolveUserAgentsDir honors POPEYE_AGENTS_DIR over the default", async () => {
  const { resolveUserAgentsDir } = await import("../entry/config.js");
  expect(resolveUserAgentsDir({ POPEYE_AGENTS_DIR: "/custom/agents" })).toBe("/custom/agents");
  expect(resolveUserAgentsDir({})).toBe(join(homedir(), ".popeye", "agents"));
});

test("a symlinked project agents directory pointing outside the project is rejected", async () => {
  const userDir = await makeTempDir();
  const projectPath = await makeTempDir();
  const outsideDir = await makeTempDir();
  await writeDefinition(
    outsideDir,
    "external.md",
    "---\nname: external\ndescription: d\n---\nBody.\n",
  );
  const popeyeDir = join(projectPath, ".popeye");
  await mkdir(popeyeDir, { recursive: true });
  await symlink(outsideDir, join(popeyeDir, "agents"));

  const exit = await Effect.runPromiseExit(discoverAgents({ projectPath, userDir }));

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause);
    expect(error).toBeInstanceOf(AgentDiscoveryError);
    const discoveryError = error as AgentDiscoveryError;
    expect(discoveryError.reason).toBe("agent_symlink_escape");
    expect(discoveryError.message).toContain("external.md");
  }
});

test("a project agents directory symlinked within the project loads normally", async () => {
  const userDir = await makeTempDir();
  const projectPath = await makeTempDir();
  const internalAgents = await writeDefinition(
    join(projectPath, "shared", "agents"),
    "internal.md",
    "---\nname: internal\ndescription: d\n---\nBody.\n",
  );
  void internalAgents;
  const popeyeDir = join(projectPath, ".popeye");
  await mkdir(popeyeDir, { recursive: true });
  await symlink(join(projectPath, "shared", "agents"), join(popeyeDir, "agents"));

  const result = await Effect.runPromise(discoverAgents({ projectPath, userDir }));

  expect(result.agents.get("internal")?.name).toBe("internal");
  expect(result.diagnostics).toEqual([]);
});
