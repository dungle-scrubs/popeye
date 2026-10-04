import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { classifyResolvedPluginSource } from "@dungle-scrubs/popeye-plugins";
import { Effect, Exit } from "effect";
import { expect, test } from "vitest";

import { parseArgs } from "./args.js";
import { resolveConfig } from "./config.js";

test.each(["print", "json", "hcn"])(
  "resolved %s configuration retains explicit effort off and the Goal Tool exclusion",
  async (mode) => {
    const parsed = await Effect.runPromise(
      parseArgs([
        "-p",
        "--mode",
        mode,
        "--effort",
        "off",
        "--exclude-tools",
        "manage-goal",
        "Run it.",
      ]),
    );
    const config = await Effect.runPromise(
      resolveConfig(parsed, {
        POPEYE_BASE_URL: "http://127.0.0.1:1/v1",
        POPEYE_MODEL: "offline-reasoning-model",
      }),
    );
    expect(config).toMatchObject({
      action: "run",
      apiKey: "local",
      effort: "off",
      excludeTools: ["manage-goal"],
      mode,
    });
  },
);

test("configuration does not invent an effort when it is unset", async () => {
  const parsed = await Effect.runPromise(parseArgs(["-p", "Run it."]));
  const config = await Effect.runPromise(
    resolveConfig(parsed, {
      POPEYE_BASE_URL: "http://127.0.0.1:1/v1",
      POPEYE_MODEL: "offline-reasoning-model",
    }),
  );
  expect(config).toMatchObject({ effort: undefined });
});

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

const CUSTOM_HOST_MESSAGE_SUFFIX =
  "requires POPEYE_API_KEY. OPENAI_API_KEY and ANTHROPIC_API_KEY are sent only to their own API hosts.";

const ALL_PROVIDER_KEYS = {
  ANTHROPIC_API_KEY: "anthropic-key",
  OPENAI_API_KEY: "openai-key",
} as const;

const resolveEndpoint = async (baseUrl: string, env: Record<string, string>) => {
  const parsed = await Effect.runPromise(parseArgs(["-p", "Explain."]));
  return Effect.runPromiseExit(
    resolveConfig(parsed, { POPEYE_BASE_URL: baseUrl, POPEYE_MODEL: "endpoint-model", ...env }),
  );
};

const resolvedApiKey = async (
  baseUrl: string,
  env: Record<string, string>,
): Promise<string | undefined> => {
  const exit = await resolveEndpoint(baseUrl, env);
  if (Exit.isFailure(exit)) {
    throw new Error(`Expected ${baseUrl} to resolve, received ${exit.cause.toString()}.`);
  }
  return exit.value.action === "run" ? exit.value.apiKey : undefined;
};

const configFailure = async (baseUrl: string, env: Record<string, string>) => {
  const parsed = await Effect.runPromise(parseArgs(["-p", "Explain."]));
  return Effect.runPromise(
    Effect.flip(
      resolveConfig(parsed, { POPEYE_BASE_URL: baseUrl, POPEYE_MODEL: "endpoint-model", ...env }),
    ),
  );
};

test("with every provider key present, each recognized API host selects its own key", async () => {
  expect(await resolvedApiKey("https://api.openai.com/v1", ALL_PROVIDER_KEYS)).toBe("openai-key");
  expect(await resolvedApiKey("https://api.anthropic.com/v1", ALL_PROVIDER_KEYS)).toBe(
    "anthropic-key",
  );
  expect(await resolvedApiKey("https://API.OPENAI.COM/v1", ALL_PROVIDER_KEYS)).toBe("openai-key");
});

test("a recognized API host never falls back to another provider's key", async () => {
  const anthropicHost = await configFailure("https://api.anthropic.com/v1", {
    OPENAI_API_KEY: "openai-key",
  });
  const openAiHost = await configFailure("https://api.openai.com/v1", {
    ANTHROPIC_API_KEY: "anthropic-key",
  });

  expect(anthropicHost).toMatchObject({
    _tag: "CliConfigError",
    message: "Endpoint https://api.anthropic.com requires POPEYE_API_KEY or ANTHROPIC_API_KEY.",
    reason: "missing_api_key",
  });
  expect(openAiHost).toMatchObject({
    _tag: "CliConfigError",
    message: "Endpoint https://api.openai.com requires POPEYE_API_KEY or OPENAI_API_KEY.",
    reason: "missing_api_key",
  });
});

test("a custom hosted endpoint requires POPEYE_API_KEY even when provider keys are present", async () => {
  const error = await configFailure("https://gateway.example/v1", ALL_PROVIDER_KEYS);

  expect(error).toMatchObject({
    _tag: "CliConfigError",
    message: `Endpoint https://gateway.example ${CUSTOM_HOST_MESSAGE_SUFFIX}`,
    reason: "missing_api_key",
  });
  expect(error.message).not.toMatch(/openai-key|anthropic-key/u);
});

