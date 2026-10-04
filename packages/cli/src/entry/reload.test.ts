/**
 * Issue #93: `/reload` in the shipped CLI performs a real Generation swap.
 *
 * Every test runs the built bin (run `pnpm build` first). A Plugin file is added to the user
 * Plugin directory after startup discovery and before `/reload`, and the swap result names it.
 * The print and json Heads take one prompt per process, so their fixture Plugin ("stager")
 * writes the added Plugin file when startup imports it; startup enumerated the directory before
 * that import, so only the reload's discovery finds the added file. The rpc Head is long-lived,
 * so its tests write the added file between frames.
 *
 * The rpc tests also pin the wiring around the swap: the Driver's PluginHost resolves Commands in
 * the current Generation, the Driver's session-lifecycle Tap reaches the current Generation's
 * Plugins, Snapshots audit the current Generation, a second `/reload` while one is draining fails
 * busy, and a Tool call that is running when a reload starts holds a lease on its Generation, so
 * the reload waits for it and reports it in `leaseCount`.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { afterEach, expect, test } from "vitest";

import {
  BUILT_BIN_PATH,
  cleanCliEnvironment,
  fakeProviderEnvironment,
  runBuiltBin,
} from "../test-support/cli.js";

const EFFECT_URL = new URL("../../node_modules/effect/dist/esm/index.js", import.meta.url).href;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIRST_PARTY = ["compact", "goal", "reload", "session-name"];

const temporaryDirectories: Array<string> = [];
const children: Array<ChildProcessWithoutNullStreams> = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const tempDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "popeye-reload-bin-"));
  temporaryDirectories.push(directory);
  return directory;
};

interface Fixture {
  /** The CLI's working directory. It holds no Plugins, so the user Plugin directory stays external. */
  readonly cwd: string;
  readonly root: string;
  readonly sessionDir: string;
  readonly userPluginDir: string;
}

const fixture = (): Fixture => {
  const root = tempDirectory();
  const cwd = join(root, "project");
  const userPluginDir = join(root, "user-plugins");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(userPluginDir, { recursive: true });
  return { cwd, root, sessionDir: join(root, "sessions"), userPluginDir };
};

/** A Plugin with no Contributions. */
const emptyPluginSource = (name: string): string =>
  [
    "export default () => ({",
    "  contributions: [],",
    `  manifest: { capabilities: [], name: ${JSON.stringify(name)}, version: "1.0.0" },`,
    "});",
    "",
  ].join("\n");

/**
 * A Plugin that, when imported, writes `added.ts` (the "added-plugin") into its own directory if
 * the file is absent. Startup enumerates the directory before it imports this Plugin, so only a
 * later discovery (the reload's) sees the added file.
 */
const stagerPluginSource = (userPluginDir: string): string =>
  [
    'import { existsSync, writeFileSync } from "node:fs";',
    `const added = ${JSON.stringify(join(userPluginDir, "added.ts"))};`,
    "if (!existsSync(added)) {",
    `  writeFileSync(added, ${JSON.stringify(emptyPluginSource("added-plugin"))});`,
    "}",
    "export default () => ({",
    "  contributions: [],",
    '  manifest: { capabilities: [], name: "stager-plugin", version: "1.0.0" },',
    "});",
    "",
  ].join("\n");

/**
 * The "added-plugin" for the rpc tests: an `added-hello` Command, and a `session-lifecycle` Tap
 * that appends each input to `markerPath`.
 */
const addedPluginSource = (markerPath: string): string =>
  [
    'import { appendFileSync } from "node:fs";',
    `import { Effect, Schema } from ${JSON.stringify(EFFECT_URL)};`,
    "export default () => ({",
    "  contributions: [",
    "    {",
    '      kind: "command",',
    '      name: "added-hello",',
    "      payload: {",
    "        arguments: Schema.Struct({}),",
    '        description: "Say hello from the added Plugin.",',
    '        execute: () => Effect.succeed("hello"),',
    '        name: "added-hello",',
    "      },",
    "      priority: 0,",
    "    },",
    "    {",
    '      kind: "hook",',
    '      name: "lifecycle-probe",',
    "      payload: {",
    '        mergeClass: "Tap",',
    '        name: "lifecycle-probe",',
    '        point: "session-lifecycle",',
    "        run: (input) =>",
    `          Effect.sync(() => appendFileSync(${JSON.stringify(markerPath)}, JSON.stringify(input) + "\\n")),`,
    "      },",
    "      priority: 0,",
    "    },",
    "  ],",
    '  manifest: { capabilities: [], name: "added-plugin", version: "1.0.0" },',
    "});",
    "",
  ].join("\n");

