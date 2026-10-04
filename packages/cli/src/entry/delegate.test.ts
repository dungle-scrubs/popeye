/**
 * Built-bin coverage for the delegate Tool (RFC-04 §6, issue #56): registration follows Agent
 * discovery at startup, and a headless parent delegates end to end through the fake Provider.
 * The fake Provider script is one process-wide sequence, so the parent and the child take
 * turns in order: parent Tool call, child answer, parent answer.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { fakeProviderEnvironment, runBuiltBin, WORKSPACE_PATH } from "../test-support/cli.js";

const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const tempDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "popeye-delegate-bin-"));
  temporaryDirectories.push(directory);
  return directory;
};

const writeAgent = (dir: string, fileName: string, content: string): string => {
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, fileName);
  writeFileSync(filePath, content, "utf8");
  return filePath;
};

const helperAgent = (dir: string): string =>
  writeAgent(dir, "helper.md", "---\nname: helper\ndescription: helper agent\n---\nYou help.\n");

interface ScriptResponse {
  readonly items: ReadonlyArray<Record<string, unknown>>;
  readonly prompt?: string;
}

const writeScript = (responses: ReadonlyArray<ScriptResponse>): string => {
  const scriptPath = join(tempDirectory(), "delegate-provider.json");
  writeFileSync(scriptPath, JSON.stringify({ responses }), "utf8");
  return scriptPath;
};

/** Fake-Provider environment with empty Plugin dirs; Agent dirs come from each test. */
const environment = (options: {
  readonly agentsDir?: string;
  readonly scriptPath?: string;
}): NodeJS.ProcessEnv => ({
  ...fakeProviderEnvironment(),
  POPEYE_USER_PLUGIN_DIR: tempDirectory(),
  ...(options.agentsDir === undefined ? {} : { POPEYE_AGENTS_DIR: options.agentsDir }),
  ...(options.scriptPath === undefined ? {} : { POPEYE_FAKE_PROVIDER_SCRIPT: options.scriptPath }),
});

const startupToolCount = (stderr: string): number | undefined => {
  const line = stderr.split("\n").find((candidate) => candidate.startsWith("STARTUP "));
  return line === undefined
    ? undefined
    : (JSON.parse(line.slice("STARTUP ".length)) as { toolCount?: number }).toolCount;
};

interface SnapshotFrame {
  readonly entries?: ReadonlyArray<{ readonly payload?: Record<string, unknown> }>;
  readonly sessionId?: string;
}

const lastSnapshot = (stdout: string): SnapshotFrame | undefined =>
  stdout
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as SnapshotFrame & { readonly _tag?: string })
    .filter((frame) => frame.entries !== undefined)
    .at(-1);

const toolResultContent = (snapshot: SnapshotFrame | undefined, toolCallId: string): unknown =>
  snapshot?.entries?.find(
    (entry) => entry.payload?.role === "toolResult" && entry.payload.toolCallId === toolCallId,
  )?.payload?.content;

const PARENT_PROMPT = "Delegate the greeting.";

const callDelegate = (agent: string, task: string): ScriptResponse => ({
  items: [
    {
      _tag: "toolCall",
      argumentsJson: JSON.stringify({ agent, task }),
      id: "call-delegate",
      name: "delegate",
    },
    { _tag: "done", stopReason: "toolCalls" },
  ],
  prompt: PARENT_PROMPT,
});

const answer = (text: string, prompt: string): ScriptResponse => ({
  items: [
    { _tag: "textDelta", text },
    { _tag: "done", stopReason: "done" },
  ],
  prompt,
});

test("with no Agent definition discoverable the delegate Tool is absent from the model's tool list", () => {
  const scriptPath = writeScript([
    callDelegate("helper", "Say hi"),
    answer("Parent done.", PARENT_PROMPT),
  ]);

  const result = runBuiltBin(
    ["-p", "--mode", "json", "--session-dir", tempDirectory(), PARENT_PROMPT],
    { env: environment({ scriptPath }) },
  );

  expect(result.status, result.stderr).toBe(0);
  expect(startupToolCount(result.stderr)).toBe(1);
  expect(toolResultContent(lastSnapshot(result.stdout), "call-delegate")).toEqual(
    expect.stringContaining("Unknown tool: delegate."),
  );
  expect(result.stderr).not.toContain("Agent definition");
}, 15_000);

test("one discoverable Agent definition registers the delegate Tool", () => {
  const agentsDir = tempDirectory();
  helperAgent(agentsDir);

  const result = runBuiltBin(["-p", "--session-dir", tempDirectory(), "Hello."], {
    env: environment({
      agentsDir,
      scriptPath: writeScript([answer("Hi.", "Hello.")]),
    }),
  });

  expect(result.status, result.stderr).toBe(0);
  expect(startupToolCount(result.stderr)).toBe(2);
}, 15_000);

