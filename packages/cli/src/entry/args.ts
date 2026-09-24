/**
 * Owns the command-line argument interface for the popeye executable.
 * It exists so argument syntax and typed failures stay independent from process I/O.
 */
import { parseArgs as parseNodeArgs } from "node:util";

import { Data, Effect } from "effect";

export class CliArgsError extends Data.TaggedError("CliArgsError")<{
  readonly cause?: unknown;
  readonly message: string;
  readonly reason: "invalid_arguments" | "secret_flag";
}> {}

export const HCN_EFFORTS = ["low", "medium-low", "medium", "medium-high", "high", "xhigh"] as const;

export type HcnEffort = (typeof HCN_EFFORTS)[number];

/** RFC-02 P4 effort ladder onto kernel thinking levels. */
export const HCN_EFFORT_TO_THINKING_LEVEL = {
  high: "xhigh",
  low: "minimal",
  medium: "medium",
  "medium-high": "high",
  "medium-low": "low",
  xhigh: "max",
} as const satisfies Record<HcnEffort, string>;

export interface ParsedRunArgs {
  readonly action: "run";
  /** HCN read/write tool access preset. */
  readonly access: string | undefined;
  /** Extra system-prompt fragment appended last. */
  readonly appendSystemPrompt: string | undefined;
  readonly baseUrl: string | undefined;
  /** Trusted context-window override for HCN runs. */
  readonly contextWindow: number | undefined;
  readonly effort: HcnEffort | undefined;
  /** Tool allowlist: names or native:<name>. */
  readonly excludeTools: ReadonlyArray<string>;
  /** Tool-free isolation. */
  readonly isolation: string | undefined;
  /** Cross-session memory switch (declared no-op divergence). */
  readonly memory: boolean | undefined;
  readonly mode: CliMode;
  readonly model: string | undefined;
  readonly noProjectPlugins: boolean;
  readonly pluginPaths: ReadonlyArray<string>;
  readonly prompt: string | undefined;
  /** Question preamble mode (ask is a declared divergence). */
  readonly questions: string | undefined;
  readonly resume: string | undefined;
  /** Refused as unexpressible (flat dir, no workspace binding). */
  readonly resumeLast: boolean;
  readonly sessionDir: string | undefined;
  /** Plugin-name allowlist for skill loading. */
  readonly skills: ReadonlyArray<string>;
  /** System-prompt replace (refused until fragment audit lands). */
  readonly systemPrompt: string | undefined;
  /** Tool allowlist: names or native:<name>. */
  readonly tools: ReadonlyArray<string>;
}

export type ParsedArgs =
  | ParsedRunArgs
  | { readonly action: "help" }
  | { readonly action: "version" };

export type CliMode = "hcn" | "json" | "print" | "rpc";

const CLI_MODES: ReadonlySet<string> = new Set<CliMode>(["hcn", "json", "print", "rpc"]);

const isCliMode = (value: string): value is CliMode => CLI_MODES.has(value);

const invalidArguments = (message: string, cause?: unknown): CliArgsError =>
  new CliArgsError({
    ...(cause === undefined ? {} : { cause }),
    message,
    reason: "invalid_arguments",
  });

const promptRequired = (): CliArgsError => invalidArguments('Use popeye -p "<prompt>".');

const secretFlagError = (): CliArgsError =>
  new CliArgsError({
    message:
      "--api-key is not supported. Set POPEYE_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.",
    reason: "secret_flag",
  });

const metaAction = (values: {
  readonly help?: boolean;
  readonly version?: boolean;
}): "help" | "version" | undefined =>
  values.help === true ? "help" : values.version === true ? "version" : undefined;

const isHcnEffort = (value: string): value is HcnEffort =>
  (HCN_EFFORTS as ReadonlyArray<string>).includes(value);