/**
 * A Plugin whose import appends a line to `importsLog` (one line per Generation load), with a
 * `hold` Tool that creates `enteredPath`, then waits until `releasePath` exists and answers "held".
 */
const holdPluginSource = (paths: {
  readonly enteredPath: string;
  readonly importsLog: string;
  readonly releasePath: string;
}): string =>
  [
    'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
    `import { Effect, Schema } from ${JSON.stringify(EFFECT_URL)};`,
    `appendFileSync(${JSON.stringify(paths.importsLog)}, "import\\n");`,
    "export default () => ({",
    "  contributions: [",
    "    {",
    '      kind: "tool",',
    '      name: "hold",',
    "      payload: {",
    '        description: "Hold until released.",',
    "        execute: () =>",
    "          Effect.gen(function* () {",
    `            writeFileSync(${JSON.stringify(paths.enteredPath)}, "");`,
    `            while (!existsSync(${JSON.stringify(paths.releasePath)})) {`,
    '              yield* Effect.sleep("10 millis");',
    "            }",
    '            return { content: "held" };',
    "          }),",
    '        name: "hold",',
    "        parameters: Schema.Struct({}),",
    "      },",
    "      priority: 0,",
    "    },",
    "  ],",
    '  manifest: { capabilities: [], name: "hold-plugin", version: "1.0.0" },',
    "});",
    "",
  ].join("\n");

const waitFor = async (condition: () => boolean, what: string, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

type Frame = Record<string, unknown>;

interface RpcProcess {
  /** Ends stdin and resolves with the exit code. */
  readonly end: () => Promise<number | null>;
  /** Sends a frame and resolves with the response that carries its id. */
  readonly request: (frame: Frame & { readonly id: string }) => Promise<Frame>;
  readonly stderr: () => string;
}

/** Starts the built bin in rpc mode and correlates responses to requests by id. */
const startRpc = (options: {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly sessionDir: string;
}): RpcProcess => {
  const child = spawn(
    process.execPath,
    [BUILT_BIN_PATH, "-p", "--mode", "rpc", "--session-dir", options.sessionDir],
    { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(child);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const received = new Map<string, Frame>();
  const waiting = new Map<string, (frame: Frame) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const frame = JSON.parse(line) as Frame;
    if (typeof frame.id !== "string") {
      return;
    }
    const resolve = waiting.get(frame.id);
    if (resolve === undefined) {
      received.set(frame.id, frame);
    } else {
      waiting.delete(frame.id);
      resolve(frame);
    }
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });
  return {
    end: () => {
      child.stdin.end();
      return exited;
    },
    request: (frame) => {
      const response = new Promise<Frame>((resolve) => {
        const early = received.get(frame.id);
        if (early === undefined) {
          waiting.set(frame.id, resolve);
        } else {
          received.delete(frame.id);
          resolve(early);
        }
      });
      child.stdin.write(`${JSON.stringify(frame)}\n`);
      return response;
    },
    stderr: () => stderr,
  };
};

const createdSessionId = (response: Frame): string => {
  const result = response.result as { readonly sessionId?: unknown } | undefined;
  if (typeof result?.sessionId !== "string") {
    throw new Error(`rpc create returned no Session id: ${JSON.stringify(response)}`);
  }
  return result.sessionId;
};

const expectRealSwap = (value: unknown) => {
  expect(value).toMatchObject({
    leaseCount: expect.any(Number),
    newGenerationId: expect.stringMatching(UUID),
    oldGenerationId: expect.stringMatching(UUID),
    type: "generation_swap",
  });
  const swap = value as { readonly newGenerationId: string; readonly oldGenerationId: string };
  expect(swap.newGenerationId).not.toBe(swap.oldGenerationId);
};

test("the built print Head's /reload swaps to a new Generation that loads a Plugin file added after startup", () => {
  const { cwd, sessionDir, userPluginDir } = fixture();
  writeFileSync(join(userPluginDir, "stager.ts"), stagerPluginSource(userPluginDir));

  // The issue's reproduction command, with a test-owned user Plugin directory.
  const result = runBuiltBin(
    [
      "-p",
      "--no-project-plugins",
      "--session-dir",
      sessionDir,
      "--base-url",
      "http://127.0.0.1:9/v1",
      "--model",
      "none",
      "/reload",
    ],
    { cwd, env: { ...cleanCliEnvironment(), POPEYE_USER_PLUGIN_DIR: userPluginDir } },
  );

  expect(result.status, result.stderr).toBe(0);
  const swap = JSON.parse(result.stdout.trimEnd()) as unknown;
  expectRealSwap(swap);
  expect(swap).toMatchObject({
    leaseCount: 0,
    pluginsAdded: ["added-plugin"],
    pluginsRemoved: [],
    pluginsReplaced: [...FIRST_PARTY, "stager-plugin"],
  });
});

test("the built JSON Head's /reload Snapshot audits the new Generation, including a Plugin file added after startup", () => {
  const { cwd, sessionDir, userPluginDir } = fixture();
  writeFileSync(join(userPluginDir, "stager.ts"), stagerPluginSource(userPluginDir));

  const result = runBuiltBin(
    ["-p", "--mode", "json", "--no-project-plugins", "--session-dir", sessionDir, "/reload"],
    { cwd, env: { ...fakeProviderEnvironment(), POPEYE_USER_PLUGIN_DIR: userPluginDir } },
  );

  expect(result.status, result.stderr).toBe(0);
  const lines = result.stdout
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Frame);
  // The Head writes the Session id line, then the command's settled Snapshot.
  expect(lines[0]).toMatchObject({ _tag: "sessionId" });
  expect(lines.at(-1)).toMatchObject({
    loadedGeneration: {
      id: expect.stringMatching(UUID),
      plugins: [...FIRST_PARTY, "added-plugin", "stager-plugin"],
    },
  });
});

