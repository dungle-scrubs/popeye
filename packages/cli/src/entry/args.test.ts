import { Effect, Exit } from "effect";
import { expect, test } from "vitest";

import type { ParsedRunArgs } from "./args.js";
import { parseArgs, withStdinPrompt } from "./args.js";

const parseRunArgs = async (argv: ReadonlyArray<string>): Promise<ParsedRunArgs> => {
  const parsed = await Effect.runPromise(parseArgs(argv));
  if (parsed.action !== "run") {
    throw new Error(`Expected run arguments, received ${parsed.action}.`);
  }
  return parsed;
};

test("-p selects a headless print invocation", async () => {
  const parsed = await parseRunArgs(["-p", "Explain the failure."]);

  expect(parsed).toMatchObject({
    action: "run",
    mode: "print",
    prompt: "Explain the failure.",
  });
});

test("--mode accepts print, json, rpc, and hcn while print remains the default", async () => {
  const defaultMode = await parseRunArgs(["-p", "Default mode."]);
  const print = await parseRunArgs(["-p", "--mode", "print", "Print mode."]);
  const json = await parseRunArgs(["-p", "--mode", "json", "JSON mode."]);
  const rpc = await parseRunArgs(["-p", "--mode", "rpc"]);
  const hcn = await parseRunArgs(["-p", "--mode", "hcn", "HCN mode."]);

  expect([defaultMode.mode, print.mode, json.mode, rpc.mode, hcn.mode]).toEqual([
    "print",
    "print",
    "json",
    "rpc",
    "hcn",
  ]);
});

test("a bare positional prompt is the print convenience form", async () => {
  const parsed = await parseRunArgs(["Explain the failure."]);

  expect(parsed).toMatchObject({
    action: "run",
    mode: "print",
    prompt: "Explain the failure.",
  });
});

test("piped stdin supplies the prompt when -p has no positional prompt", async () => {
  const parsed = await parseRunArgs(["-p"]);
  const withPrompt = await Effect.runPromise(withStdinPrompt(parsed, "Prompt from stdin.\n"));

  expect(withPrompt.prompt).toBe("Prompt from stdin.");
});

test("empty piped stdin is a typed no-prompt error", async () => {
  const parsed = await parseRunArgs(["-p"]);
  const error = await Effect.runPromise(Effect.flip(withStdinPrompt(parsed, " \n\t")));

  expect(error).toMatchObject({
    _tag: "CliArgsError",
    message: expect.stringContaining("Use popeye -p"),
    reason: "invalid_arguments",
  });
});

test("provider and Session flags are parsed", async () => {
  const parsed = await parseRunArgs([
    "-p",
    "--model",
    "qwen3.6-27b",
    "--base-url",
    "http://127.0.0.1:1234/v1",
    "--resume",
    "session-1",
    "--session-dir",
    "/tmp/popeye-sessions",
    "Continue.",
  ]);

  expect(parsed).toMatchObject({
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "qwen3.6-27b",
    resume: "session-1",
    sessionDir: "/tmp/popeye-sessions",
  });
});

test("--plugin is repeatable in both invocation shapes and defaults to an empty list", async () => {
  const headless = await parseRunArgs([
    "-p",
    "--plugin",
    "./plugins/first",
    "--plugin",
    "../shared/second",
    "Explain.",
  ]);
  const nonHeadless = await parseRunArgs(["--plugin", "./plugins/only", "Explain."]);
  const absent = await parseRunArgs(["Explain."]);

  expect(headless.pluginPaths).toEqual(["./plugins/first", "../shared/second"]);
  expect(nonHeadless.pluginPaths).toEqual(["./plugins/only"]);
  expect(absent.pluginPaths).toEqual([]);
});

test("a blank --plugin value is rejected as invalid arguments", async () => {
  const error = await Effect.runPromise(Effect.flip(parseArgs(["-p", "--plugin", "", "Explain."])));

  expect(error).toMatchObject({
    _tag: "CliArgsError",
    message: "--plugin requires a non-empty path.",
    reason: "invalid_arguments",
  });
});

test("--no-project-plugins defaults to false and becomes true when present", async () => {
  const enabled = await parseRunArgs(["--no-project-plugins", "Explain."]);
  const absent = await parseRunArgs(["Explain."]);

  expect(enabled.noProjectPlugins).toBe(true);
  expect(absent.noProjectPlugins).toBe(false);
});

test("--version selects the version action without provider configuration", async () => {
  const parsed = await Effect.runPromise(parseArgs(["--version"]));

  expect(parsed).toEqual({ action: "version" });
});

test("--help selects the help action without provider configuration", async () => {
  const parsed = await Effect.runPromise(parseArgs(["--help"]));

  expect(parsed).toEqual({ action: "help" });
});

test("--api-key is rejected without copying its value into the typed error", async () => {
  const error = await Effect.runPromise(
    Effect.flip(parseArgs(["--api-key", "secret-value", "-p", "Explain."])),
  );

  expect(error).toMatchObject({
    _tag: "CliArgsError",
    message: expect.stringContaining("POPEYE_API_KEY"),
    reason: "secret_flag",
  });
  expect(error.message).not.toContain("secret-value");
});

test("--trust is rejected as an unknown flag with a failing args exit", async () => {
  const parsed = parseArgs(["--trust", "-p", "Explain."]);
  const exit = await Effect.runPromiseExit(parsed);
  const error = await Effect.runPromise(Effect.flip(parsed));

  expect(Exit.isFailure(exit)).toBe(true);
  expect(error).toMatchObject({
    _tag: "CliArgsError",
    message: expect.stringContaining("Unknown option '--trust'"),
    reason: "invalid_arguments",
  });
});

test("rpc mode rejects a positional prompt with a clear typed error", async () => {
  const error = await Effect.runPromise(
    Effect.flip(parseArgs(["-p", "--mode", "rpc", "Unexpected prompt."])),
  );

  expect(error).toMatchObject({
    _tag: "CliArgsError",
    message: expect.stringContaining("RPC mode does not accept a prompt"),
    reason: "invalid_arguments",
  });
});
