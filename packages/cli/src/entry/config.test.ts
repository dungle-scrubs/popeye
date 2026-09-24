import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { classifyResolvedPluginSource } from "@dungle-scrubs/popeye-plugins";
import { Effect, Exit } from "effect";
import { expect, test } from "vitest";

import { parseArgs } from "./args.js";
import { resolveConfig } from "./config.js";

test("flags override POPEYE provider environment values", async () => {
  const parsed = await Effect.runPromise(
    parseArgs([
      "-p",
      "--model",
      "flag-model",
      "--base-url",
      "https://flag.example/v1",
      "--session-dir",
      "/tmp/flag-sessions",
      "Explain.",
    ]),
  );
  const config = await Effect.runPromise(
    resolveConfig(parsed, {
      POPEYE_API_KEY: "popeye-key",
      POPEYE_BASE_URL: "https://env.example/v1",
      POPEYE_MODEL: "env-model",
    }),
  );

  expect(config).toMatchObject({
    action: "run",
    apiKey: "popeye-key",
    baseUrl: "https://flag.example/v1",
    baseUrlHost: "flag.example",
    model: "flag-model",
    sessionDir: "/tmp/flag-sessions",
  });
});

test("Plugin arguments are exposed through resolved run configuration", async () => {
  const parsed = await Effect.runPromise(
    parseArgs([
      "-p",
      "--no-project-plugins",
      "--plugin",
      "./plugins/first",
      "--plugin",
      "../shared/second",
      "Explain.",
    ]),
  );
  const config = await Effect.runPromise(
    resolveConfig(parsed, {
      POPEYE_BASE_URL: "http://127.0.0.1:1234/v1",
      POPEYE_MODEL: "local-model",
    }),
  );

  expect(config).toMatchObject({
    action: "run",
    noProjectPlugins: true,
    pluginPaths: ["./plugins/first", "../shared/second"],
  });
});

test("the user Plugin directory defaults below the operating-system home directory", async () => {
  const parsed = await Effect.runPromise(parseArgs(["-p", "Explain."]));
  const config = await Effect.runPromise(
    resolveConfig(parsed, {
      POPEYE_BASE_URL: "http://127.0.0.1:1234/v1",
      POPEYE_MODEL: "local-model",
    }),
  );

  expect(config).toMatchObject({
    action: "run",
    userPluginDir: join(homedir(), ".popeye", "plugins"),
  });
});

test("an empty POPEYE_USER_PLUGIN_DIR falls back to the home-directory default", async () => {
  const parsed = await Effect.runPromise(parseArgs(["-p", "Explain."]));
  const config = await Effect.runPromise(
    resolveConfig(parsed, {
      POPEYE_BASE_URL: "http://127.0.0.1:1234/v1",
      POPEYE_MODEL: "local-model",
      POPEYE_USER_PLUGIN_DIR: "",
    }),
  );

  expect(config).toMatchObject({
    action: "run",
    userPluginDir: join(homedir(), ".popeye", "plugins"),
  });
});

test("POPEYE_USER_PLUGIN_DIR overrides the user Plugin directory for tests", async () => {
  const parsed = await Effect.runPromise(parseArgs(["-p", "Explain."]));
  const config = await Effect.runPromise(
    resolveConfig(parsed, {
      POPEYE_BASE_URL: "http://127.0.0.1:1234/v1",
      POPEYE_MODEL: "local-model",
      POPEYE_USER_PLUGIN_DIR: "/tmp/popeye-user-plugins",
    }),
  );

  expect(config).toMatchObject({
    action: "run",
    userPluginDir: "/tmp/popeye-user-plugins",
  });
});

test("a CLI Plugin path resolved inside the project tree stays project-local", async () => {
  const parsed = await Effect.runPromise(
    parseArgs(["-p", "--plugin", "./plugins/local", "Explain."]),
  );
  if (parsed.action !== "run") {
    throw new Error(`Expected run arguments, received ${parsed.action}.`);
  }
  const projectPath = resolve("/tmp/popeye-project");
  const pluginPath = parsed.pluginPaths[0];
  if (pluginPath === undefined) {
    throw new Error("Expected one CLI Plugin path.");
  }

  expect(classifyResolvedPluginSource(projectPath, resolve(projectPath, pluginPath))).toBe(
    "project-local",
  );
});

test("API keys fall back from POPEYE to OpenAI and then Anthropic", async () => {
  const parsed = await Effect.runPromise(parseArgs(["-p", "Explain."]));
  const popeye = await Effect.runPromise(
    resolveConfig(parsed, {
      ANTHROPIC_API_KEY: "anthropic-key",
      OPENAI_API_KEY: "openai-key",
      POPEYE_API_KEY: "popeye-key",
      POPEYE_BASE_URL: "https://gateway.example/v1",
      POPEYE_MODEL: "gateway-model",
    }),
  );
  const openAi = await Effect.runPromise(
    resolveConfig(parsed, {
      ANTHROPIC_API_KEY: "anthropic-key",
      OPENAI_API_KEY: "openai-key",
      POPEYE_BASE_URL: "https://gateway.example/v1",
      POPEYE_MODEL: "gateway-model",
    }),
  );
  const anthropic = await Effect.runPromise(
    resolveConfig(parsed, {
      ANTHROPIC_API_KEY: "anthropic-key",
      POPEYE_BASE_URL: "https://gateway.example/v1",
      POPEYE_MODEL: "gateway-model",
    }),
  );

  expect(popeye).toMatchObject({ action: "run", apiKey: "popeye-key" });
  expect(openAi).toMatchObject({ action: "run", apiKey: "openai-key" });
  expect(anthropic).toMatchObject({ action: "run", apiKey: "anthropic-key" });
});

