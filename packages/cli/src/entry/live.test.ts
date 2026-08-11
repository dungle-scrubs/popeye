/**
 * Runs the built CLI against a real OpenAI-compatible loopback Provider.
 *
 * PEYE_LIVE_ENDPOINT=http://127.0.0.1:1234/v1 PEYE_LIVE_MODEL=<id> pnpm vitest run --project @peye/cli src/entry/live.test.ts
 *
 * The suite is skipped unless both variables are set. It removes every supported API-key variable
 * from spawned processes so the print Turn is the exact keyless-loopback regression case.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Snapshot } from "@peye/protocol";
import { decodeProgress, decodeSnapshot } from "@peye/protocol";
import { Effect } from "effect";
import { afterEach, beforeAll, expect, test } from "vitest";

import { BUILT_BIN_PATH, cleanCliEnvironment, WORKSPACE_PATH } from "../test-support/cli.js";

const LIVE_PROCESS_TIMEOUT_MS = 170_000;
const LIVE_TEST_TIMEOUT_MS = 180_000;
const temporaryDirectories: Array<string> = [];

const liveEndpoint = process.env.PEYE_LIVE_ENDPOINT;
const liveModel = process.env.PEYE_LIVE_MODEL;
const liveConfig =
  liveEndpoint === undefined || liveModel === undefined
    ? undefined
    : { endpoint: liveEndpoint, model: liveModel };

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface LiveProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exit: Promise<ProcessExit>;
  readonly stderr: () => string;
}

const sessionDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "peye-cli-live-"));
  temporaryDirectories.push(directory);
  return directory;
};

const liveEnvironment = (): NodeJS.ProcessEnv => {
  if (liveConfig === undefined) {
    throw new Error("Live Provider configuration was removed after test selection.");
  }
  return {
    ...cleanCliEnvironment(),
    PEYE_BASE_URL: liveConfig.endpoint,
    PEYE_MODEL: liveConfig.model,
  };
};

const spawnLiveBin = (args: ReadonlyArray<string>): LiveProcess => {
  const child = spawn(process.execPath, [BUILT_BIN_PATH, ...args], {
    cwd: WORKSPACE_PATH,
    env: liveEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exit = new Promise<ProcessExit>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, LIVE_PROCESS_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Live CLI process timed out. stderr:\n${stderr}`));
        return;
      }
      resolve({ code, signal });
    });
  });

  return { child, exit, stderr: (): string => stderr };
};

const runLiveBin = async (
  args: ReadonlyArray<string>,
): Promise<ProcessExit & { readonly stderr: string; readonly stdout: string }> => {
  const processRun = spawnLiveBin(args);
  let stdout = "";
  processRun.child.stdout.setEncoding("utf8");
  processRun.child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  processRun.child.stdin.end();
  const result = await processRun.exit;
  return { ...result, stderr: processRun.stderr(), stdout };
};

const lines = (stream: string): ReadonlyArray<string> => stream.trimEnd().split("\n");

const hasAssistantMessage = (snapshot: Snapshot): boolean =>
  snapshot.entries.some((entry) => {
    if (entry.kind !== "message" || typeof entry.payload !== "object" || entry.payload === null) {
      return false;
    }
    return "role" in entry.payload && entry.payload.role === "assistant";
  });

const record = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Expected an object RPC frame.");
  }
  return value as Readonly<Record<string, unknown>>;
};

const rpcSnapshot = (
  frame: Readonly<Record<string, unknown>>,
  correlationId: string,
): Readonly<Record<string, unknown>> => {
  expect(frame).toMatchObject({ id: correlationId, result: { _tag: "snapshot" } });
  return record(frame.result);
};

beforeAll(() => {
  if (liveConfig === undefined) {
    return;
  }
  const result = spawnSync("pnpm", ["build"], {
    cwd: WORKSPACE_PATH,
    encoding: "utf8",
    env: cleanCliEnvironment(),
    timeout: 120_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}, 130_000);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

test.skipIf(liveConfig === undefined)(
  "live CLI: keyless loopback print Turn returns an answer",
  async () => {
    const result = await runLiveBin([
      "-p",
      "--session-dir",
      sessionDirectory(),
      "Reply with one short sentence.",
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout.trim()).not.toBe("");
  },
  LIVE_TEST_TIMEOUT_MS,
);

test.skipIf(liveConfig === undefined)(
  "live CLI: JSON Head emits Protocol Progress and a final Snapshot",
  async () => {
    const result = await runLiveBin([
      "-p",
      "--mode",
      "json",
      "--session-dir",
      sessionDirectory(),
      "Reply with one short sentence.",
    ]);

    expect(result.code, result.stderr).toBe(0);
    const frames = lines(result.stdout).map((line) => JSON.parse(line) as unknown);
    for (const frame of frames.slice(0, -1)) {
      await Effect.runPromise(decodeProgress(frame));
    }
    const snapshot = await Effect.runPromise(decodeSnapshot(frames.at(-1)));
    expect(snapshot.sessionId).not.toBe("");
    expect(hasAssistantMessage(snapshot)).toBe(true);
  },
  LIVE_TEST_TIMEOUT_MS,
);

test.skipIf(liveConfig === undefined)(
  "live CLI: RPC Head creates, prompts, returns a correlated Snapshot, and detaches",
  async () => {
    const processRun = spawnLiveBin(["-p", "--mode", "rpc", "--session-dir", sessionDirectory()]);
    const output = createInterface({
      crlfDelay: Number.POSITIVE_INFINITY,
      input: processRun.child.stdout,
    });
    const iterator = output[Symbol.asyncIterator]();
    const readResponse = async (
      correlationId: string,
    ): Promise<Readonly<Record<string, unknown>>> => {
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) {
          throw new Error(
            `RPC stdout closed before ${correlationId}. stderr:\n${processRun.stderr()}`,
          );
        }
        const frame = record(JSON.parse(next.value) as unknown);
        if (frame.id === correlationId) {
          return frame;
        }
      }
    };
    const writeCommand = (command: Readonly<Record<string, unknown>>): void => {
      processRun.child.stdin.write(`${JSON.stringify(command)}\n`);
    };

    try {
      writeCommand({ _tag: "create", id: "create-live" });
      const created = rpcSnapshot(await readResponse("create-live"), "create-live");
      const sessionId = created.sessionId;
      expect(sessionId).toBeTypeOf("string");
      if (typeof sessionId !== "string") {
        throw new TypeError("RPC create response did not contain a Session id.");
      }

      writeCommand({
        _tag: "prompt",
        content: "Reply with one short sentence.",
        id: "prompt-live",
        sessionId,
      });
      const prompted = rpcSnapshot(await readResponse("prompt-live"), "prompt-live");
      expect(prompted).toMatchObject({ sessionId });
      expect(prompted.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "message",
            payload: expect.objectContaining({ role: "assistant" }),
          }),
        ]),
      );

      writeCommand({ _tag: "detach", id: "detach-live", sessionId });
      const detached = rpcSnapshot(await readResponse("detach-live"), "detach-live");
      expect(detached).toMatchObject({ attached: false, sessionId });
    } finally {
      processRun.child.stdin.end();
    }

    const result = await processRun.exit;
    expect(result.code, processRun.stderr()).toBe(0);
    expect(result.signal).toBeNull();
  },
  LIVE_TEST_TIMEOUT_MS,
);
