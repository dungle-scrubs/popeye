/**
 * Owns the CLI entry pipeline from argv/env/io to HeadExitCode.
 * It exists so startup sequencing, secret filtering, stdin TTY gate,
 * loopback placeholder key, fake Provider wiring, Plugin composition,
 * and Head dispatch live behind one deep interface executeCli.
 *
 * Why this module: args.ts (139 lines), config.ts (150), execute.ts
 * (206) and run.ts (266) were four shallow pass-throughs. Each added
 * ~one branch or one Effect.flatMap, but no single seam owned the
 * path from argv to Head. Bugs (loopback fallback, stdin-TTY gate,
 * dynamic import boundary, STARTUP audit) hid between the layers.
 * This module hides that path behind executeCli(argv, env, io).
 * args.ts and config.ts remain as internal seams (syntax vs
 * precedence), and run.ts becomes thin Layer assembly only.
 * Not responsible for Head rendering (heads own that), for generation
 * lifetime (GenerationRuntime owns that), or for journal persistence
 * (adapter-core owns that). The seam is process I/O: two adapters
 * justify it — NodeCliAdapter (real stdin/stdout) and TestCliAdapter
 * (in-memory PassThrough + capture writers) — both already exercised
 * in bin.test.ts and rpc.test.ts.
 */

import { readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";

import { JournalStore, type JournalStoreEnv, SessionIdSchema } from "@popeye/journal";
import { type PluginInteractions, PluginInteractionsNullLive } from "@popeye/plugins";
import { Cause, Data, Effect, Exit, Layer, Logger, Schema, Stream } from "effect";

import type { AssistantItem, Driver, ProviderService } from "../compose.js";
import {
  AssistantStopReasonSchema,
  GenerationDriverDefault,
  PiAiProviderLive,
  Provider,
  ProviderError,
  ToolRegistry,
} from "../compose.js";
import {
  errorMessage,
  errorTag,
  HEAD_EXIT_CODES,
  type HeadExitCode,
  type HeadWriteError,
  type HeadWriter,
  makeWritableHeadWriter,
  makeWritableLogfmtLogger,
} from "../heads/head-wire.js";
import { runJsonHead } from "../heads/json.js";
import { runPrintHead } from "../heads/print.js";
import type { RpcInteractions } from "../heads/rpc.js";
import { PluginInteractionsRpcLive, RpcInteractionsLive, runRpcHead } from "../heads/rpc.js";
import { makeCliRuntime } from "../plugins/runtime.js";

import { CliArgsError, type ParsedRunArgs, parseArgs, withStdinPrompt } from "./args.js";
import {
  type CliConfig,
  CliConfigError,
  type CliEnvironment,
  type CliRunConfig,
  resolveConfig,
} from "./config.js";

// ---------------------------------------------------------------------------
// Errors and I/O
// ---------------------------------------------------------------------------

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

export class CliRunError extends Data.TaggedError("CliRunError")<{
  readonly cause?: unknown;
  readonly message: string;
  readonly reason: "composition_failed" | "fake_provider_invalid" | "missing_prompt";
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

const runError = (reason: CliRunError["reason"], message: string, cause?: unknown): CliRunError =>
  new CliRunError({
    ...(cause === undefined ? {} : { cause }),
    message,
    reason,
  });

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const CLI_USAGE = `Usage:
  popeye -p "<prompt>"
  popeye -p --mode json "<prompt>"
  popeye -p --mode rpc
  popeye "<prompt>"
  echo "<prompt>" | popeye -p

Options:
  --base-url <url>         Set the OpenAI-compatible endpoint. Env: POPEYE_BASE_URL.
  -p, --headless           Run headless.
  --help                   Print this usage text.
  --mode <print|json|rpc>  Select the Head. Default: print.
  --model <model>          Select the Provider model. Env: POPEYE_MODEL.
  --no-project-plugins     Do not load project-local Plugins.
  --plugin <path>          Add a Plugin path. Repeatable.
  --resume <sessionId>     Resume a Session.
  --session-dir <dir>      Set the Journal directory. Default: .popeye/sessions.
  --version                Print the @popeye/cli version.

Loopback endpoints need no API key; the CLI supplies its local placeholder automatically.
Hosted endpoints require POPEYE_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.

Exit status:
  0  Turn completed or truncated.
  1  Provider-settled error.
  2  Invalid arguments, missing configuration, or an aborted turn.
  3  Unresolved tool calls.
  4  Turn failure or Head boundary failure.

Read stderr to distinguish exit 2 causes.
`;

// ---------------------------------------------------------------------------
// Journal layer selection per D-006 — now delegated to JournalStore deep module (C4 architecture review) <!-- D-006 -->
// ---------------------------------------------------------------------------

export const selectJournalLayer = (sessionDir: string, env: CliEnvironment) => {
  const explicit = env.POPEYE_JOURNAL_LAYER;
  if (
    explicit !== undefined &&
    explicit.length > 0 &&
    explicit !== "sqlite" &&
    explicit !== "jsonl"
  ) {
    Effect.runSync(
      Effect.logWarning(`POPEYE_JOURNAL_LAYER=${explicit} unknown, using file-detection`),
    );
  }
  return JournalStore.selectLayer(sessionDir, env as JournalStoreEnv);
};

// ---------------------------------------------------------------------------
// Internal seams: args/config remain independent; helpers below are
// private to this deep module, not part of its public interface.
// ---------------------------------------------------------------------------

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
          "Could not read @popeye/cli package metadata.",
          cause,
        ),
      try: () => readFile(new URL("../../package.json", import.meta.url), "utf8"),
    });
    const metadata = yield* Effect.try({
      catch: (cause) =>
        entryError(
          "package_metadata_invalid",
          "@popeye/cli package metadata is not valid JSON.",
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
        "@popeye/cli package metadata has no version.",
      );
    }
    return metadata.version;
  });