test("the built rpc Head's /reload through invoke-command loads a Plugin file added after startup, and the Driver follows the new Generation", async () => {
  const { cwd, root, sessionDir, userPluginDir } = fixture();
  const markerPath = join(root, "lifecycle.jsonl");
  const rpc = startRpc({
    cwd,
    env: { ...fakeProviderEnvironment(), POPEYE_USER_PLUGIN_DIR: userPluginDir },
    sessionDir,
  });

  const first = createdSessionId(await rpc.request({ _tag: "create", id: "create-first" }));
  // Between startup and /reload: a new Plugin file appears in the user Plugin directory.
  writeFileSync(join(userPluginDir, "added.ts"), addedPluginSource(markerPath));

  const reload = await rpc.request({
    _tag: "invoke-command",
    args: {},
    id: "reload",
    name: "reload",
    sessionId: first,
  });
  expect(reload, rpc.stderr()).toMatchObject({
    result: { _tag: "commandInvoked", commandName: "reload" },
  });
  const swap = (reload.result as { readonly value: Frame }).value;
  expectRealSwap(swap);
  expect(swap).toMatchObject({
    leaseCount: 0,
    pluginsAdded: ["added-plugin"],
    pluginsRemoved: [],
    pluginsReplaced: FIRST_PARTY,
  });

  // The Driver's PluginHost resolves Commands in the current Generation.
  const hello = await rpc.request({
    _tag: "invoke-command",
    args: {},
    id: "hello",
    name: "added-hello",
    sessionId: first,
  });
  expect(hello).toEqual({
    id: "hello",
    result: { _tag: "commandInvoked", commandName: "added-hello", value: "hello" },
  });

  // Snapshots audit the current Generation.
  const snapshot = await rpc.request({ _tag: "get-snapshot", id: "snapshot", sessionId: first });
  expect(snapshot).toMatchObject({
    result: {
      _tag: "snapshot",
      loadedGeneration: {
        id: swap.newGenerationId,
        plugins: [...FIRST_PARTY, "added-plugin"],
      },
    },
  });

  // The Driver's session-lifecycle Tap reaches the current Generation's Plugins.
  const second = createdSessionId(await rpc.request({ _tag: "create", id: "create-second" }));
  await waitFor(
    () =>
      existsSync(markerPath) &&
      readFileSync(markerPath, "utf8").includes(
        JSON.stringify({ event: "created", sessionId: second }),
      ),
    "the added Plugin's session-lifecycle Tap to see the second Session's create",
  );

  expect(await rpc.end(), rpc.stderr()).toBe(0);
}, 30_000);

