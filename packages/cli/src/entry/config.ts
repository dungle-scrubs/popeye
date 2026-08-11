/**
 * Owns Plugin, Provider, and Session configuration for the peye executable.
 * It exists so precedence, secret handling, and startup validation stay at one interface.
 */
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import { Data, Effect } from "effect";

import type { CliMode, ParsedArgs } from "./args.js";

export type CliConfigErrorReason =
  | "invalid_base_url"
  | "invalid_model"
  | "missing_api_key"
  | "missing_base_url"
  | "missing_fake_provider_script"
  | "missing_model";

export class CliConfigError extends Data.TaggedError("CliConfigError")<{
  readonly cause?: unknown;
  readonly message: string;
  readonly reason: CliConfigErrorReason;
}> {}

export interface CliRunConfig {
  readonly action: "run";
  readonly apiKey: string | undefined;
  readonly baseUrl: string;
  readonly baseUrlHost: string;
  readonly fakeProviderScript: string | undefined;
  readonly mode: CliMode;
  readonly model: string;
  readonly noProjectPlugins: boolean;
  readonly pluginPaths: ReadonlyArray<string>;
  readonly prompt: string | undefined;
  readonly resume: string | undefined;
  readonly sessionDir: string;
  readonly userPluginDir: string;
}

export type CliConfig = CliRunConfig | { readonly action: "help" } | { readonly action: "version" };

export type CliEnvironment = Readonly<Record<string, string | undefined>>;

const BASE_URL_SETUP = "Set --base-url <url> or PEYE_BASE_URL.";
// Local OpenAI-compatible servers ignore the key, but pi-ai requires a non-empty value.
const LOCAL_API_KEY_PLACEHOLDER = "local";
const MODEL_SETUP = "Set --model <model> or PEYE_MODEL.";

const configured = (value: string | undefined): string | undefined =>
  value === undefined || value.length === 0 ? undefined : value;

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "::1" ||
  hostname === "[::1]" ||
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  (isIP(hostname) === 4 && hostname.startsWith("127."));

const resolveApiKey = (env: CliEnvironment): string | undefined =>
  configured(env.PEYE_API_KEY) ??
  configured(env.OPENAI_API_KEY) ??
  configured(env.ANTHROPIC_API_KEY);

const configError = (
  reason: CliConfigErrorReason,
  message: string,
  cause?: unknown,
): CliConfigError =>
  new CliConfigError({
    ...(cause === undefined ? {} : { cause }),
    message,
    reason,
  });

export const resolveConfig = (
  parsed: ParsedArgs,
  env: CliEnvironment,
): Effect.Effect<CliConfig, CliConfigError> =>
  Effect.gen(function* () {
    if (parsed.action !== "run") {
      return parsed;
    }
    if (parsed.model === "") {
      return yield* configError(
        "invalid_model",
        'Invalid --model value "". Provide a non-empty model.',
      );
    }
    const model = parsed.model ?? configured(env.PEYE_MODEL);
    if (model === undefined) {
      return yield* configError("missing_model", `Missing model. ${MODEL_SETUP}`);
    }
    if (parsed.baseUrl === "") {
      return yield* configError(
        "invalid_base_url",
        'Invalid --base-url value "". Provide a non-empty URL.',
      );
    }
    const baseUrl = parsed.baseUrl ?? configured(env.PEYE_BASE_URL);
    if (baseUrl === undefined) {
      return yield* configError("missing_base_url", `Missing endpoint. ${BASE_URL_SETUP}`);
    }
    const endpoint = yield* Effect.try({
      catch: (cause) =>
        configError(
          "invalid_base_url",
          `Invalid endpoint ${JSON.stringify(baseUrl)}. ${BASE_URL_SETUP}`,
          cause,
        ),
      try: () => new URL(baseUrl),
    });
    const apiKey =
      resolveApiKey(env) ??
      (isLoopbackHost(endpoint.hostname) ? LOCAL_API_KEY_PLACEHOLDER : undefined);
    if (!isLoopbackHost(endpoint.hostname) && apiKey === undefined) {
      return yield* configError(
        "missing_api_key",
        "Hosted endpoint requires PEYE_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.",
      );
    }
    const fakeProviderScript =
      env.PEYE_FAKE_PROVIDER === "1" ? configured(env.PEYE_FAKE_PROVIDER_SCRIPT) : undefined;
    if (env.PEYE_FAKE_PROVIDER === "1" && fakeProviderScript === undefined) {
      return yield* configError(
        "missing_fake_provider_script",
        "PEYE_FAKE_PROVIDER=1 requires PEYE_FAKE_PROVIDER_SCRIPT.",
      );
    }

    return {
      action: "run",
      apiKey,
      baseUrl,
      baseUrlHost: endpoint.hostname,
      fakeProviderScript,
      mode: parsed.mode,
      model,
      noProjectPlugins: parsed.noProjectPlugins,
      pluginPaths: parsed.pluginPaths,
      prompt: parsed.prompt,
      resume: configured(parsed.resume),
      sessionDir: configured(parsed.sessionDir) ?? ".peye/sessions",
      // PEYE_USER_PLUGIN_DIR is test-support and deliberately undocumented,
      // the same posture as PEYE_FAKE_PROVIDER_SCRIPT.
      userPluginDir: configured(env.PEYE_USER_PLUGIN_DIR) ?? join(homedir(), ".peye", "plugins"),
    };
  });