test("recognized API hosts match by exact origin", async () => {
  for (const [baseUrl, origin] of [
    ["http://api.openai.com/v1", "http://api.openai.com"],
    ["https://api.openai.com:8443/v1", "https://api.openai.com:8443"],
    ["https://api.openai.com.gateway.example/v1", "https://api.openai.com.gateway.example"],
    ["https://eu.api.openai.com/v1", "https://eu.api.openai.com"],
    ["https://user:secret@gateway.example/v1", "https://gateway.example"],
  ] as const) {
    const error = await configFailure(baseUrl, ALL_PROVIDER_KEYS);
    expect(error).toMatchObject({
      _tag: "CliConfigError",
      message: `Endpoint ${origin} ${CUSTOM_HOST_MESSAGE_SUFFIX}`,
      reason: "missing_api_key",
    });
  }
});

test("loopback endpoints receive the local placeholder, never a provider key", async () => {
  for (const baseUrl of [
    "http://127.0.0.1:1234/v1",
    "http://localhost:1234/v1",
    "http://[::1]:1234/v1",
  ]) {
    expect(await resolvedApiKey(baseUrl, ALL_PROVIDER_KEYS)).toBe("local");
  }
});

test("POPEYE_API_KEY overrides provider keys and the placeholder on every endpoint", async () => {
  const env = { ...ALL_PROVIDER_KEYS, POPEYE_API_KEY: "popeye-key" };

  for (const baseUrl of [
    "https://api.openai.com/v1",
    "https://api.anthropic.com/v1",
    "https://gateway.example/v1",
    "http://127.0.0.1:1234/v1",
  ]) {
    expect(await resolvedApiKey(baseUrl, env)).toBe("popeye-key");
  }
  expect(await resolvedApiKey("https://gateway.example/v1", { POPEYE_API_KEY: "popeye-key" })).toBe(
    "popeye-key",
  );
});

test("an empty POPEYE_API_KEY does not override host selection", async () => {
  expect(
    await resolvedApiKey("https://api.anthropic.com/v1", {
      ...ALL_PROVIDER_KEYS,
      POPEYE_API_KEY: "",
    }),
  ).toBe("anthropic-key");
  expect(
    await resolvedApiKey("http://127.0.0.1:1234/v1", { ...ALL_PROVIDER_KEYS, POPEYE_API_KEY: "" }),
  ).toBe("local");
});

test("blank credentials count as unset, so pi-ai never substitutes an ambient provider key", async () => {
  expect(
    await resolvedApiKey("https://api.anthropic.com/v1", {
      ...ALL_PROVIDER_KEYS,
      POPEYE_API_KEY: " \t ",
    }),
  ).toBe("anthropic-key");
  expect(
    await resolvedApiKey("http://127.0.0.1:1234/v1", { ...ALL_PROVIDER_KEYS, POPEYE_API_KEY: " " }),
  ).toBe("local");
  expect(
    await configFailure("https://gateway.example.test/v1", {
      ...ALL_PROVIDER_KEYS,
      POPEYE_API_KEY: " ",
    }),
  ).toMatchObject({
    message: `Endpoint https://gateway.example.test ${CUSTOM_HOST_MESSAGE_SUFFIX}`,
    reason: "missing_api_key",
  });
  expect(
    await configFailure("https://api.anthropic.com/v1", {
      ANTHROPIC_API_KEY: "  ",
      OPENAI_API_KEY: "openai-key",
    }),
  ).toMatchObject({
    message: "Endpoint https://api.anthropic.com requires POPEYE_API_KEY or ANTHROPIC_API_KEY.",
    reason: "missing_api_key",
  });
  expect(
    await resolvedApiKey("https://gateway.example.test/v1", { POPEYE_API_KEY: " popeye-key " }),
  ).toBe(" popeye-key ");
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
    accountingProviderClass: "local",
    apiKey: "local",
    baseUrlHost: "127.0.0.1",
  });
  expect(hosted).toMatchObject({
    _tag: "CliConfigError",
    message: `Endpoint https://gateway.example ${CUSTOM_HOST_MESSAGE_SUFFIX}`,
    reason: "missing_api_key",
  });
});

