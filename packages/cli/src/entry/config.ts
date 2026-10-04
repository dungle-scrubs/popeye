/**
 * Owns Plugin, Provider, and Session configuration for the popeye executable.
 * It exists so precedence, secret handling, and startup validation stay at one interface.
 */
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import { Data, Effect } from "effect";

import type { AgentDiscoveryResult } from "../agents/loader.js";
import type { CliMode, HcnEffort, ParsedArgs } from "./args.js";

export type CliConfigErrorReason =
  | "agent_dir_unreadable"
  | "agent_duplicate_name"
  | "agent_project_unresolvable"
  | "agent_symlink_escape"
  | "invalid_agent"
  | "invalid_base_url"
  | "invalid_model"
  | "missing_api_key"
  | "missing_base_url"
  | "missing_fake_provider_script"
  | "missing_model"
  | "unknown_agent"
  | "unexpressible_flag";

export class CliConfigError extends Data.TaggedError("CliConfigError")<{
  readonly cause?: unknown;
  readonly message: string;
  readonly reason: CliConfigErrorReason;
}> {}

/** The resolved Agent definition a session runs as (RFC-04). */
export interface CliAgentSelection {
  /** Trimmed markdown body; empty string appends nothing. */
  readonly body: string;
  readonly filePath: string;
  /** Informational: already merged into CliRunConfig.model. */
  readonly model: string | undefined;
  readonly name: string;
  /** Normalized tool names; undefined means no restriction. */
  readonly tools: ReadonlyArray<string> | undefined;
}

/** Which input won RFC-04 §3 model precedence for the process. */
export type CliModelSource = "agent" | "env" | "flag";

export interface CliRunConfig {
  readonly action: "run";
  readonly access: string | undefined;
  readonly agent: CliAgentSelection | undefined;
  /** Endpoint credential: POPEYE_API_KEY, the recognized host's provider key, or the loopback placeholder. */
  readonly apiKey: string;
  readonly appendSystemPrompt: string | undefined;
  readonly baseUrl: string;
  readonly baseUrlHost: string;
  readonly accountingProviderClass: "local" | "unknown";
  readonly contextWindow: number | undefined;
  readonly effort: HcnEffort | undefined;
  readonly excludeTools: ReadonlyArray<string>;
  readonly fakeProviderScript: string | undefined;
  readonly isolation: string | undefined;
  /** Declared no-op divergence: accepted and ignored. */
  readonly memory: boolean | undefined;
  readonly mode: CliMode;
  readonly model: string;
  /** rpc applies the agent model per Session only when the process model is not from --model. */
  readonly modelSource: CliModelSource;
  readonly noProjectPlugins: boolean;
  readonly pluginPaths: ReadonlyArray<string>;
  readonly prompt: string | undefined;
  /** Declared divergence: ask never emits awaiting-input. */
  readonly questions: string | undefined;
  readonly resume: string | undefined;
  readonly sessionDir: string;
  readonly skills: ReadonlyArray<string>;
  readonly systemPrompt: string | undefined;
  readonly tools: ReadonlyArray<string>;
  readonly userPluginDir: string;
}

export type CliConfig = CliRunConfig | { readonly action: "help" } | { readonly action: "version" };

export type CliEnvironment = Readonly<Record<string, string | undefined>>;

const USER_AGENTS_DIR_DEFAULT = join(homedir(), ".popeye", "agents");

/**
 * User-scope Agent definition directory. POPEYE_AGENTS_DIR is
 * operator-controlled trusted input, in the posture of POPEYE_USER_PLUGIN_DIR.
 */
export const resolveUserAgentsDir = (env: CliEnvironment): string =>
  configured(env.POPEYE_AGENTS_DIR) ?? USER_AGENTS_DIR_DEFAULT;

const BASE_URL_SETUP = "Set --base-url <url> or POPEYE_BASE_URL.";
// Local OpenAI-compatible servers ignore the key, but pi-ai requires a non-empty value.
const LOCAL_API_KEY_PLACEHOLDER = "local";
const MODEL_SETUP = "Set --model <model> or POPEYE_MODEL.";

const configured = (value: string | undefined): string | undefined =>
  value === undefined || value.length === 0 ? undefined : value;

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "::1" ||
  hostname === "[::1]" ||
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  (isIP(hostname) === 4 && hostname.startsWith("127."));

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

/**
 * Provider key environment variables, each read only for its own official API origin.
 * Every other non-loopback endpoint requires POPEYE_API_KEY.
 */
export const PROVIDER_API_KEYS: ReadonlyArray<{
  readonly origin: string;
  readonly variable: string;
}> = [
  { origin: "https://api.openai.com", variable: "OPENAI_API_KEY" },
  { origin: "https://api.anthropic.com", variable: "ANTHROPIC_API_KEY" },
];

const PROVIDER_KEY_SCOPE = `${new Intl.ListFormat("en", { type: "conjunction" }).format(
  PROVIDER_API_KEYS.map((entry) => entry.variable),
)} are sent only to their own API hosts.`;

// pi-ai treats a whitespace-only apiKey as absent and substitutes its provider-keyed, host-blind
// environment lookup, so a credential counts only when it has a non-whitespace character.
const configuredCredential = (value: string | undefined): string | undefined =>
  value === undefined || value.trim().length === 0 ? undefined : value;

