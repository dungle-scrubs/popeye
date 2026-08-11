import { Effect } from "effect";
import { expect, test } from "vitest";

import { parseArgs } from "./args.js";
import { resolveConfig } from "./config.js";

test("flags override PEYE provider environment values", async () => {
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
      PEYE_API_KEY: "peye-key",
      PEYE_BASE_URL: "https://env.example/v1",
      PEYE_MODEL: "env-model",
    }),
  );

  expect(config).toMatchObject({
    action: "run",
    apiKey: "peye-key",
    baseUrl: "https://flag.example/v1",
    baseUrlHost: "flag.example",
    model: "flag-model",
    sessionDir: "/tmp/flag-sessions",
  });
});

test("API keys fall back from PEYE to OpenAI and then Anthropic", async () => {
  const parsed = await Effect.runPromise(parseArgs(["-p", "Explain."]));
  const peye = await Effect.runPromise(
    resolveConfig(parsed, {
      ANTHROPIC_API_KEY: "anthropic-key",
      OPENAI_API_KEY: "openai-key",
      PEYE_API_KEY: "peye-key",
      PEYE_BASE_URL: "https://gateway.example/v1",
      PEYE_MODEL: "gateway-model",
    }),
  );
  const openAi = await Effect.runPromise(
    resolveConfig(parsed, {
      ANTHROPIC_API_KEY: "anthropic-key",
      OPENAI_API_KEY: "openai-key",
      PEYE_BASE_URL: "https://gateway.example/v1",
      PEYE_MODEL: "gateway-model",
    }),
  );
  const anthropic = await Effect.runPromise(
    resolveConfig(parsed, {
      ANTHROPIC_API_KEY: "anthropic-key",
      PEYE_BASE_URL: "https://gateway.example/v1",
      PEYE_MODEL: "gateway-model",
    }),
  );

  expect(peye).toMatchObject({ action: "run", apiKey: "peye-key" });
  expect(openAi).toMatchObject({ action: "run", apiKey: "openai-key" });
  expect(anthropic).toMatchObject({ action: "run", apiKey: "anthropic-key" });
});

test("missing model and endpoint failures name the exact flag and environment variable", async () => {
  const parsed = await Effect.runPromise(parseArgs(["-p", "Explain."]));
  const missingModel = await Effect.runPromise(
    Effect.flip(resolveConfig(parsed, { PEYE_BASE_URL: "http://127.0.0.1:1234/v1" })),
  );
  const missingEndpoint = await Effect.runPromise(
    Effect.flip(resolveConfig(parsed, { PEYE_MODEL: "local-model" })),
  );

  expect(missingModel).toMatchObject({
    _tag: "CliConfigError",
    message: expect.stringContaining("--model <model> or PEYE_MODEL"),
    reason: "missing_model",
  });
  expect(missingEndpoint).toMatchObject({
    _tag: "CliConfigError",
    message: expect.stringContaining("--base-url <url> or PEYE_BASE_URL"),
    reason: "missing_base_url",
  });
});

test("loopback endpoints need no key while hosted endpoints name every key environment variable", async () => {
  const parsed = await Effect.runPromise(parseArgs(["-p", "Explain."]));
  const local = await Effect.runPromise(
    resolveConfig(parsed, {
      PEYE_BASE_URL: "http://127.0.0.1:1234/v1",
      PEYE_MODEL: "local-model",
    }),
  );
  const hosted = await Effect.runPromise(
    Effect.flip(
      resolveConfig(parsed, {
        PEYE_BASE_URL: "https://gateway.example/v1",
        PEYE_MODEL: "hosted-model",
      }),
    ),
  );

  expect(local).toMatchObject({ apiKey: undefined, baseUrlHost: "127.0.0.1" });
  expect(hosted).toMatchObject({
    _tag: "CliConfigError",
    message: expect.stringMatching(/PEYE_API_KEY.*OPENAI_API_KEY.*ANTHROPIC_API_KEY/u),
    reason: "missing_api_key",
  });
});

test("hostnames that only start with 127 are still hosted endpoints", async () => {
  const parsed = await Effect.runPromise(parseArgs(["-p", "Explain."]));
  const error = await Effect.runPromise(
    Effect.flip(
      resolveConfig(parsed, {
        PEYE_BASE_URL: "https://127.example.com/v1",
        PEYE_MODEL: "hosted-model",
      }),
    ),
  );

  expect(error).toMatchObject({
    _tag: "CliConfigError",
    reason: "missing_api_key",
  });
});