test.each([
  ["http://127.0.0.1:1234/v1", "local"],
  ["http://localhost:1234/v1", "local"],
  ["http://[::1]:1234/v1", "local"],
  ["https://gateway.example/v1", "unknown"],
  ["https://127.example.com/v1", "unknown"],
])("accounting class follows the resolved endpoint %s", async (baseUrl, providerClass) => {
  const parsed = await Effect.runPromise(parseArgs(["-p", "Explain."]));
  const config = await Effect.runPromise(
    resolveConfig(parsed, {
      POPEYE_API_KEY: "test-key",
      POPEYE_BASE_URL: baseUrl,
      POPEYE_MODEL: "fixture-model",
    }),
  );

  expect(config).toMatchObject({ action: "run", accountingProviderClass: providerClass });
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

// ---------------------------------------------------------------------------
// Agent selection (RFC-04 slice 1)
// ---------------------------------------------------------------------------

import type { AgentDiscoveryResult } from "../agents/loader.js";

const discoveryWith = (
  entries: ReadonlyArray<{
    readonly body?: string;
    readonly model?: string;
    readonly name: string;
    readonly scope?: "project" | "user";
    readonly tools?: ReadonlyArray<string>;
  }>,
): AgentDiscoveryResult => ({
  agents: new Map(
    entries.map((entry) => [
      entry.name,
      {
        body: entry.body ?? "Persona body.",
        description: "test agent",
        filePath: `/agents/${entry.name}.md`,
        model: entry.model,
        name: entry.name,
        scope: entry.scope ?? "user",
        tools: entry.tools,
      },
    ]),
  ),
  diagnostics: [],
});

const parseWithAgent = async (argv: ReadonlyArray<string>) =>
  Effect.runPromise(parseArgs(argv)).then((parsed) => {
    if (parsed.action !== "run") {
      throw new Error(`Expected run arguments, received ${parsed.action}.`);
    }
    return parsed;
  });

test("model precedence: --model beats agent file model beats POPEYE_MODEL", async () => {
  const parsed = await parseWithAgent([
    "-p",
    "--agent",
    "scout",
    "--model",
    "flag-model",
    "Explain.",
  ]);
  const discovery = discoveryWith([{ model: "agent-model", name: "scout" }]);
  const config = await Effect.runPromise(
    resolveConfig(
      parsed,
      { POPEYE_BASE_URL: "http://127.0.0.1:1234/v1", POPEYE_MODEL: "env-model" },
      discovery,
    ),
  );
  expect(config).toMatchObject({ model: "flag-model" });

  const noFlag = await parseWithAgent(["-p", "--agent", "scout", "Explain."]);
  const fromAgent = await Effect.runPromise(
    resolveConfig(
      noFlag,
      { POPEYE_BASE_URL: "http://127.0.0.1:1234/v1", POPEYE_MODEL: "env-model" },
      discovery,
    ),
  );
  expect(fromAgent).toMatchObject({ model: "agent-model" });

  const noAgentModel = await parseWithAgent(["-p", "--agent", "scout", "Explain."]);
  const fromEnv = await Effect.runPromise(
    resolveConfig(
      noAgentModel,
      { POPEYE_BASE_URL: "http://127.0.0.1:1234/v1", POPEYE_MODEL: "env-model" },
      discoveryWith([{ name: "scout" }]),
    ),
  );
  expect(fromEnv).toMatchObject({ model: "env-model" });
});

test("an agent without a model key and no env model still resolves the agent model path", async () => {
  const parsed = await parseWithAgent(["-p", "--agent", "scout", "Explain."]);
  const exit = await Effect.runPromiseExit(
    resolveConfig(
      parsed,
      { POPEYE_BASE_URL: "http://127.0.0.1:1234/v1" },
      discoveryWith([{ name: "scout" }]),
    ),
  );
  // Agent model absent and POPEYE_MODEL absent: still missing_model, and the
  // error shape is unchanged for runs without --agent.
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(String(exit.cause)).toContain("Missing model");
  }
});

test("unknown --agent names fail with unknown_agent listing available agents", async () => {
  const parsed = await parseWithAgent(["-p", "--agent", "ghost", "Explain."]);
  const error = await Effect.runPromise(
    Effect.flip(
      resolveConfig(
        parsed,
        { POPEYE_BASE_URL: "http://127.0.0.1:1234/v1", POPEYE_MODEL: "m" },
        discoveryWith([{ name: "scout" }, { name: "planner", scope: "project" }]),
      ),
    ),
  );
  expect(error).toMatchObject({ _tag: "CliConfigError", reason: "unknown_agent" });
  expect(error.message).toContain('"ghost"');
  expect(error.message).toContain("scout (user)");
  expect(error.message).toContain("planner (project)");

  const emptyDiscovery = await Effect.runPromise(
    Effect.flip(
      resolveConfig(parsed, { POPEYE_BASE_URL: "http://127.0.0.1:1234/v1", POPEYE_MODEL: "m" }),
    ),
  );
  expect(emptyDiscovery.message).toContain("Available agents: none");
});

test("an empty --agent value is refused as invalid_agent", async () => {
  const parsed = await parseWithAgent(["-p", "--agent", "", "Explain."]);
  const error = await Effect.runPromise(
    Effect.flip(
      resolveConfig(parsed, { POPEYE_BASE_URL: "http://127.0.0.1:1234/v1", POPEYE_MODEL: "m" }),
    ),
  );
  expect(error).toMatchObject({ _tag: "CliConfigError", reason: "invalid_agent" });
});

test("a resolved agent is carried on the run config with its body and tools", async () => {
  const parsed = await parseWithAgent(["-p", "--agent", "scout", "Explain."]);
  const config = await Effect.runPromise(
    resolveConfig(
      parsed,
      { POPEYE_BASE_URL: "http://127.0.0.1:1234/v1", POPEYE_MODEL: "m" },
      discoveryWith([{ body: "Be terse.", name: "scout", tools: ["read", "grep"] }]),
    ),
  );
  if (config.action !== "run") {
    throw new Error("Expected run config.");
  }
  expect(config.agent).toMatchObject({
    body: "Be terse.",
    filePath: "/agents/scout.md",
    model: undefined,
    name: "scout",
    tools: ["read", "grep"],
  });
});