const resolveApiKey = (
  env: CliEnvironment,
  endpoint: URL,
): Effect.Effect<string, CliConfigError> => {
  const explicit = configuredCredential(env.POPEYE_API_KEY);
  if (explicit !== undefined) {
    return Effect.succeed(explicit);
  }
  if (isLoopbackHost(endpoint.hostname)) {
    return Effect.succeed(LOCAL_API_KEY_PLACEHOLDER);
  }
  const recognized = PROVIDER_API_KEYS.find((entry) => entry.origin === endpoint.origin);
  if (recognized === undefined) {
    return Effect.fail(
      configError(
        "missing_api_key",
        `Endpoint ${endpoint.origin} requires POPEYE_API_KEY. ${PROVIDER_KEY_SCOPE}`,
      ),
    );
  }
  const providerKey = configuredCredential(env[recognized.variable]);
  return providerKey === undefined
    ? Effect.fail(
        configError(
          "missing_api_key",
          `Endpoint ${endpoint.origin} requires POPEYE_API_KEY or ${recognized.variable}.`,
        ),
      )
    : Effect.succeed(providerKey);
};

/**
 * RFC-04 E-Agent-Unknown: the one message contract for --agent, the rpc create and resume agent field,
 * and the delegate Tool.
 */
export const unknownAgentMessage = (
  name: string,
  discovery: AgentDiscoveryResult | undefined,
): string => {
  const available = [...(discovery?.agents.values() ?? [])]
    .map((definition) => `${definition.name} (${definition.scope})`)
    .join(", ");
  return `Unknown agent ${JSON.stringify(name)}. Available agents: ${available.length > 0 ? available : "none"}.`;
};

export const resolveConfig = (
  parsed: ParsedArgs,
  env: CliEnvironment,
  agentDiscovery: AgentDiscoveryResult | undefined = undefined,
): Effect.Effect<CliConfig, CliConfigError> =>
  Effect.gen(function* () {
    if (parsed.action !== "run") {
      return parsed;
    }
    if (parsed.agent !== undefined && parsed.agent.length === 0) {
      return yield* configError(
        "invalid_agent",
        'Invalid --agent value "". Provide a non-empty name.',
      );
    }
    const agentName = configured(parsed.agent);
    let agent: CliAgentSelection | undefined;
    if (agentName !== undefined) {
      const discovered = agentDiscovery?.agents.get(agentName);
      if (discovered === undefined) {
        return yield* configError("unknown_agent", unknownAgentMessage(agentName, agentDiscovery));
      }
      agent = {
        body: discovered.body,
        filePath: discovered.filePath,
        model: discovered.model,
        name: discovered.name,
        tools: discovered.tools,
      };
    }
    // Flat journal dir with no workspace binding risks resuming a stranger
    // session: refuse before touching any session state.
    if (parsed.resumeLast === true) {
      return yield* configError(
        "unexpressible_flag",
        "--resume-last is not supported: popeye sessions have no workspace binding.",
      );
    }
    if (parsed.model === "") {
      return yield* configError(
        "invalid_model",
        'Invalid --model value "". Provide a non-empty model.',
      );
    }
    // Model precedence: --model flag > agent file model > POPEYE_MODEL env.
    const model = parsed.model ?? configured(agent?.model) ?? configured(env.POPEYE_MODEL);
    if (model === undefined) {
      return yield* configError("missing_model", `Missing model. ${MODEL_SETUP}`);
    }
    const modelSource: CliModelSource =
      parsed.model !== undefined
        ? "flag"
        : configured(agent?.model) !== undefined
          ? "agent"
          : "env";
    if (parsed.baseUrl === "") {
      return yield* configError(
        "invalid_base_url",
        'Invalid --base-url value "". Provide a non-empty URL.',
      );
    }
    const baseUrl = parsed.baseUrl ?? configured(env.POPEYE_BASE_URL);
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
    const apiKey = yield* resolveApiKey(env, endpoint);
    const fakeProviderScript =
      env.POPEYE_FAKE_PROVIDER === "1" ? configured(env.POPEYE_FAKE_PROVIDER_SCRIPT) : undefined;
    if (env.POPEYE_FAKE_PROVIDER === "1" && fakeProviderScript === undefined) {
      return yield* configError(
        "missing_fake_provider_script",
        "POPEYE_FAKE_PROVIDER=1 requires POPEYE_FAKE_PROVIDER_SCRIPT.",
      );
    }

    return {
      action: "run",
      access: configured(parsed.access),
      agent,
      apiKey,
      appendSystemPrompt: configured(parsed.appendSystemPrompt),
      baseUrl,
      baseUrlHost: endpoint.hostname,
      accountingProviderClass: isLoopbackHost(endpoint.hostname) ? "local" : "unknown",
      contextWindow: parsed.contextWindow,
      effort: parsed.effort,
      excludeTools: parsed.excludeTools,
      fakeProviderScript,
      isolation: configured(parsed.isolation),
      memory: parsed.memory,
      mode: parsed.mode,
      model,
      modelSource,
      noProjectPlugins: parsed.noProjectPlugins,
      pluginPaths: parsed.pluginPaths,
      prompt: parsed.prompt,
      questions: configured(parsed.questions),
      resume: configured(parsed.resume),
      sessionDir: configured(parsed.sessionDir) ?? ".popeye/sessions",
      skills: parsed.skills,
      systemPrompt: configured(parsed.systemPrompt),
      tools: parsed.tools,
      // POPEYE_USER_PLUGIN_DIR is test-support and deliberately undocumented,
      // the same posture as POPEYE_FAKE_PROVIDER_SCRIPT.
      userPluginDir:
        configured(env.POPEYE_USER_PLUGIN_DIR) ?? join(homedir(), ".popeye", "plugins"),
    };
  });
