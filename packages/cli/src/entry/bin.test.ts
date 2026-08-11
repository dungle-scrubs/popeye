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
  const directory = mkdtempSync(join(tmpdir(), "peye-cli-bin-"));
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
  expect(version.stdout).toBe("0.1.0\n");
  expect(version.stderr).toBe("");
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('peye -p --mode json "<prompt>"');
  expect(help.stdout).toContain("peye -p --mode rpc");
  expect(help.stdout).toContain("2  Invalid arguments, missing configuration, or an aborted turn.");
  expect(help.stdout).toContain("Read stderr to distinguish exit 2 causes.");
  expect(help.stderr).toBe("");
});

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
      },
    ]);
  }
}, 15_000);

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
  expect(resumed.status).toBe(0);
  expect(resumed.stdout).toBe("Fake provider answer.\n");
  expect(startupRecords(resumed.stderr)).toMatchObject([
    { mode: "print", sessionAction: `resume:${sessionId}` },
  ]);
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

test("the built bin reports bad arguments and missing config on stderr", () => {
  const badArguments = runBuiltBin(["--api-key", "secret-value", "-p", FAKE_PROVIDER_PROMPT]);
  const missingConfig = runBuiltBin(["-p", FAKE_PROVIDER_PROMPT]);

  expect(badArguments.status).toBe(2);
  expect(badArguments.stdout).toBe("");
  expect(badArguments.stderr).toContain("ERROR CliArgsError");
  expect(badArguments.stderr).toContain("PEYE_API_KEY");
  expect(badArguments.stderr).not.toContain("secret-value");
  expect(missingConfig.status).toBe(2);
  expect(missingConfig.stdout).toBe("");
  expect(missingConfig.stderr).toContain("--model <model> or PEYE_MODEL");
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
    [whitespacePrompt, "Use peye -p"],
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
      env: { ...fakeProviderEnvironment(), PEYE_USER_PLUGIN_DIR: userPluginDir },
    },
  );

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("ERROR CliRunError");
  expect(result.stderr).toContain("composition_failed");
  expect(result.stderr).toContain(pluginPath);
  expect(result.stderr).toContain("fixture import explosion");
});