test("missing model and endpoint failures name the exact flag and environment variable", async () => {
  const parsed = await Effect.runPromise(parseArgs(["-p", "Explain."]));
  const missingModel = await Effect.runPromise(
    Effect.flip(resolveConfig(parsed, { POPEYE_BASE_URL: "http://127.0.0.1:1234/v1" })),
  );
  const missingEndpoint = await Effect.runPromise(
    Effect.flip(resolveConfig(parsed, { POPEYE_MODEL: "local-model" })),
  );

  expect(missingModel).toMatchObject({
    _tag: "CliConfigError",
    message: expect.stringContaining("--model <model> or POPEYE_MODEL"),
    reason: "missing_model",
  });
  expect(missingEndpoint).toMatchObject({
    _tag: "CliConfigError",
    message: expect.stringContaining("--base-url <url> or POPEYE_BASE_URL"),
    reason: "missing_base_url",
  });
});

test("explicit empty provider flags do not fall through to environment values", async () => {
  const emptyModel = await Effect.runPromise(
    parseArgs(["-p", "--model", "", "--base-url", "http://127.0.0.1:1234/v1", "Explain."]),
  );
  const emptyBaseUrl = await Effect.runPromise(
    parseArgs(["-p", "--model", "flag-model", "--base-url", "", "Explain."]),
  );
  const env = {
    POPEYE_BASE_URL: "https://env.example/v1",
    POPEYE_MODEL: "env-model",
  };
  const modelError = await Effect.runPromise(Effect.flip(resolveConfig(emptyModel, env)));
  const baseUrlError = await Effect.runPromise(Effect.flip(resolveConfig(emptyBaseUrl, env)));

  expect(modelError).toMatchObject({
    _tag: "CliConfigError",
    message: expect.stringContaining("--model"),
    reason: "invalid_model",
  });
  expect(baseUrlError).toMatchObject({
    _tag: "CliConfigError",
    message: expect.stringContaining("--base-url"),
    reason: "invalid_base_url",
  });
});

test("loopback endpoints get a provider placeholder while hosted endpoints require a key", async () => {
  const parsed = await Effect.runPromise(parseArgs(["-p", "Explain."]));
  const local = await Effect.runPromise(
    resolveConfig(parsed, {
      POPEYE_BASE_URL: "http://127.0.0.1:1234/v1",
      POPEYE_MODEL: "local-model",
    }),
  );
  const hosted = await Effect.runPromise(
    Effect.flip(
      resolveConfig(parsed, {
        POPEYE_BASE_URL: "https://gateway.example/v1",
        POPEYE_MODEL: "hosted-model",
      }),
    ),
  );

  expect(local).toMatchObject({
    apiKey: expect.stringMatching(/.+/u),
    baseUrlHost: "127.0.0.1",
  });
  expect(hosted).toMatchObject({
    _tag: "CliConfigError",
    message: expect.stringMatching(/POPEYE_API_KEY.*OPENAI_API_KEY.*ANTHROPIC_API_KEY/u),
    reason: "missing_api_key",
  });
});

test("hostnames that only start with 127 are still hosted endpoints", async () => {
  const parsed = await Effect.runPromise(parseArgs(["-p", "Explain."]));
  const error = await Effect.runPromise(
    Effect.flip(
      resolveConfig(parsed, {
        POPEYE_BASE_URL: "https://127.example.com/v1",
        POPEYE_MODEL: "hosted-model",
      }),
    ),
  );

  expect(error).toMatchObject({
    _tag: "CliConfigError",
    reason: "missing_api_key",
  });
});

test("--resume-last is refused as unexpressible", async () => {
  const parsed = await Effect.runPromise(parseArgs(["-p", "--resume-last", "Explain."]));
  const exit = await Effect.runPromiseExit(
    resolveConfig(parsed, { POPEYE_BASE_URL: "http://127.0.0.1:1234/v1" }),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(String(exit.cause)).toContain("--resume-last is not supported");
  }
});

test("memory and questions flags are accepted as declared divergences", async () => {
  const parsed = await Effect.runPromise(
    parseArgs(["-p", "--memory", "--questions", "ask", "Explain."]),
  );
  const config = await Effect.runPromise(
    resolveConfig(parsed, {
      POPEYE_BASE_URL: "http://127.0.0.1:1234/v1",
      POPEYE_MODEL: "test-model",
    }),
  );
  expect(config).toMatchObject({ memory: true, questions: "ask" });
});
