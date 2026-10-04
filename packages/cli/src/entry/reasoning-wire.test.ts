import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { afterEach, expect, test } from "vitest";

import { BUILT_BIN_PATH, cleanCliEnvironment, runBuiltBin } from "../test-support/cli.js";

const FETCH_PRELOAD_PATH = new URL("../../test-fixtures/reasoning-wire-fetch.mjs", import.meta.url)
  .pathname;
const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const offlineInvocation = () => {
  const directory = mkdtempSync(join(tmpdir(), "popeye-reasoning-wire-"));
  temporaryDirectories.push(directory);
  const userPlugins = join(directory, "user-plugins");
  mkdirSync(userPlugins);
  const capture = join(directory, "requests.ndjson");
  const env = cleanCliEnvironment();
  delete env.NODE_OPTIONS;
  return {
    capture,
    cwd: directory,
    env: {
      ...env,
      POPEYE_BASE_URL: "http://127.0.0.1:1/v1",
      POPEYE_MODEL: "offline-reasoning-model",
      POPEYE_TEST_WIRE_CAPTURE: capture,
      POPEYE_USER_PLUGIN_DIR: userPlugins,
    },
    sessionDir: join(directory, "sessions"),
  };
};

const requestBodies = (path: string): ReadonlyArray<Readonly<Record<string, unknown>>> =>
  readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);

const efforts = [
  [undefined, undefined],
  ["off", "none"],
  ["low", "minimal"],
  ["medium-low", "low"],
  ["medium", "medium"],
  ["medium-high", "high"],
  ["high", "xhigh"],
  ["xhigh", "xhigh"],
] as const;

for (const mode of ["print", "json", "hcn"] as const) {
  test.each(efforts)(
    `built ${mode} Head effort %s sends reasoning_effort %s without network`,
    (effort, wireWord) => {
      const invocation = offlineInvocation();
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          FETCH_PRELOAD_PATH,
          BUILT_BIN_PATH,
          "-p",
          "--mode",
          mode,
          "--session-dir",
          invocation.sessionDir,
          "--no-project-plugins",
          "--exclude-tools",
          "manage-goal",
          ...(effort === undefined ? [] : ["--effort", effort]),
          "Name three rivers in Thailand. Reply with only the names.",
        ],
        {
          cwd: invocation.cwd,
          encoding: "utf8",
          env: invocation.env,
          timeout: 15_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const requests = requestBodies(invocation.capture);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ model: "offline-reasoning-model", stream: true });
      expect(requests[0]).not.toHaveProperty("tools");
      if (wireWord === undefined) {
        expect(requests[0]).not.toHaveProperty("reasoning_effort");
      } else {
        expect(requests[0]).toHaveProperty("reasoning_effort", wireWord);
      }
    },
    20_000,
  );
}

test.each(["print", "json", "hcn"] as const)(
  "built %s Head refuses registry non-reasoning effort before transport",
  (mode) => {
    const invocation = offlineInvocation();
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        FETCH_PRELOAD_PATH,
        BUILT_BIN_PATH,
        "-p",
        "--mode",
        mode,
        "--session-dir",
        invocation.sessionDir,
        "--no-project-plugins",
        "--exclude-tools",
        "manage-goal",
        "--effort",
        "medium",
        "Reply OK.",
      ],
      {
        cwd: invocation.cwd,
        encoding: "utf8",
        env: { ...invocation.env, POPEYE_MODEL: "gpt-4o" },
        timeout: 15_000,
      },
    );
    expect(result.error).toBeUndefined();
    const requests = existsSync(invocation.capture) ? requestBodies(invocation.capture) : [];
    expect(requests).toHaveLength(0);
    expect(result.status, result.stderr).toBe(1);
    const message =
      'Thinking level "medium" cannot be applied to model openai/gpt-4o: the model does not support reasoning. Omit the thinking level or choose a reasoning-capable model.';
    if (mode === "print") {
      expect(result.stdout).toBe("\n");
    } else {
      const frames = result.stdout
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
      if (mode === "hcn") {
        expect(frames).toContainEqual({ kind: "error", message, terminal: true });
      } else {
        expect(frames.at(-1)).toMatchObject({
          entries: expect.arrayContaining([
            expect.objectContaining({
              payload: expect.objectContaining({
                diagnostic: expect.objectContaining({
                  detail: message,
                  reason: "provider_error",
                  transient: false,
                }),
                role: "assistant",
                stopReason: "error",
              }),
            }),
          ]),
        });
      }
    }
  },
  20_000,
);

