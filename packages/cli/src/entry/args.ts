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

export interface ParsedRunArgs {
  readonly action: "run";
  readonly baseUrl: string | undefined;
  readonly mode: CliMode;
  readonly model: string | undefined;
  readonly noProjectPlugins: boolean;
  readonly pluginPaths: ReadonlyArray<string>;
  readonly prompt: string | undefined;
  readonly resume: string | undefined;
  readonly sessionDir: string | undefined;
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
          "base-url": { type: "string" },
          help: { short: "h", type: "boolean" },
          headless: { short: "p", type: "boolean" },
          mode: { type: "string" },
          model: { type: "string" },
          "no-project-plugins": { type: "boolean" },
          plugin: { multiple: true, type: "string" },
          resume: { type: "string" },
          "session-dir": { type: "string" },
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
      return Effect.succeed({
        action: "run" as const,
        baseUrl: values["base-url"],
        mode,
        model: values.model,
        noProjectPlugins: values["no-project-plugins"] ?? false,
        pluginPaths: values.plugin ?? [],
        prompt,
        resume: values.resume,
        sessionDir: values["session-dir"],
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