// ---------------------------------------------------------------------------
// Provider / startup helpers (previously in run.ts)
// ---------------------------------------------------------------------------

const AssistantItemSchema = Schema.Union(
  Schema.TaggedStruct("done", {
    stopReason: AssistantStopReasonSchema,
  }),
  Schema.TaggedStruct("textDelta", { text: Schema.String }),
  Schema.TaggedStruct("thinkingDelta", { text: Schema.String }),
  Schema.TaggedStruct("toolCall", {
    argumentsJson: Schema.String,
    id: Schema.String,
    name: Schema.String,
  }),
  Schema.TaggedStruct("toolCallDelta", {
    argumentsJsonDelta: Schema.String,
    id: Schema.String,
    index: Schema.optionalWith(Schema.Number, { exact: true }),
    name: Schema.UndefinedOr(Schema.String),
  }),
);

const FakeProviderScriptSchema = Schema.Struct({
  responses: Schema.Array(
    Schema.Struct({
      items: Schema.Array(AssistantItemSchema),
      prompt: Schema.optional(Schema.String),
    }),
  ),
});

type FakeProviderScript = Schema.Schema.Type<typeof FakeProviderScriptSchema>;

const loadFakeProvider = (file: string): Effect.Effect<ProviderService, CliRunError> =>
  Effect.gen(function* () {
    const source = yield* Effect.tryPromise({
      catch: (cause) =>
        runError("fake_provider_invalid", `Could not read fake Provider script ${file}.`, cause),
      try: () => readFile(file, "utf8"),
    });
    const input = yield* Effect.try({
      catch: (cause) =>
        runError("fake_provider_invalid", `Fake Provider script ${file} is not valid JSON.`, cause),
      try: () => JSON.parse(source) as unknown,
    });
    const script: FakeProviderScript = yield* Schema.decodeUnknown(FakeProviderScriptSchema, {
      onExcessProperty: "error",
    })(input).pipe(
      Effect.mapError((cause) =>
        runError(
          "fake_provider_invalid",
          `Fake Provider script ${file} has an invalid response shape.`,
          cause,
        ),
      ),
    );
    if (script.responses.length === 0) {
      return yield* runError(
        "fake_provider_invalid",
        `Fake Provider script ${file} must contain at least one response.`,
      );
    }

    let responseIndex = 0;
    return {
      streamAssistant: (context): Stream.Stream<AssistantItem, ProviderError> => {
        const response = script.responses[responseIndex];
        responseIndex += 1;
        if (response === undefined) {
          return Stream.fail(
            new ProviderError({
              message: "Fake Provider script has no remaining response.",
              transient: false,
            }),
          );
        }
        const prompt = context.findLast((item) => item.role === "user")?.content;
        if (response.prompt !== undefined && response.prompt !== prompt) {
          return Stream.fail(
            new ProviderError({
              message: "Fake Provider prompt did not match the scripted response.",
              transient: false,
            }),
          );
        }
        return Stream.fromIterable(response.items);
      },
    } satisfies ProviderService;
  });

const startupLine = (config: CliRunConfig, toolCount: number): string =>
  `STARTUP ${JSON.stringify({
    baseUrlHost: config.baseUrlHost,
    mode: config.mode,
    model: config.model,
    sessionAction:
      config.resume === undefined
        ? config.mode === "rpc"
          ? "rpc-managed"
          : "create"
        : `resume:${config.resume}`,
    toolCount,
  })}\n`;

// ---------------------------------------------------------------------------
// Heavy path: Driver composition + Head dispatch (previously run.ts dispatch)
// ---------------------------------------------------------------------------