test.each([
  ["off", "none"],
  ["max", "xhigh"],
] as const)(
  "built RPC set-thinking %s sends reasoning_effort %s without network",
  async (thinkingLevel, wireWord) => {
    const invocation = offlineInvocation();
    const child = spawn(
      process.execPath,
      [
        "--import",
        FETCH_PRELOAD_PATH,
        BUILT_BIN_PATH,
        "-p",
        "--mode",
        "rpc",
        "--session-dir",
        invocation.sessionDir,
        "--no-project-plugins",
        "--exclude-tools",
        "manage-goal",
      ],
      { cwd: invocation.cwd, env: invocation.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    const output = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    const iterator = output[Symbol.asyncIterator]();
    const send = (command: Readonly<Record<string, unknown>>): void => {
      child.stdin.write(`${JSON.stringify(command)}\n`);
    };
    const response = async (id: string): Promise<Readonly<Record<string, unknown>>> => {
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) {
          throw new Error(`RPC stdout closed waiting for ${id}. stderr:\n${stderr}`);
        }
        const frame = JSON.parse(next.value) as Readonly<Record<string, unknown>>;
        if (frame.id === id) {
          return frame;
        }
      }
    };
    try {
      send({ _tag: "create", id: "create" });
      const created = await response("create");
      expect(created).toMatchObject({ result: { _tag: "snapshot" } });
      const snapshot = created.result as Readonly<Record<string, unknown>>;
      const sessionId = snapshot.sessionId;
      expect(typeof sessionId).toBe("string");
      send({ _tag: "set-thinking", id: "thinking", sessionId, thinkingLevel });
      expect(await response("thinking")).toMatchObject({
        result: { _tag: "snapshot", sessionId, thinkingLevel },
      });
      send({ _tag: "prompt", content: "Reply OK.", id: "prompt", sessionId });
      expect(await response("prompt")).toMatchObject({
        result: { _tag: "snapshot", phase: "IDLE" },
      });
      child.stdin.end();
      expect(await exit, stderr).toBe(0);
      const requests = requestBodies(invocation.capture);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toHaveProperty("reasoning_effort", wireWord);
      const resumed = spawnSync(
        process.execPath,
        [
          "--import",
          FETCH_PRELOAD_PATH,
          BUILT_BIN_PATH,
          "-p",
          "--resume",
          String(sessionId),
          "--session-dir",
          invocation.sessionDir,
          "--no-project-plugins",
          "--exclude-tools",
          "manage-goal",
          "--effort",
          "off",
          "Reply OK.",
        ],
        { cwd: invocation.cwd, encoding: "utf8", env: invocation.env, timeout: 15_000 },
      );
      expect(resumed.error).toBeUndefined();
      expect(resumed.status, resumed.stderr).toBe(0);
      const resumedRequests = requestBodies(invocation.capture);
      expect(resumedRequests).toHaveLength(2);
      expect(resumedRequests[1]).toHaveProperty("reasoning_effort", "none");
    } finally {
      clearTimeout(timer);
      output.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await exit;
    }
  },
  20_000,
);

test("built help exposes reasoning words, wire mapping, RPC control, and existing grant flags", () => {
  const help = runBuiltBin(["--help"]);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain(
    "--effort <level>         Set reasoning: off, low, medium-low, medium, medium-high, high, xhigh.",
  );
  expect(help.stdout).toContain(
    "Models pi-ai does not know, reached through --base-url, send reasoning_effort:",
  );
  expect(help.stdout).toContain(
    "off=none, low=minimal, medium-low=low, medium=medium, medium-high=high, high=xhigh, xhigh=xhigh.",
  );
  expect(help.stdout).toContain(
    "With no explicit Turn level, saved Session level, or Provider layer default, those models\nsend no field. Reasoning levels are endpoint hints, not timing guarantees.",
  );
  expect(help.stdout).toContain("Reasoning levels are endpoint hints, not timing guarantees.");
  expect(help.stdout).toContain(
    "RPC: use set-thinking with Kernel levels; off sends reasoning_effort none to those models.",
  );
  expect(help.stdout).toContain(
    "An explicit level for a registry model without reasoning support ends the Turn with a\nProvider error (exit 1 in print, JSON, and HCN). Registry reasoning models use pi-ai's\nmodel-specific mapping; off is not guaranteed to disable reasoning for those models.",
  );
  const flags = ["--effort", "--exclude-tools", "--headless", "--isolation", "--skills", "--tools"];
  for (const [index, flag] of flags.entries()) {
    expect(help.stdout).toContain(flag);
    const nextFlag = flags[index + 1];
    if (nextFlag !== undefined) {
      expect(help.stdout.indexOf(flag)).toBeLessThan(help.stdout.indexOf(nextFlag));
    }
  }
  expect(help.stdout).toContain(
    "--exclude-tools <names>  Exclude contributed Tools by comma-separated name;\n                           native:<name> is accepted.",
  );
  expect(help.stdout).toContain(
    "--isolation tool-free    Load first-party Plugins only and expose no Tools.",
  );
  expect(help.stdout).toContain(
    "--skills <names>         Allow only comma-separated Plugin names; this is not a trust setting.",
  );
  expect(help.stdout).toContain(
    "--tools <names>          Allow only contributed Tools by comma-separated name;\n                           native:<name> is accepted.",
  );
});
