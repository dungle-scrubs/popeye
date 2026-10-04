import { Effect, Exit } from "effect";
import { expect, test } from "vitest";

import type { ParsedRunArgs } from "./args.js";
import {
  coerceResumeValue,
  HCN_EFFORT_TO_THINKING_LEVEL,
  parseArgs,
  withStdinPrompt,
} from "./args.js";

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

test("empty stdin is allowed only when an explicit Session resumes", async () => {
  const parsed = await parseRunArgs(["-p", "--resume", "session-1"]);
  const completed = await Effect.runPromise(withStdinPrompt(parsed, " \n\t"));

  expect(completed).toMatchObject({ prompt: undefined, resume: "session-1" });
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

test("HCN grant flags parse into lists with effort validated", async () => {
  const parsed = await parseRunArgs([
    "-p",
    "--tools",
    "read,native:bash",
    "--exclude-tools",
    "write-file",
    "--access",
    "read",
    "--effort",
    "medium-high",
    "--context-window",
    "128000",
    "--skills",
    "compact,reload",
    "--isolation",
    "tool-free",
    "--questions",
    "ask",
    "--memory",
    "--system-prompt",
    "Custom instructions.",
    "--append-system-prompt",
    "Extra context.",
    "Run it.",
  ]);

  expect(parsed).toMatchObject({
    access: "read",
    appendSystemPrompt: "Extra context.",
    contextWindow: 128000,
    effort: "medium-high",
    excludeTools: ["write-file"],
    isolation: "tool-free",
    memory: true,
    questions: "ask",
    skills: ["compact", "reload"],
    systemPrompt: "Custom instructions.",
    tools: ["read", "native:bash"],
  });
});

test.each(["print", "json", "hcn"])("--effort off parses in %s mode", async (mode) => {
  const parsed = await parseRunArgs(["-p", "--mode", mode, "--effort", "off", "Run it."]);
  expect(parsed.effort).toBe("off");
});

test("effort off extends rather than renames the RFC-02 ladder", () => {
  expect(HCN_EFFORT_TO_THINKING_LEVEL).toEqual({
    off: "off",
    low: "minimal",
    "medium-low": "low",
    medium: "medium",
    "medium-high": "high",
    high: "xhigh",
    xhigh: "max",
  });
});

test("invalid effort lists the exact supported CLI words including off", async () => {
  const error = await Effect.runPromise(
    Effect.flip(parseArgs(["-p", "--effort", "none", "Run it."])),
  );
  expect(error).toMatchObject({
    _tag: "CliArgsError",
    message:
      'Invalid --effort value "none". Use off, low, medium-low, medium, medium-high, high, xhigh.',
    reason: "invalid_arguments",
  });
});

test("grant lists default to empty and effort rejects unknown words", async () => {
  const parsed = await parseRunArgs(["-p", "Run it."]);
  expect(parsed.tools).toEqual([]);
  expect(parsed.excludeTools).toEqual([]);
  expect(parsed.skills).toEqual([]);
  expect(parsed.effort).toBeUndefined();

  const failure = await Effect.runPromiseExit(parseArgs(["-p", "--effort", "ultra", "Run it."]));
  expect(Exit.isFailure(failure)).toBe(true);
});

test("empty grant lists and non-positive windows refuse instead of widening", async () => {
  for (const argv of [
    ["-p", "--tools", "", "Run it."],
    ["-p", "--tools", " , ", "Run it."],
    ["-p", "--exclude-tools", "", "Run it."],
    ["-p", "--skills", "  ", "Run it."],
    ["-p", "--access", "all", "Run it."],
    ["-p", "--isolation", "read-only", "Run it."],
    ["-p", "--context-window", "0", "Run it."],
    ["-p", "--context-window", "-100", "Run it."],
  ]) {
    const failure = await Effect.runPromiseExit(parseArgs(argv));
    expect(Exit.isFailure(failure)).toBe(true);
  }
});

test("--agent parses an agent definition name", async () => {
  const parsed = await parseRunArgs(["-p", "--agent", "scout", "Explain."]);
  expect(parsed.agent).toBe("scout");
  const absent = await parseRunArgs(["-p", "Explain."]);
  expect(absent.agent).toBeUndefined();
});

test("coerceResumeValue folds a bare --resume and its next token into --resume=<value>", () => {
  expect(coerceResumeValue(["--resume", "-AbCdEfGhIjKl"])).toEqual(["--resume=-AbCdEfGhIjKl"]);
  expect(coerceResumeValue(["--resume", "--AbCdEfGhIjKl"])).toEqual(["--resume=--AbCdEfGhIjKl"]);
  expect(coerceResumeValue(["--resume", "session-1"])).toEqual(["--resume=session-1"]);
  expect(
    coerceResumeValue([
      "-p",
      "--mode",
      "json",
      "--resume",
      "-AbCdEfGhIjKl",
      "--session-dir",
      "/tmp/x",
    ]),
  ).toEqual(["-p", "--mode", "json", "--resume=-AbCdEfGhIjKl", "--session-dir", "/tmp/x"]);
  // A trailing --resume with no value is left untouched so parseArgs can
  // report the missing value as it always has.
  expect(coerceResumeValue(["-p", "--resume"])).toEqual(["-p", "--resume"]);
  // Tokens after a bare -- are positionals, never an option.
  expect(coerceResumeValue(["-p", "--", "--resume", "notes"])).toEqual([
    "-p",
    "--",
    "--resume",
    "notes",
  ]);
  // --resume already carries an =value form: passthrough.
  expect(coerceResumeValue(["--resume=-AbCdEfGhIjKl"])).toEqual(["--resume=-AbCdEfGhIjKl"]);
});

test("parseArgs accepts a Session ID that starts with a dash after the bare --resume flag", async () => {
  const id = "-AbCdEfGhIjKlMnOpQrSt";
  const parsed = await parseRunArgs(["-p", "--resume", id, "Continue."]);

  expect(parsed.resume).toBe(id);
});

test("parseArgs accepts a Session ID that starts with -- after the bare --resume flag", async () => {
  const parsed = await parseRunArgs(["-p", "--resume", "--AbCdEfGhIjKl", "Continue."]);

  expect(parsed.resume).toBe("--AbCdEfGhIjKl");
});

test("parseArgs still parses --resume with an equals-form Session ID", async () => {
  const id = "-AbCdEfGhIjKlMnOpQrSt";
  const parsed = await parseRunArgs(["-p", `--resume=${id}`, "Continue."]);

  expect(parsed.resume).toBe(id);
});

test("parseArgs still parses --resume followed by a plain value", async () => {
  const parsed = await parseRunArgs(["-p", "--resume", "abc", "Continue."]);

  expect(parsed.resume).toBe("abc");
});

test("parseArgs reports a missing --resume value when --resume is the last token", async () => {
  const error = await Effect.runPromise(
    Effect.flip(parseArgs(["-p", "--session-dir", "/tmp/popeye-x", "--resume"])),
  );

  expect(error).toMatchObject({
    _tag: "CliArgsError",
    message: expect.stringContaining("argument missing"),
    reason: "invalid_arguments",
  });
});