test("the built rpc Head's /reload waits for a running Tool call's Generation lease, and a second /reload meanwhile fails busy", async () => {
  const { cwd, root, sessionDir, userPluginDir } = fixture();
  const paths = {
    enteredPath: join(root, "hold-entered"),
    importsLog: join(root, "imports.log"),
    releasePath: join(root, "hold-release"),
  };
  writeFileSync(join(userPluginDir, "hold.ts"), holdPluginSource(paths));
  const providerScriptPath = join(root, "provider.json");
  writeFileSync(
    providerScriptPath,
    JSON.stringify({
      responses: [
        {
          items: [
            { _tag: "toolCall", argumentsJson: "{}", id: "hold-call", name: "hold" },
            { _tag: "done", stopReason: "toolCalls" },
          ],
        },
        {
          items: [
            { _tag: "textDelta", text: "Released." },
            { _tag: "done", stopReason: "done" },
          ],
        },
      ],
    }),
  );
  const importCount = () =>
    existsSync(paths.importsLog)
      ? readFileSync(paths.importsLog, "utf8").trimEnd().split("\n").length
      : 0;
  const rpc = startRpc({
    cwd,
    env: {
      ...fakeProviderEnvironment(),
      POPEYE_FAKE_PROVIDER_SCRIPT: providerScriptPath,
      POPEYE_USER_PLUGIN_DIR: userPluginDir,
    },
    sessionDir,
  });

  const holder = createdSessionId(await rpc.request({ _tag: "create", id: "create-holder" }));
  const reloader = createdSessionId(await rpc.request({ _tag: "create", id: "create-reloader" }));
  const other = createdSessionId(await rpc.request({ _tag: "create", id: "create-other" }));
  expect(importCount(), rpc.stderr()).toBe(1);
  let snapshots = 0;
  const generationId = async () => {
    snapshots += 1;
    const snapshot = await rpc.request({
      _tag: "get-snapshot",
      id: `snapshot-${snapshots}`,
      sessionId: other,
    });
    return ((snapshot.result as Frame).loadedGeneration as Frame).id;
  };
  const startupGenerationId = await generationId();

  // The holder Session's Turn calls hold, which runs until the test releases it.
  const turn = rpc.request({ _tag: "prompt", content: "Hold.", id: "turn", sessionId: holder });
  await waitFor(() => existsSync(paths.enteredPath), "the hold Tool to start");

  // A reload starts while hold runs. Its load imports the hold Plugin again.
  const reload = rpc.request({
    _tag: "invoke-command",
    args: {},
    id: "reload",
    name: "reload",
    sessionId: reloader,
  });
  await Promise.race([
    waitFor(() => importCount() === 2, "the reload to load the fresh Generation"),
    reload.then((response) => {
      throw new Error(`The reload returned while hold was running: ${JSON.stringify(response)}`);
    }),
  ]);

  // A second reload while the first waits at the drain barrier fails busy.
  const busy = await rpc.request({
    _tag: "invoke-command",
    args: {},
    id: "reload-busy",
    name: "reload",
    sessionId: other,
  });
  expect(busy).toMatchObject({
    error: {
      code: "invoke_command_error",
      details: { commandName: "reload", reason: "command_failed" },
      message: "Reload is already in progress.",
    },
    id: "reload-busy",
  });

  // Importing the fresh Plugin precedes the swap; release hold only once Snapshots audit the
  // fresh Generation, so the reload is waiting at the drain barrier with hold's lease.
  const deadline = Date.now() + 10_000;
  while ((await generationId()) === startupGenerationId) {
    if (Date.now() > deadline) {
      throw new Error("Timed out after 10000 ms waiting for the reload to swap.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  writeFileSync(paths.releasePath, "");
  const swap = await reload;
  expect(swap, rpc.stderr()).toMatchObject({
    result: { _tag: "commandInvoked", commandName: "reload" },
  });
  const value = (swap.result as { readonly value: Frame }).value;
  expectRealSwap(value);
  // The running hold call held the old Generation, so the reload waited for it.
  expect(value).toMatchObject({
    leaseCount: 1,
    pluginsReplaced: ["compact", "goal", "hold-plugin", "reload", "session-name"],
  });

  // The hold call finished on the Generation it started on.
  const settled = await turn;
  const entries = (settled.result as { readonly entries?: ReadonlyArray<Frame> }).entries ?? [];
  expect(entries.map((entry) => entry.payload)).toContainEqual(
    expect.objectContaining({ content: "held", role: "toolResult", toolName: "hold" }),
  );
  expect(
    entries.some(
      (entry) =>
        (entry.payload as Frame | undefined)?.role === "toolResult" &&
        (entry.payload as Frame).isError === true,
    ),
  ).toBe(false);

  expect(await rpc.end(), rpc.stderr()).toBe(0);
}, 30_000);

test("the built rpc Head's /reload fails with the drain-timeout message when a running Tool call outlasts the 5-second drain, and the swap stands", async () => {
  const { cwd, root, sessionDir, userPluginDir } = fixture();
  const paths = {
    enteredPath: join(root, "hold-entered"),
    importsLog: join(root, "imports.log"),
    releasePath: join(root, "hold-release"),
  };
  writeFileSync(join(userPluginDir, "hold.ts"), holdPluginSource(paths));
  const providerScriptPath = join(root, "provider.json");
  writeFileSync(
    providerScriptPath,
    JSON.stringify({
      responses: [
        {
          items: [
            { _tag: "toolCall", argumentsJson: "{}", id: "hold-call", name: "hold" },
            { _tag: "done", stopReason: "toolCalls" },
          ],
        },
        {
          items: [
            { _tag: "textDelta", text: "Released." },
            { _tag: "done", stopReason: "done" },
          ],
        },
      ],
    }),
  );
  const rpc = startRpc({
    cwd,
    env: {
      ...fakeProviderEnvironment(),
      POPEYE_FAKE_PROVIDER_SCRIPT: providerScriptPath,
      POPEYE_USER_PLUGIN_DIR: userPluginDir,
    },
    sessionDir,
  });

  const holder = createdSessionId(await rpc.request({ _tag: "create", id: "create-holder" }));
  const reloader = createdSessionId(await rpc.request({ _tag: "create", id: "create-reloader" }));
  const turn = rpc.request({ _tag: "prompt", content: "Hold.", id: "turn", sessionId: holder });
  await waitFor(() => existsSync(paths.enteredPath), "the hold Tool to start");

  const startedAt = Date.now();
  const reload = await rpc.request({
    _tag: "invoke-command",
    args: {},
    id: "reload",
    name: "reload",
    sessionId: reloader,
  });
  const elapsedMillis = Date.now() - startedAt;

  expect(reload, rpc.stderr()).toMatchObject({
    error: {
      code: "invoke_command_error",
      details: { commandName: "reload", reason: "command_failed" },
    },
    id: "reload",
  });
  const message = (reload.error as { readonly message: string }).message;
  const match =
    /^Reload swapped to generation (\S+), but generation (\S+) still has 1 running lease\(s\) after 5000 ms \(tool:hold\); it closes when they settle\.$/.exec(
      message,
    );
  expect(match, message).not.toBeNull();
  const [, newGenerationId, oldGenerationId] = match ?? [];
  expect(newGenerationId).toMatch(UUID);
  expect(oldGenerationId).toMatch(UUID);
  expect(newGenerationId).not.toBe(oldGenerationId);
  expect(elapsedMillis).toBeGreaterThanOrEqual(4_500);
  expect(elapsedMillis).toBeLessThan(15_000);

  // The swap stands: Snapshots audit the new Generation while the old one still drains.
  const snapshot = await rpc.request({ _tag: "get-snapshot", id: "snapshot", sessionId: reloader });
  expect(snapshot).toMatchObject({
    result: { _tag: "snapshot", loadedGeneration: { id: newGenerationId } },
  });

  // The hold call finishes on the Generation it started on.
  writeFileSync(paths.releasePath, "");
  const settled = await turn;
  const entries = (settled.result as { readonly entries?: ReadonlyArray<Frame> }).entries ?? [];
  expect(entries.map((entry) => entry.payload)).toContainEqual(
    expect.objectContaining({ content: "held", role: "toolResult", toolName: "hold" }),
  );

  expect(await rpc.end(), rpc.stderr()).toBe(0);
}, 40_000);
