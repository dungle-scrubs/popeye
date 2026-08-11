/**
 * Runs the built CLI against real OpenAI-compatible Providers.
 *
 * Run the full local set with:
 * PEYE_LIVE_ENDPOINT=http://127.0.0.1:1234/v1 \
 * PEYE_LIVE_MODEL=lmstudio-community/qwen3.6-27b-mlx \
 * PEYE_LIVE_MODEL_ALT=openai/gpt-oss-20b \
 * pnpm vitest run --project @pop-eye/cli src/entry/live.test.ts
 *
 * The local suite is skipped unless PEYE_LIVE_ENDPOINT and PEYE_LIVE_MODEL are set. Spawned local
 * processes have every supported API-key variable removed, so they exercise keyless loopback.
 * The hosted case has a separate PEYE_LIVE_HOSTED_ENDPOINT, PEYE_LIVE_HOSTED_MODEL, and
 * PEYE_LIVE_HOSTED_API_KEY gate. A supported CLI API-key variable can supply the hosted key too.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Progress, Snapshot } from "@pop-eye/protocol";
import { decodeProgress, decodeSnapshot } from "@pop-eye/protocol";
import { Effect } from "effect";
import { afterEach, beforeAll, expect, test } from "vitest";

import { BUILT_BIN_PATH, cleanCliEnvironment, WORKSPACE_PATH } from "../test-support/cli.js";

const LIVE_PROCESS_TIMEOUT_MS = 170_000;
const LIVE_TEST_TIMEOUT_MS = 180_000;
const temporaryDirectories: Array<string> = [];

interface LiveProviderConfig {
  readonly apiKey?: string;
  readonly endpoint: string;
  readonly model: string;
}

const configured = (value: string | undefined): string | undefined =>
  value === undefined || value.length === 0 ? undefined : value;

const providerConfig = (
  endpoint: string | undefined,
  model: string | undefined,
  apiKey?: string,
): LiveProviderConfig | undefined => {
  const resolvedEndpoint = configured(endpoint);
  const resolvedModel = configured(model);
  if (resolvedEndpoint === undefined || resolvedModel === undefined) {
    return undefined;
  }
  const resolvedApiKey = configured(apiKey);
  return {
    ...(resolvedApiKey === undefined ? {} : { apiKey: resolvedApiKey }),
    endpoint: resolvedEndpoint,
    model: resolvedModel,
  };
};

const liveConfig = providerConfig(process.env.PEYE_LIVE_ENDPOINT, process.env.PEYE_LIVE_MODEL);
const liveModelAlt = configured(process.env.PEYE_LIVE_MODEL_ALT);
const hostedApiKey = configured(
  process.env.PEYE_LIVE_HOSTED_API_KEY ??
    process.env.PEYE_API_KEY ??
    process.env.OPENAI_API_KEY ??
    process.env.ANTHROPIC_API_KEY,
);
const hostedConfig =
  hostedApiKey === undefined
    ? undefined
    : providerConfig(
        process.env.PEYE_LIVE_HOSTED_ENDPOINT,
        process.env.PEYE_LIVE_HOSTED_MODEL,
        hostedApiKey,
      );

// runRpcHead awaits each frame handler. A prompt therefore blocks the same input loop from reading
// an abort frame until the Turn has already settled. Keep the complete test body ready for when RPC
// command dispatch supports an in-flight abort.
const RPC_MID_STREAM_ABORT_UNAVAILABLE = true;

// The executable composes ToolRegistryLive([]) and static first-party command Plugins. It does not
// discover, trust, load, or adapt project Plugin Tool Contributions into the model Tool registry.
const CLI_PROJECT_TOOL_LOADING_UNAVAILABLE = true;

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface LiveProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exit: Promise<ProcessExit>;
  readonly stderr: () => string;
}

interface LiveRpcProcess extends LiveProcess {
  readonly close: () => void;
  readonly readFrame: (
    predicate: (frame: Readonly<Record<string, unknown>>) => boolean,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly readResponse: (correlationId: string) => Promise<Readonly<Record<string, unknown>>>;
  readonly writeCommand: (command: Readonly<Record<string, unknown>>) => void;
}

interface JsonHeadOutput {
  readonly progress: ReadonlyArray<Progress>;
  readonly snapshot: Snapshot;
}

const sessionDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "peye-cli-live-"));
  temporaryDirectories.push(directory);
  return directory;
};

const requireLiveConfig = (): LiveProviderConfig => {
  if (liveConfig === undefined) {
    throw new Error("Live Provider configuration was removed after test selection.");
  }
  return liveConfig;
};

const liveEnvironment = (config: LiveProviderConfig): NodeJS.ProcessEnv => ({
  ...cleanCliEnvironment(),
  ...(config.apiKey === undefined ? {} : { PEYE_API_KEY: config.apiKey }),
  PEYE_BASE_URL: config.endpoint,
  PEYE_MODEL: config.model,
});

const spawnLiveBin = (
  args: ReadonlyArray<string>,
  config: LiveProviderConfig = requireLiveConfig(),
): LiveProcess => {
  const child = spawn(process.execPath, [BUILT_BIN_PATH, ...args], {
    cwd: WORKSPACE_PATH,
    env: liveEnvironment(config),
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
  config: LiveProviderConfig = requireLiveConfig(),
): Promise<ProcessExit & { readonly stderr: string; readonly stdout: string }> => {
  const processRun = spawnLiveBin(args, config);
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

const record = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Expected an object frame.");
  }
  return value as Readonly<Record<string, unknown>>;
};

const parseJsonHeadOutput = async (stdout: string): Promise<JsonHeadOutput> => {
  const frames = lines(stdout).map((line) => JSON.parse(line) as unknown);
  const snapshot = await Effect.runPromise(decodeSnapshot(frames.at(-1)));
  const progress = await Promise.all(
    frames.slice(0, -1).map((frame) => Effect.runPromise(decodeProgress(frame))),
  );
  return { progress, snapshot };
};

const messagePayload = (
  entry: Snapshot["entries"][number],
): Readonly<Record<string, unknown>> | undefined =>
  entry.kind === "message" && typeof entry.payload === "object" && entry.payload !== null
    ? (entry.payload as Readonly<Record<string, unknown>>)
    : undefined;

const assistantTexts = (snapshot: Snapshot): ReadonlyArray<string> =>
  snapshot.entries.flatMap((entry): ReadonlyArray<string> => {
    const payload = messagePayload(entry);
    return payload?.role === "assistant" && typeof payload.content === "string"
      ? [payload.content]
      : [];
  });

const assistantStopReasons = (snapshot: Snapshot): ReadonlyArray<string> =>
  snapshot.entries.flatMap((entry): ReadonlyArray<string> => {
    const payload = messagePayload(entry);
    return payload?.role === "assistant" && typeof payload.stopReason === "string"
      ? [payload.stopReason]
      : [];
  });

const hasAssistantMessage = (snapshot: Snapshot): boolean => assistantTexts(snapshot).length > 0;

const startupRecords = (stderr: string): ReadonlyArray<Readonly<Record<string, unknown>>> =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith("STARTUP "))
    .map((line) => record(JSON.parse(line.slice("STARTUP ".length)) as unknown));

const startLiveRpc = (directory: string): LiveRpcProcess => {
  const processRun = spawnLiveBin(["-p", "--mode", "rpc", "--session-dir", directory]);
  const output = createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: processRun.child.stdout,
  });
  const iterator = output[Symbol.asyncIterator]();
  const buffered: Array<Readonly<Record<string, unknown>>> = [];

  const readFrame: LiveRpcProcess["readFrame"] = async (predicate) => {
    for (;;) {
      const bufferedIndex = buffered.findIndex(predicate);
      if (bufferedIndex >= 0) {
        const [frame] = buffered.splice(bufferedIndex, 1);
        if (frame === undefined) {
          throw new Error("RPC frame buffer lost a matched frame.");
        }
        return frame;
      }

      const next = await iterator.next();
      if (next.done === true) {
        throw new Error(
          `RPC stdout closed before the expected frame. stderr:\n${processRun.stderr()}`,
        );
      }
      const frame = record(JSON.parse(next.value) as unknown);
      if (predicate(frame)) {
        return frame;
      }
      buffered.push(frame);
    }
  };

  return {
    ...processRun,
    close: (): void => {
      processRun.child.stdin.end();
    },
    readFrame,
    readResponse: (correlationId) => readFrame((frame) => frame.id === correlationId),
    writeCommand: (command): void => {
      processRun.child.stdin.write(`${JSON.stringify(command)}\n`);
    },
  };
};

const rpcSnapshot = async (
  frame: Readonly<Record<string, unknown>>,
  correlationId: string,
): Promise<Snapshot> => {
  expect(frame).toMatchObject({ id: correlationId, result: { _tag: "snapshot" } });
  return Effect.runPromise(decodeSnapshot(frame.result));
};

const createRpcSession = async (rpc: LiveRpcProcess, correlationId: string): Promise<string> => {
  rpc.writeCommand({ _tag: "create", id: correlationId });
  return (await rpcSnapshot(await rpc.readResponse(correlationId), correlationId)).sessionId;
};

const expectCleanRpcExit = async (rpc: LiveRpcProcess): Promise<void> => {
  const result = await rpc.exit;
  expect(result.code, rpc.stderr()).toBe(0);
  expect(result.signal).toBeNull();
};

beforeAll(() => {
  if (liveConfig === undefined && hostedConfig === undefined) {
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
    const output = await parseJsonHeadOutput(result.stdout);
    expect(output.snapshot.sessionId).not.toBe("");
    expect(hasAssistantMessage(output.snapshot)).toBe(true);
  },
  LIVE_TEST_TIMEOUT_MS,
);

test.skipIf(liveConfig === undefined)(
  "live CLI: RPC Head creates, prompts, returns a correlated Snapshot, and detaches",
  async () => {
    const rpc = startLiveRpc(sessionDirectory());

    try {
      const sessionId = await createRpcSession(rpc, "create-live");
      rpc.writeCommand({
        _tag: "prompt",
        content: "Reply with one short sentence.",
        id: "prompt-live",
        sessionId,
      });
      const prompted = await rpcSnapshot(await rpc.readResponse("prompt-live"), "prompt-live");
      expect(prompted.sessionId).toBe(sessionId);
      expect(hasAssistantMessage(prompted)).toBe(true);

      rpc.writeCommand({ _tag: "detach", id: "detach-live", sessionId });
      const detached = await rpc.readResponse("detach-live");
      expect(detached).toMatchObject({
        id: "detach-live",
        result: { _tag: "snapshot", attached: false, sessionId },
      });
    } finally {
      rpc.close();
    }

    await expectCleanRpcExit(rpc);
  },
  LIVE_TEST_TIMEOUT_MS,
);

test.skipIf(liveConfig === undefined)(
  "live CLI: JSON Progress streams assistant text only during STREAMING and settles last",
  async () => {
    const result = await runLiveBin([
      "-p",
      "--mode",
      "json",
      "--session-dir",
      sessionDirectory(),
      "Write two short sentences about Bangkok.",
    ]);

    expect(result.code, result.stderr).toBe(0);
    const output = await parseJsonHeadOutput(result.stdout);
    let phase: unknown;
    let streamingIndex = -1;
    const textIndexes: Array<number> = [];

    for (const [index, progress] of output.progress.entries()) {
      if (progress._tag === "phaseChanged") {
        phase = progress.phase;
        if (progress.phase === "STREAMING") {
          streamingIndex = index;
        }
      }
      if (progress._tag === "assistantText") {
        expect(phase).toBe("STREAMING");
        expect(progress.text).not.toBe("");
        textIndexes.push(index);
      }
    }

    expect(streamingIndex).toBeGreaterThanOrEqual(0);
    expect(textIndexes.length).toBeGreaterThan(0);
    expect(textIndexes.every((index) => index > streamingIndex)).toBe(true);
    expect(output.progress.at(-1)).toMatchObject({ _tag: "turnSettled", stopReason: "done" });
    expect(hasAssistantMessage(output.snapshot)).toBe(true);
  },
  LIVE_TEST_TIMEOUT_MS,
);

test.skipIf(liveConfig === undefined)(
  "live CLI: one RPC process preserves Context across Turns in the same Session",
  async () => {
    const rpc = startLiveRpc(sessionDirectory());

    try {
      const sessionId = await createRpcSession(rpc, "create-context");
      rpc.writeCommand({
        _tag: "prompt",
        content: "My name is Ada. Reply OK.",
        id: "remember-name",
        sessionId,
      });
      const first = await rpcSnapshot(await rpc.readResponse("remember-name"), "remember-name");
      expect(hasAssistantMessage(first)).toBe(true);

      rpc.writeCommand({
        _tag: "prompt",
        content: "What is my name? Reply with only the name.",
        id: "recall-name",
        sessionId,
      });
      const second = await rpcSnapshot(await rpc.readResponse("recall-name"), "recall-name");
      expect(assistantTexts(second).at(-1)).toMatch(/Ada/iu);
    } finally {
      rpc.close();
    }

    await expectCleanRpcExit(rpc);
  },
  LIVE_TEST_TIMEOUT_MS,
);

test.skipIf(liveConfig === undefined)(
  "live CLI: a new process resumes durable Context from the same Journal directory",
  async () => {
    const directory = sessionDirectory();
    const first = await runLiveBin([
      "-p",
      "--mode",
      "json",
      "--session-dir",
      directory,
      "Remember this code word: DURABLE-ADA. Reply with only OK.",
    ]);

    expect(first.code, first.stderr).toBe(0);
    const firstOutput = await parseJsonHeadOutput(first.stdout);
    const resumed = await runLiveBin([
      "-p",
      "--resume",
      firstOutput.snapshot.sessionId,
      "--session-dir",
      directory,
      "What code word did I ask you to remember? Reply with only the code word.",
    ]);

    expect(resumed.code, resumed.stderr).toBe(0);
    expect(resumed.signal).toBeNull();
    expect(resumed.stdout).toMatch(/DURABLE-ADA/iu);
    expect(startupRecords(resumed.stderr)).toMatchObject([
      { sessionAction: `resume:${firstOutput.snapshot.sessionId}` },
    ]);
  },
  LIVE_TEST_TIMEOUT_MS,
);

test.skipIf(liveConfig === undefined || liveModelAlt === undefined)(
  "live CLI: --model selects each requested live model",
  async () => {
    const config = requireLiveConfig();
    if (liveModelAlt === undefined) {
      throw new Error("Alternate live model was removed after test selection.");
    }

    for (const model of [config.model, liveModelAlt]) {
      const result = await runLiveBin([
        "-p",
        "--model",
        model,
        "--session-dir",
        sessionDirectory(),
        "Reply with only OK.",
      ]);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.trim()).not.toBe("");
      expect(startupRecords(result.stderr)).toMatchObject([{ model }]);
    }
  },
  LIVE_TEST_TIMEOUT_MS,
);

test.skipIf(liveConfig === undefined || RPC_MID_STREAM_ABORT_UNAVAILABLE)(
  "live CLI: RPC abort interrupts a streaming Turn and leaves the Session usable [blocked: RPC frame dispatch is sequential]",
  async () => {
    const rpc = startLiveRpc(sessionDirectory());

    try {
      const sessionId = await createRpcSession(rpc, "create-abort");
      rpc.writeCommand({ _tag: "subscribe-progress", id: "subscribe-abort", sessionId });
      await rpc.readResponse("subscribe-abort");
      rpc.writeCommand({
        _tag: "prompt",
        content: "Write a detailed answer with at least 2,000 words about distributed systems.",
        id: "long-turn",
        sessionId,
      });
      const textFrame = await rpc.readFrame((frame) => frame._tag === "assistantText");
      await Effect.runPromise(decodeProgress(textFrame));

      rpc.writeCommand({ _tag: "abort", id: "abort-live", sessionId });
      expect(await rpc.readResponse("abort-live")).toMatchObject({
        id: "abort-live",
        result: { _tag: "abortTurnAborted", aborted: true },
      });
      const aborted = await rpcSnapshot(await rpc.readResponse("long-turn"), "long-turn");
      expect(assistantStopReasons(aborted).at(-1)).toBe("aborted");

      rpc.writeCommand({
        _tag: "prompt",
        content: "Reply with only SESSION-USABLE.",
        id: "after-abort",
        sessionId,
      });
      const followUp = await rpcSnapshot(await rpc.readResponse("after-abort"), "after-abort");
      expect(assistantTexts(followUp).at(-1)).toMatch(/SESSION-USABLE/iu);
      expect(assistantStopReasons(followUp).at(-1)).toBe("done");
    } finally {
      rpc.close();
    }

    await expectCleanRpcExit(rpc);
  },
  LIVE_TEST_TIMEOUT_MS,
);

test.skipIf(liveConfig === undefined || CLI_PROJECT_TOOL_LOADING_UNAVAILABLE)(
  "live CLI: project Plugin Tool calling records toolCalls, toolResult, and the final answer [blocked: CLI does not load project Plugin Tools]",
  () => {
    throw new Error(
      "CLI project Plugin discovery, Trust, loading, and model Tool registration are not composed.",
    );
  },
  LIVE_TEST_TIMEOUT_MS,
);

test.skipIf(hostedConfig === undefined)(
  "live CLI: keyed hosted Provider returns an answer",
  async () => {
    if (hostedConfig === undefined) {
      throw new Error("Hosted Provider configuration was removed after test selection.");
    }
    const result = await runLiveBin(
      ["-p", "--session-dir", sessionDirectory(), "Reply with one short sentence."],
      hostedConfig,
    );

    expect(result.code, result.stderr).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout.trim()).not.toBe("");
    expect(startupRecords(result.stderr)).toMatchObject([{ model: hostedConfig.model }]);
  },
  LIVE_TEST_TIMEOUT_MS,
);