const runWithConfig = (
  config: CliRunConfig,
  io: CliIo,
  errorWriter: HeadWriter,
  writer: HeadWriter,
  env: CliEnvironment,
): Effect.Effect<HeadExitCode, CliRunError> =>
  Effect.gen(function* () {
    const resumeSessionId =
      config.resume === undefined ? undefined : SessionIdSchema.make(config.resume);
    const provider =
      config.fakeProviderScript === undefined
        ? undefined
        : yield* loadFakeProvider(config.fakeProviderScript);
    const cliRuntime = yield* makeCliRuntime({
      noProjectPlugins: config.noProjectPlugins,
      pluginPaths: config.pluginPaths,
      projectPath: process.cwd(),
      userPluginDir: config.userPluginDir,
    }).pipe(
      Effect.provide(PluginInteractionsNullLive),
      Effect.mapError((cause) =>
        runError(
          "composition_failed",
          `Could not compose Plugins (composition_failed): ${errorMessage(cause)}`,
          cause,
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const snapshotAudit = yield* cliRuntime.snapshotAudit.pipe(
        Effect.mapError((cause) =>
          runError(
            "composition_failed",
            `Could not compose snapshot audit (composition_failed): ${errorMessage(cause)}`,
            cause,
          ),
        ),
      );
      const tools = Layer.succeed(ToolRegistry, cliRuntime.toolRegistry);
      const startupToolCount = yield* cliRuntime.toolRegistry
        .view(SessionIdSchema.make("startup-toolcount"))
        .pipe(Effect.map((view) => view.list().length));
      yield* errorWriter
        .write(startupLine(config, startupToolCount))
        .pipe(
          Effect.mapError((cause) =>
            runError("composition_failed", `Could not write CLI stderr: ${cause.message}`, cause),
          ),
        );
      const providerLayer =
        provider === undefined
          ? PiAiProviderLive({
              ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
              baseUrl: config.baseUrl,
              modelId: config.model,
              provider: "openai",
            }).pipe(Layer.provide(tools))
          : Layer.succeed(Provider, provider);
      const dependencies = Layer.mergeAll(
        selectJournalLayer(config.sessionDir, env),
        providerLayer,
        tools,
      );
      const currentGen = yield* cliRuntime.currentGeneration;
      const driver = GenerationDriverDefault(currentGen).pipe(Layer.provide(dependencies));
      const pluginLive =
        config.mode === "rpc"
          ? PluginInteractionsRpcLive.pipe(Layer.provide(RpcInteractionsLive))
          : PluginInteractionsNullLive;
      const runtime = Layer.mergeAll(driver, RpcInteractionsLive, pluginLive);
      let head: Effect.Effect<
        HeadExitCode,
        CliRunError | HeadWriteError,
        Driver | RpcInteractions | PluginInteractions
      >;
      if (config.mode === "rpc") {
        head = runRpcHead({
          errorWriter,
          input: io.input,
          loggerOutput: io.stderr,
          ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
          snapshotAudit,
          writer,
        });
      } else if (config.prompt === undefined) {
        head = Effect.fail(
          runError("missing_prompt", "A prompt argument or piped stdin is required."),
        );
      } else if (config.mode === "json") {
        head = runJsonHead({
          prompts: [config.prompt],
          ...(resumeSessionId === undefined ? {} : { sessionId: resumeSessionId }),
          snapshotAudit,
          writer,
        });
      } else {
        head = runPrintHead({
          errorWriter,
          prompts: [config.prompt],
          ...(resumeSessionId === undefined ? {} : { sessionId: resumeSessionId }),
          writer,
        });
      }

      return yield* head.pipe(
        Effect.provide(runtime),
        Effect.mapError((cause) =>
          cause instanceof CliRunError
            ? cause
            : runError(
                "composition_failed",
                `Could not run the ${config.mode} Head: ${errorMessage(cause)}`,
                cause,
              ),
        ),
      );
    }).pipe(Effect.ensuring(cliRuntime.close));
  });

/**
 * Deep interface: owns argv/env/io to exit code.
 * Not responsible for Head rendering or Plugin discovery — those
 * live behind compose and heads.
 */
export const run = (
  config: CliRunConfig,
  io: CliIo,
  env: CliEnvironment = {},
): Effect.Effect<HeadExitCode, CliRunError> => {
  const writer = makeWritableHeadWriter(io.stdout);
  const errorWriter = makeWritableHeadWriter(io.stderr);
  return runWithConfig(config, io, errorWriter, writer, env).pipe(
    Effect.provide(Logger.replace(Logger.defaultLogger, makeWritableLogfmtLogger(io.stderr))),
  );
};

// ---------------------------------------------------------------------------
// Light path: help/version vs heavy path dispatch
// ---------------------------------------------------------------------------

const dispatch = (
  config: CliConfig,
  io: CliIo,
  writer: HeadWriter,
  env: CliEnvironment,
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
  return run(config, io, env);
};

const isCliRunError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === "CliRunError";

const cliFailureExitCode = (error: unknown): number =>
  error instanceof CliArgsError || error instanceof CliConfigError || isCliRunError(error) ? 2 : 4;

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
    return yield* dispatch(config, io, stdoutWriter, env);
  }).pipe(Effect.catchAll((error) => reportCliFailure(error, errorWriter)));

  const exit = await Effect.runPromiseExit(program);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const [first] = Cause.prettyErrors(exit.cause);
  io.stderr.write(`ERROR CliBoundaryError: ${first?.message ?? Cause.pretty(exit.cause)}\n`);
  return HEAD_EXIT_CODES.turnFailure;
};
