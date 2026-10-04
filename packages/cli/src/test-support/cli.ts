import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BUILT_BIN_PATH = new URL("../../dist/bin/popeye.js", import.meta.url).pathname;
export const FAKE_PROVIDER_PROMPT = "Capture the CLI JSON stream.";
export const FAKE_PROVIDER_SCRIPT_PATH = new URL(
  "../../test-fixtures/cli-fake-provider.json",
  import.meta.url,
).pathname;
export const WORKSPACE_PATH = new URL("../../../..", import.meta.url).pathname;

/**
 * A user-scope Agent directory that never exists. Discovery treats a missing directory as empty,
 * so a spawned CLI never reads the developer's ~/.popeye/agents: Tool counts and the delegate
 * Tool's registration (RFC-04 §6) stay independent of the machine. A test that needs Agent
 * definitions sets POPEYE_AGENTS_DIR to its own directory.
 */
export const ABSENT_AGENTS_DIR = new URL(
  "../../test-fixtures/agents-dir-never-created",
  import.meta.url,
).pathname;

export const cleanCliEnvironment = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "POPEYE_AGENTS_DIR",
    "POPEYE_API_KEY",
    "POPEYE_BASE_URL",
    "POPEYE_FAKE_PROVIDER",
    "POPEYE_FAKE_PROVIDER_SCRIPT",
    "POPEYE_MODEL",
    "POPEYE_REFLECT_INTAKE",
    "POPEYE_USER_PLUGIN_DIR",
    "REFLECT_INTAKE_WORK_PARENT",
    "HCN_INVOCATION_ID",
  ]) {
    delete env[key];
  }
  env.POPEYE_AGENTS_DIR = ABSENT_AGENTS_DIR;
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
) => {
  const temporaryCwd =
    options.cwd === undefined ? mkdtempSync(join(tmpdir(), "popeye-bin-")) : undefined;
  try {
    return spawnSync(process.execPath, [BUILT_BIN_PATH, ...args], {
      cwd: options.cwd ?? temporaryCwd,
      encoding: "utf8",
      env: options.env ?? cleanCliEnvironment(),
      input: options.input,
      maxBuffer: 4 * 1024 * 1024,
    });
  } finally {
    if (temporaryCwd !== undefined) {
      rmSync(temporaryCwd, { force: true, recursive: true });
    }
  }
};