const splitList = (raw: string | undefined): ReadonlyArray<string> => {
  if (raw === undefined) {
    return [];
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? [] : trimmed.split(",").map((name) => name.trim());
};

export const parseArgs = (argv: ReadonlyArray<string>): Effect.Effect<ParsedArgs, CliArgsError> => {
  if (argv.some((argument) => argument === "--api-key" || argument.startsWith("--api-key="))) {
    return Effect.fail(secretFlagError());
  }
  return Effect.try({
    catch: (cause) => invalidArguments(`Invalid arguments: ${String(cause)}`, cause),
    try: () =>
      parseNodeArgs({
        allowPositionals: true,
        args: [...argv],
        options: {
          access: { type: "string" },
          "append-system-prompt": { type: "string" },
          "base-url": { type: "string" },
          "context-window": { type: "string" },
          effort: { type: "string" },
          "exclude-tools": { type: "string" },
          help: { short: "h", type: "boolean" },
          headless: { short: "p", type: "boolean" },
          isolation: { type: "string" },
          memory: { type: "boolean" },
          mode: { type: "string" },
          model: { type: "string" },
          "no-memory": { type: "boolean" },
          "no-project-plugins": { type: "boolean" },
          plugin: { multiple: true, type: "string" },
          questions: { type: "string" },
          resume: { type: "string" },
          "resume-last": { type: "boolean" },
          "session-dir": { type: "string" },
          skills: { type: "string" },
          "system-prompt": { type: "string" },
          tools: { type: "string" },
          version: { type: "boolean" },
        },
        strict: true,
      }),
  }).pipe(
    Effect.flatMap(({ positionals, values }): Effect.Effect<ParsedArgs, CliArgsError> => {
      const action = metaAction(values);
      if (action !== undefined) {
        return Effect.succeed({ action });
      }
      const mode = values.mode ?? "print";
      if (!isCliMode(mode)) {
        return Effect.fail(
          invalidArguments(
            `Invalid --mode value ${JSON.stringify(mode)}. Use print, json, rpc, or hcn.`,
          ),
        );
      }
      if (values.plugin?.some((path) => path.trim() === "")) {
        return Effect.fail(invalidArguments("--plugin requires a non-empty path."));
      }
      if (positionals.length > 1) {
        return Effect.fail(promptRequired());
      }
      const prompt = positionals[0];
      if (mode === "rpc" && prompt !== undefined) {
        return Effect.fail(
          invalidArguments("RPC mode does not accept a prompt. Use popeye -p --mode rpc."),
        );
      }
      if (prompt === undefined && mode !== "rpc" && values.headless !== true) {
        return Effect.fail(promptRequired());
      }
      const effort = values.effort;
      if (effort !== undefined && !isHcnEffort(effort)) {
        return Effect.fail(
          invalidArguments(
            `Invalid --effort value ${JSON.stringify(effort)}. Use ${HCN_EFFORTS.join(", ")}.`,
          ),
        );
      }
      // HCN callers are untrusted for tool grants: unrecognized values
      // refuse instead of widening to a full grant.
      if (values.access !== undefined && values.access !== "read" && values.access !== "write") {
        return Effect.fail(
          invalidArguments(
            `Invalid --access value ${JSON.stringify(values.access)}. Use read or write.`,
          ),
        );
      }
      if (values.isolation !== undefined && values.isolation !== "tool-free") {
        return Effect.fail(
          invalidArguments(
            `Invalid --isolation value ${JSON.stringify(values.isolation)}. Use tool-free.`,
          ),
        );
      }
      const contextWindow =
        values["context-window"] === undefined ? undefined : Number(values["context-window"]);
      if (contextWindow !== undefined && !Number.isSafeInteger(contextWindow)) {
        return Effect.fail(
          invalidArguments(
            `Invalid --context-window value ${JSON.stringify(values["context-window"])}. Use an integer.`,
          ),
        );
      }
      return Effect.succeed({
        action: "run" as const,
        access: values.access,
        appendSystemPrompt: values["append-system-prompt"],
        baseUrl: values["base-url"],
        contextWindow,
        effort,
        excludeTools: splitList(values["exclude-tools"]),
        isolation: values.isolation,
        memory: values.memory === true ? true : values["no-memory"] === true ? false : undefined,
        mode,
        model: values.model,
        noProjectPlugins: values["no-project-plugins"] ?? false,
        pluginPaths: values.plugin ?? [],
        prompt,
        questions: values.questions,
        resume: values.resume,
        resumeLast: values["resume-last"] ?? false,
        sessionDir: values["session-dir"],
        skills: splitList(values.skills),
        systemPrompt: values["system-prompt"],
        tools: splitList(values.tools),
      });
    }),
  );
};

export const withStdinPrompt = (
  parsed: ParsedRunArgs,
  stdin: string,
): Effect.Effect<ParsedRunArgs, CliArgsError> => {
  if (parsed.prompt !== undefined || parsed.mode === "rpc") {
    return Effect.succeed(parsed);
  }
  const prompt = stdin.trimEnd();
  if (prompt.length === 0) {
    return Effect.fail(promptRequired());
  }
  return Effect.succeed({ ...parsed, prompt });
};
