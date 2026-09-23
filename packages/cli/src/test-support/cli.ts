import { spawnSync } from "node:child_process";

export const BUILT_BIN_PATH = new URL("../../dist/bin/popeye.js", import.meta.url).pathname;
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
    "POPEYE_API_KEY",
    "POPEYE_BASE_URL",
    "POPEYE_FAKE_PROVIDER",
    "POPEYE_FAKE_PROVIDER_SCRIPT",
    "POPEYE_MODEL",
    "POPEYE_USER_PLUGIN_DIR",
  ]) {
    delete env[key];
  }
  return env;
};

export const fakeProviderEnvironment = (): NodeJS.ProcessEnv => ({
  ...cleanCliEnvironment(),
  POPEYE_BASE_URL: "http://127.0.0.1:1234/v1",
  POPEYE_FAKE_PROVIDER: "1",
  POPEYE_FAKE_PROVIDER_SCRIPT: FAKE_PROVIDER_SCRIPT_PATH,
  POPEYE_MODEL: "fake-model",
});

export const runBuiltBin = (
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly input?: string;
  } = {},
) =>
  spawnSync(process.execPath, [BUILT_BIN_PATH, ...args], {
    cwd: options.cwd ?? WORKSPACE_PATH,
    encoding: "utf8",
    env: options.env ?? cleanCliEnvironment(),
    input: options.input,
    maxBuffer: 4 * 1024 * 1024,
  });
