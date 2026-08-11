/**
 * Owns lightweight process I/O, metadata actions, configuration, and the single Effect boundary.
 * It exists so help and version do not load the Driver composition graph.
 */
import { readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";

import { Cause, Data, Effect, Exit } from "effect";

import type { HeadWriteError, HeadWriter } from "../heads/shared.js";
import {
  errorMessage,
  errorTag,
  HEAD_EXIT_CODES,
  makeWritableHeadWriter,
} from "../heads/shared.js";
import { CliArgsError, type ParsedRunArgs, parseArgs, withStdinPrompt } from "./args.js";
import {
  type CliConfig,
  CliConfigError,
  type CliEnvironment,
  type CliRunConfig,
  resolveConfig,
} from "./config.js";

const CLI_USAGE = `Usage:
  peye -p "<prompt>"
  peye -p --mode json "<prompt>"
  peye -p --mode rpc
  peye "<prompt>"
  echo "<prompt>" | peye -p

Options:
  -p                     Run headless.
  --mode <print|json|rpc> Select the Head. Default: print.
  --model <model>        Select the Provider model. Env: PEYE_MODEL.
  --base-url <url>       Set the OpenAI-compatible endpoint. Env: PEYE_BASE_URL.
  --resume <sessionId>   Resume a Session.
  --session-dir <dir>    Set the Journal directory. Default: .peye/sessions.
  --version              Print the @pop-eye/cli version.
  --help                 Print this usage text.

Loopback endpoints need no API key; the CLI supplies its local placeholder automatically.
Hosted endpoints require PEYE_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.

Exit status:
  0  Turn completed or truncated.
  1  Provider-settled error.
  2  Invalid arguments, missing configuration, or an aborted turn.
  3  Unresolved tool calls.
  4  Turn failure or Head boundary failure.

Read stderr to distinguish exit 2 causes.
`;

interface CliInput extends Readable {
  readonly isTTY?: boolean;
}

export interface CliIo {
  readonly input: CliInput;
  readonly stderr: Writable;
  readonly stdout: Writable;
}

export class CliEntryError extends Data.TaggedError("CliEntryError")<{
  readonly cause?: unknown;
  readonly message: string;
  readonly reason: "input_failed" | "package_metadata_invalid" | "runtime_import_failed";
}> {}

const entryError = (
  reason: CliEntryError["reason"],
  message: string,
  cause?: unknown,
): CliEntryError =>
  new CliEntryError({
    ...(cause === undefined ? {} : { cause }),
    message,
    reason,
  });

const readStdin = (input: CliInput): Effect.Effect<string, CliEntryError> => {
  if (input.isTTY === true) {
    return Effect.succeed("");
  }
  return Effect.tryPromise({
    catch: (cause) => entryError("input_failed", "Could not read the prompt from stdin.", cause),
    try: async () => {
      let content = "";
      for await (const chunk of input) {
        content += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      }
      return content;
    },
  });
};

const completePrompt = (
  parsed: ParsedRunArgs,
  input: CliInput,
): Effect.Effect<ParsedRunArgs, CliArgsError | CliEntryError> => {
  if (parsed.prompt !== undefined || parsed.mode === "rpc") {
    return Effect.succeed(parsed);
  }
  return readStdin(input).pipe(Effect.flatMap((stdin) => withStdinPrompt(parsed, stdin)));
};

const packageVersion = (): Effect.Effect<string, CliEntryError> =>
  Effect.gen(function* () {
    const source = yield* Effect.tryPromise({
      catch: (cause) =>
        entryError(
          "package_metadata_invalid",
          "Could not read @pop-eye/cli package metadata.",
          cause,
        ),
      try: () => readFile(new URL("../../package.json", import.meta.url), "utf8"),
    });
    const metadata = yield* Effect.try({
      catch: (cause) =>
        entryError(
          "package_metadata_invalid",
          "@pop-eye/cli package metadata is not valid JSON.",
          cause,
        ),
      try: () => JSON.parse(source) as unknown,
    });
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      !("version" in metadata) ||
      typeof metadata.version !== "string"
    ) {
      return yield* entryError(
        "package_metadata_invalid",
        "@pop-eye/cli package metadata has no version.",
      );
    }
    return metadata.version;
  });

const runConfigured = (
  config: CliRunConfig,
  io: CliIo,
): Effect.Effect<number, CliEntryError | unknown> =>
  Effect.tryPromise({
    catch: (cause) => entryError("runtime_import_failed", "Could not load the CLI runtime.", cause),
    try: () => import("./run.js"),
  }).pipe(Effect.flatMap(({ run }) => run(config, io)));

const dispatch = (
  config: CliConfig,
  io: CliIo,
  writer: HeadWriter,
): Effect.Effect<number, CliEntryError | HeadWriteError | unknown> => {
  if (config.action === "help") {
    return writer.write(CLI_USAGE).pipe(Effect.as(HEAD_EXIT_CODES.done));
  }
  if (config.action === "version") {
    return packageVersion().pipe(
      Effect.flatMap((version) => writer.write(`${version}\n`)),
      Effect.as(HEAD_EXIT_CODES.done),
    );
  }
  return runConfigured(config, io);
};

const cliFailureExitCode = (error: unknown): number =>
  error instanceof CliArgsError || error instanceof CliConfigError ? 2 : 4;

const reportCliFailure = (
  error: unknown,
  writer: HeadWriter,
): Effect.Effect<number, HeadWriteError> =>
  writer
    .write(`ERROR ${errorTag(error, "CliError")}: ${errorMessage(error)}\n`)
    .pipe(Effect.as(cliFailureExitCode(error)));

export const executeCli = async (
  argv: ReadonlyArray<string>,
  env: CliEnvironment,
  io: CliIo,
): Promise<number> => {
  const stdoutWriter = makeWritableHeadWriter(io.stdout);
  const errorWriter = makeWritableHeadWriter(io.stderr);
  const program = Effect.gen(function* () {
    const initial = yield* parseArgs(argv);
    const parsed = initial.action === "run" ? yield* completePrompt(initial, io.input) : initial;
    const config = yield* resolveConfig(parsed, env);
    return yield* dispatch(config, io, stdoutWriter);
  }).pipe(Effect.catchAll((error) => reportCliFailure(error, errorWriter)));

  const exit = await Effect.runPromiseExit(program);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const [first] = Cause.prettyErrors(exit.cause);
  io.stderr.write(`ERROR CliBoundaryError: ${first?.message ?? Cause.pretty(exit.cause)}\n`);
  return HEAD_EXIT_CODES.turnFailure;
};