test("a headless parent delegates end to end: the child's final message is the Tool result and the child Session is real and resumable", () => {
  const agentsDir = tempDirectory();
  helperAgent(agentsDir);
  const sessionDir = tempDirectory();

  const parentRun = runBuiltBin(
    ["-p", "--mode", "json", "--session-dir", sessionDir, PARENT_PROMPT],
    {
      env: environment({
        agentsDir,
        scriptPath: writeScript([
          callDelegate("helper", "Say hi"),
          answer("hi from helper", "Task: Say hi"),
          answer("Parent done.", PARENT_PROMPT),
        ]),
      }),
    },
  );
  const parentSnapshot = lastSnapshot(parentRun.stdout);
  const sessionFiles = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
  const childFile = sessionFiles.find((name) => name !== `${parentSnapshot?.sessionId}.jsonl`);

  expect(parentRun.status, parentRun.stderr).toBe(0);
  expect(toolResultContent(parentSnapshot, "call-delegate")).toBe("hi from helper");
  expect(sessionFiles).toHaveLength(2);
  expect(childFile).toBeDefined();
  expect(readFileSync(join(sessionDir, childFile ?? "missing"), "utf8")).toContain("Task: Say hi");

  const childId = (childFile ?? "missing.jsonl").slice(0, -".jsonl".length);
  const resumeRun = runBuiltBin(
    ["-p", "--mode", "json", "--session-dir", sessionDir, "--resume", childId, "Continue."],
    {
      env: environment({
        agentsDir,
        scriptPath: writeScript([answer("resumed", "Continue.")]),
      }),
    },
  );
  const resumed = lastSnapshot(resumeRun.stdout);
  const contents = resumed?.entries?.map((entry) => entry.payload?.content) ?? [];

  expect(resumeRun.status, resumeRun.stderr).toBe(0);
  expect(resumed?.sessionId).toBe(childId);
  expect(contents).toEqual(expect.arrayContaining(["Task: Say hi", "hi from helper", "resumed"]));
}, 30_000);

/** stderr lines discovery could add: per-file skip reports and any discovery failure text. */
const agentLines = (stderr: string): ReadonlyArray<string> =>
  stderr.split("\n").filter((line) => line.startsWith("Agent definition"));

test("without --agent a discovery load error changes nothing: no stderr line and no delegate Tool", () => {
  const agentsDir = tempDirectory();
  helperAgent(agentsDir);
  writeAgent(agentsDir, "helper-again.md", "---\nname: helper\ndescription: d\n---\nB.\n");

  const result = runBuiltBin(["-p", "--session-dir", tempDirectory(), "Hello."], {
    env: environment({ agentsDir, scriptPath: writeScript([answer("Hi.", "Hello.")]) }),
  });

  expect(result.status, result.stderr).toBe(0);
  expect(agentLines(result.stderr)).toEqual([]);
  expect(result.stderr).not.toContain("Duplicate agent name");
  expect(startupToolCount(result.stderr)).toBe(1);
}, 15_000);

test("without --agent only malformed definitions change nothing: no skip report and no delegate Tool", () => {
  const agentsDir = tempDirectory();
  writeAgent(agentsDir, "broken.md", "---\nname: broken\ndescription: [unclosed\n---\nBody.\n");

  const result = runBuiltBin(["-p", "--session-dir", tempDirectory(), "Hello."], {
    env: environment({ agentsDir, scriptPath: writeScript([answer("Hi.", "Hello.")]) }),
  });

  expect(result.status, result.stderr).toBe(0);
  expect(agentLines(result.stderr)).toEqual([]);
  expect(startupToolCount(result.stderr)).toBe(1);
}, 15_000);

test("without --agent only rejected-shape definitions change nothing: no skip report and no delegate Tool", () => {
  const agentsDir = tempDirectory();
  writeAgent(
    agentsDir,
    "shapeless.md",
    "---\nname: shapeless\ndescription: d\ntools: 42\n---\nB.\n",
  );
  writeAgent(agentsDir, "nameless.md", "---\ndescription: d\n---\nB.\n");

  const result = runBuiltBin(["-p", "--session-dir", tempDirectory(), "Hello."], {
    env: environment({ agentsDir, scriptPath: writeScript([answer("Hi.", "Hello.")]) }),
  });

  expect(result.status, result.stderr).toBe(0);
  expect(agentLines(result.stderr)).toEqual([]);
  expect(startupToolCount(result.stderr)).toBe(1);
}, 15_000);

test("without --agent a skipped definition is reported while the valid ones register the delegate Tool", () => {
  const agentsDir = tempDirectory();
  helperAgent(agentsDir);
  const brokenPath = writeAgent(
    agentsDir,
    "broken.md",
    "---\nname: broken\ndescription: [unclosed\n---\nBody.\n",
  );

  const result = runBuiltBin(["-p", "--session-dir", tempDirectory(), "Hello."], {
    env: environment({ agentsDir, scriptPath: writeScript([answer("Hi.", "Hello.")]) }),
  });

  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain(`Agent definition ${brokenPath} skipped`);
  expect(startupToolCount(result.stderr)).toBe(2);
}, 15_000);

test("--no-project-plugins leaves delegate unregistered for a project-only Agent", () => {
  const projectPath = tempDirectory();
  helperAgent(join(projectPath, ".popeye", "agents"));
  const result = runBuiltBin(
    ["-p", "--no-project-plugins", "--session-dir", tempDirectory(), "Hello."],
    { cwd: projectPath, env: environment({ scriptPath: writeScript([answer("Hi.", "Hello.")]) }) },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(startupToolCount(result.stderr)).toBe(1);
}, 15_000);

test("the default built-bin cwd ignores repository-local Agent definitions", () => {
  const directory = join(WORKSPACE_PATH, ".popeye", "agents");
  const parent = join(WORKSPACE_PATH, ".popeye");
  const directoryExisted = existsSync(directory);
  const parentExisted = existsSync(parent);
  const filePath = join(directory, `test-hermetic-${process.pid}.md`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(filePath, "---\nname: test-hermetic\ndescription: test agent\n---\nPersona.\n", {
    flag: "wx",
  });
  try {
    const result = runBuiltBin(["-p", "--session-dir", tempDirectory(), "Hello."], {
      env: environment({ scriptPath: writeScript([answer("Hi.", "Hello.")]) }),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(startupToolCount(result.stderr)).toBe(1);
  } finally {
    rmSync(filePath);
    if (!directoryExisted && readdirSync(directory).length === 0) rmdirSync(directory);
    if (!parentExisted && readdirSync(parent).length === 0) rmdirSync(parent);
  }
}, 15_000);
