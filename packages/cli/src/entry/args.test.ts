import { Effect } from "effect";
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

test("--mode accepts print, json, and rpc while print remains the default", async () => {
  const defaultMode = await parseRunArgs(["-p", "Default mode."]);
  const print = await parseRunArgs(["-p", "--mode", "print", "Print mode."]);
  const json = await parseRunArgs(["-p", "--mode", "json", "JSON mode."]);
  const rpc = await parseRunArgs(["-p", "--mode", "rpc"]);

  expect([defaultMode.mode, print.mode, json.mode, rpc.mode]).toEqual([
    "print",
    "print",
    "json",
    "rpc",
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

  expect(withPrompt.prompt).toBe("Prompt from stdin.\n");
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
    "/tmp/peye-sessions",
    "Continue.",
  ]);

  expect(parsed).toMatchObject({
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "qwen3.6-27b",
    resume: "session-1",
    sessionDir: "/tmp/peye-sessions",
  });
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
    message: expect.stringContaining("PEYE_API_KEY"),
    reason: "secret_flag",
  });
  expect(error.message).not.toContain("secret-value");
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
