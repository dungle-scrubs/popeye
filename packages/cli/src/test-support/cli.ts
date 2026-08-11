import { spawnSync } from "node:child_process";

export const BUILT_BIN_PATH = new URL("../../dist/bin/peye.js", import.meta.url).pathname;
export const FAKE_PROVIDER_PROMPT = "Capture the CLI JSON stream.";
export const FAKE_PROVIDER_SCRIPT_PATH = new URL(
  "../../test-fixtures/cli-fake-provider.json",
  import.meta.url,
).pathname;
export const WORKSPACE_PATH = new URL("../../../..", import.meta.url).pathname;

export const cleanCliEnvironment = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "PEYE_API_KEY",
    "PEYE_BASE_URL",
    "PEYE_FAKE_PROVIDER",
    "PEYE_FAKE_PROVIDER_SCRIPT",
    "PEYE_MODEL",
  ]) {
    delete env[key];
  }
  return env;
};

export const fakeProviderEnvironment = (): NodeJS.ProcessEnv => ({
  ...cleanCliEnvironment(),
  PEYE_BASE_URL: "http://127.0.0.1:1234/v1",
  PEYE_FAKE_PROVIDER: "1",
  PEYE_FAKE_PROVIDER_SCRIPT: FAKE_PROVIDER_SCRIPT_PATH,
  PEYE_MODEL: "fake-model",
});

export const runBuiltBin = (
  args: ReadonlyArray<string>,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly input?: string;
  } = {},
) =>
  spawnSync(process.execPath, [BUILT_BIN_PATH, ...args], {
    cwd: WORKSPACE_PATH,
    encoding: "utf8",
    env: options.env ?? cleanCliEnvironment(),
    input: options.input,
    maxBuffer: 4 * 1024 * 1024,
  });
