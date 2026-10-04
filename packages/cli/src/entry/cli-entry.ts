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
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";

import { JournalStore, type JournalStoreEnv, SessionIdSchema } from "@dungle-scrubs/popeye-journal";
import { accountingRows } from "@dungle-scrubs/popeye-kernel";
import { type PluginInteractions, PluginInteractionsNullLive } from "@dungle-scrubs/popeye-plugins";
import { Cause, Data, Effect, Exit, Layer, Logger, Schema, Stream } from "effect";

import { discoverAgents } from "../agents/loader.js";
import type { AssistantItem, Driver, ProviderService } from "../compose.js";
import {
  AssistantStopReasonSchema,
  GenerationDriverDefault,
  generationLifecycleTap,
  makeSessionLifecycle,
  PiAiProviderLive,
  Provider,
  ProviderError,
  reflectionProducerFromEnv,
  SessionLifecycle,
  type SessionLifecycleService,
  ToolRegistry,
} from "../compose.js";
import { runHcnHead } from "../heads/hcn.js";
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
import { composeToolGrantFilter, partitionAgentTools } from "../tools/grants.js";
import { SessionToolGrants, type SessionToolGrantsService } from "../tools/session-grants.js";

import {
  CliArgsError,
  type CliMode,
  HCN_EFFORT_TO_THINKING_LEVEL,
  type ParsedRunArgs,
  parseArgs,
  withStdinPrompt,
} from "./args.js";
import {
  type CliConfig,
  CliConfigError,
  type CliEnvironment,
  type CliRunConfig,
  PROVIDER_API_KEYS,
  resolveConfig,
  resolveUserAgentsDir,
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
  readonly reason:
    | "agent_tools_unknown"
    | "composition_failed"
    | "fake_provider_invalid"
    | "missing_prompt";
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

const PROVIDER_KEY_LINES = PROVIDER_API_KEYS.map(
  (entry) => `  ${entry.origin.padEnd(27)}${entry.variable}`,
).join("\n");

const CLI_USAGE = `Usage:
  popeye -p "<prompt>"
  popeye -p --mode json "<prompt>"
  popeye -p --mode rpc
  popeye "<prompt>"
  echo "<prompt>" | popeye -p
  popeye usage export [--session-dir <dir>] [--session <id>]

Options:
  --agent <name>           Start as a named Agent definition (RFC-04). Dirs: ./.popeye/agents,
                           ~/.popeye/agents; POPEYE_AGENTS_DIR overrides the user dir.
  --base-url <url>         Set the OpenAI-compatible endpoint. Env: POPEYE_BASE_URL.
  --effort <level>         Set reasoning: off, low, medium-low, medium, medium-high, high, xhigh.
  --exclude-tools <names>  Exclude contributed Tools by comma-separated name;
                           native:<name> is accepted.
  -p, --headless           Run headless.
  --help                   Print this usage text.
  --isolation tool-free    Load first-party Plugins only and expose no Tools.
  --mode <print|json|rpc|hcn>  Select the Head. Default: print.
  --model <model>          Select the Provider model. Env: POPEYE_MODEL.
  --no-project-plugins     Do not load project-local Plugins.
  --plugin <path>          Add a Plugin path. Repeatable.
  --resume <sessionId>     Resume a Session.
  --session-dir <dir>      Set the Journal directory. Default: .popeye/sessions.
  --skills <names>         Allow only comma-separated Plugin names; this is not a trust setting.
  --tools <names>          Allow only contributed Tools by comma-separated name;
                           native:<name> is accepted.
  --version                Print the @dungle-scrubs/popeye version.

Loopback endpoints need no API key; without POPEYE_API_KEY the CLI sends its local placeholder.
POPEYE_API_KEY is the endpoint credential and overrides every other key.
Without it, a provider key is read only for its own API host:
${PROVIDER_KEY_LINES}
Any other hosted endpoint requires POPEYE_API_KEY.

Models pi-ai does not know, reached through --base-url, send reasoning_effort:
off=none, low=minimal, medium-low=low, medium=medium, medium-high=high, high=xhigh, xhigh=xhigh.
With no explicit Turn level, saved Session level, or Provider layer default, those models
send no field. Reasoning levels are endpoint hints, not timing guarantees.
RPC: use set-thinking with Kernel levels; off sends reasoning_effort none to those models.

An explicit level for a registry model without reasoning support ends the Turn with a
Provider error (exit 1 in print, JSON, and HCN). Registry reasoning models use pi-ai's
model-specific mapping; off is not guaranteed to disable reasoning for those models.

Environment:
  POPEYE_REFLECT_INTAKE    Absolute path of the reflect-intake executable. When set, each
                           Session create, resume, and close is reported to
                           "<path> hook popeye <event>" (docs/adr/0002). Unset, empty,
                           relative, or not an executable file: nothing is reported.

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
          "Could not read @dungle-scrubs/popeye package metadata.",
          cause,
        ),
      try: () => readFile(new URL("../../package.json", import.meta.url), "utf8"),
    });
    const metadata = yield* Effect.try({
      catch: (cause) =>
        entryError(
          "package_metadata_invalid",
          "@dungle-scrubs/popeye package metadata is not valid JSON.",
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
        "@dungle-scrubs/popeye package metadata has no version.",
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
    ...(config.agent === undefined ? {} : { agent: config.agent.name }),
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

export const composeAppendedSystemPrompt = (config: {
  readonly agent: CliRunConfig["agent"];
  readonly appendSystemPrompt: string | undefined;
}): string =>
  [config.agent === undefined ? undefined : config.agent.body, config.appendSystemPrompt]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n\n");

/**
 * The services every Head runs with: the Driver, the rpc interaction channels,
 * the Plugin interaction channel for the mode, the session lifecycle report,
 * and the process's per-Session Tool grant store (RFC-04 §5).
 */
export const composeHeadRuntime = <E, R>(options: {
  readonly driver: Layer.Layer<Driver, E, R>;
  readonly lifecycle: SessionLifecycleService;
  readonly mode: CliMode;
  readonly sessionToolGrants: SessionToolGrantsService;
}) =>
  Layer.mergeAll(
    options.driver,
    RpcInteractionsLive,
    options.mode === "rpc"
      ? PluginInteractionsRpcLive.pipe(Layer.provide(RpcInteractionsLive))
      : PluginInteractionsNullLive,
    Layer.succeed(SessionLifecycle, options.lifecycle),
    Layer.succeed(SessionToolGrants, options.sessionToolGrants),
  );

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
    const toolGrants = composeToolGrantFilter({
      access: config.access,
      agentTools: config.agent?.tools,
      excludeTools: config.excludeTools,
      isolation: config.isolation,
      tools: config.tools,
    });
    const cliRuntime = yield* makeCliRuntime({
      ...(config.isolation === undefined ? {} : { isolation: config.isolation }),
      noProjectPlugins: config.noProjectPlugins,
      pluginPaths: config.pluginPaths,
      projectPath: process.cwd(),
      ...(config.skills.length === 0 ? {} : { skills: config.skills }),
      ...(toolGrants === undefined ? {} : { toolGrants }),
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
      const journalLayer = selectJournalLayer(config.sessionDir, env);
      const startupView = yield* cliRuntime.toolRegistry.view(
        SessionIdSchema.make("startup-toolcount"),
      );
      const startupToolCount = startupView.list().length;
      // RFC-04 §1/§3: the Agent tools list already narrows the startup view
      // (composeToolGrantFilter). A name is outside the grant when no Tool has
      // that name or a flag removed it. An entirely ungranted list fails closed;
      // partial lists warn and run with the granted subset.
      if (config.agent?.tools !== undefined && config.agent.tools.length > 0) {
        const { known, unknown } = partitionAgentTools(
          config.agent.tools,
          new Set(startupView.list().map((tool) => tool.name)),
        );
        if (known.length === 0) {
          return yield* runError(
            "agent_tools_unknown",
            `Agent ${config.agent.name} (${config.agent.filePath}) lists only tools this session does not grant: ${unknown.join(", ")}. Startup fails closed.`,
          );
        }
        if (unknown.length > 0) {
          yield* errorWriter
            .write(
              `Agent ${config.agent.name} (${config.agent.filePath}) names tools this session does not grant: ${unknown.join(", ")}. The session runs with the granted subset: ${known.join(", ")}.\n`,
            )
            .pipe(
              Effect.mapError((cause) =>
                runError(
                  "composition_failed",
                  `Could not write CLI stderr: ${cause.message}`,
                  cause,
                ),
              ),
            );
        }
      }
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
              accountingProvider: "openai-compatible",
              accountingProviderClass: config.accountingProviderClass,
              apiKey: config.apiKey,
              baseUrl: config.baseUrl,
              // RFC-02 P4 item 6: trusted window override replaces the
              // fabricated 128k default for HCN runs.
              ...(config.contextWindow === undefined
                ? {}
                : { contextWindow: config.contextWindow }),
              modelId: config.model,
              provider: "openai",
              recordUsage: true,
            }).pipe(Layer.provide(Layer.merge(tools, journalLayer)))
          : Layer.succeed(Provider, provider);
      const dependencies = Layer.mergeAll(journalLayer, providerLayer, tools);
      const currentGen = yield* cliRuntime.currentGeneration;
      // ADR-0002: one lifecycle report per process. The Tap broadcast is diagnostic; the
      // reflection send exists only when POPEYE_REFLECT_INTAKE names an executable file.
      const reflection = reflectionProducerFromEnv(
        env,
        join(resolve(config.sessionDir), "reflection"),
      );
      const lifecycle = makeSessionLifecycle({
        ...(reflection === undefined ? {} : { producer: reflection }),
        tap: generationLifecycleTap(currentGen),
      });
      const driver = GenerationDriverDefault(currentGen, { lifecycle }).pipe(
        Layer.provide(dependencies),
      );
      const runtime = composeHeadRuntime({
        driver,
        lifecycle,
        mode: config.mode,
        sessionToolGrants: cliRuntime.sessionToolGrants,
      });
      let head: Effect.Effect<
        HeadExitCode,
        CliRunError | HeadWriteError,
        Driver | RpcInteractions | PluginInteractions
      >;
      // RFC-02 P4: effort onto thinkingLevel; system-prompt flags onto
      // fragment composition. Context-window rides the provider layer.
      // RFC-04 §2: the Agent body rides the same append machinery, flag
      // content appending after it; an empty body appends nothing.
      const appendedSystemPrompt = composeAppendedSystemPrompt(config);
      const turnOptions =
        config.effort === undefined &&
        config.systemPrompt === undefined &&
        appendedSystemPrompt === ""
          ? undefined
          : {
              ...(appendedSystemPrompt === "" ? {} : { appendSystemPrompt: appendedSystemPrompt }),
              ...(config.systemPrompt === undefined ? {} : { systemPrompt: config.systemPrompt }),
              ...(config.effort === undefined
                ? {}
                : { thinkingLevel: HCN_EFFORT_TO_THINKING_LEVEL[config.effort] }),
            };
      if (config.mode === "rpc" && (turnOptions !== undefined || config.agent !== undefined)) {
        return yield* Effect.fail(
          runError(
            "composition_failed",
            "--effort, --system-prompt, --append-system-prompt, and --agent have no RPC wire carrier: prompt frames carry content only (set-model and set-thinking cover model and thinking level). Omit them in RPC mode.",
          ),
        );
      }
      if (config.mode === "rpc") {
        head = runRpcHead({
          errorWriter,
          input: io.input,
          loggerOutput: io.stderr,
          ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
          snapshotAudit,
          writer,
        });
      } else if (config.prompt === undefined && resumeSessionId === undefined) {
        head = Effect.fail(
          runError("missing_prompt", "A prompt argument or piped stdin is required."),
        );
      } else if (config.mode === "hcn") {
        head = runHcnHead({
          prompts: config.prompt === undefined ? [] : [config.prompt],
          ...(resumeSessionId === undefined ? {} : { sessionId: resumeSessionId }),
          snapshotAudit,
          ...(turnOptions === undefined ? {} : { turnOptions }),
          writer,
        });
      } else if (config.mode === "json") {
        head = runJsonHead({
          prompts: config.prompt === undefined ? [] : [config.prompt],
          ...(resumeSessionId === undefined ? {} : { sessionId: resumeSessionId }),
          snapshotAudit,
          ...(turnOptions === undefined ? {} : { turnOptions }),
          writer,
        });
      } else {
        head = runPrintHead({
          errorWriter,
          prompts: config.prompt === undefined ? [] : [config.prompt],
          ...(resumeSessionId === undefined ? {} : { sessionId: resumeSessionId }),
          ...(turnOptions === undefined ? {} : { turnOptions }),
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
  if (argv[0] === "usage") {
    if (argv[1] !== "export") {
      io.stderr.write("ERROR ACCOUNTING_ARGUMENTS\n");
      return 2;
    }
    let directory = ".popeye/sessions";
    let session: string | undefined;
    for (let index = 2; index < argv.length; index += 2) {
      const flag = argv[index];
      const value = argv[index + 1];
      if (
        value === undefined ||
        value.length === 0 ||
        (flag !== "--session-dir" && flag !== "--session")
      ) {
        io.stderr.write("ERROR ACCOUNTING_ARGUMENTS\n");
        return 2;
      }
      if (flag === "--session-dir") directory = value;
      else session = value;
    }
    try {
      const sessions = await JournalStore.readAccountingRecords(directory, session);
      if (session !== undefined && sessions.length !== 1)
        throw new Error("ACCOUNTING_SESSION_NOT_FOUND");
      const rows = sessions.flatMap(({ sessionId, records }) => accountingRows(sessionId, records));
      io.stdout.write(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
      return 0;
    } catch (cause) {
      const code =
        cause instanceof Error && cause.message.startsWith("ACCOUNTING_")
          ? cause.message
          : "ACCOUNTING_READ_FAILED";
      io.stderr.write(`ERROR ${code}\n`);
      return 4;
    }
  }
  const stdoutWriter = makeWritableHeadWriter(io.stdout);
  const errorWriter = makeWritableHeadWriter(io.stderr);
  const program = Effect.gen(function* () {
    const initial = yield* parseArgs(argv);
    const parsed = initial.action === "run" ? yield* completePrompt(initial, io.input) : initial;
    // RFC-04 slice 1: discovery runs lazily, only when --agent names a persona.
    // Diagnostics land on stderr immediately, before any fallible config step,
    // so a load failure never hides why a file was skipped.
    const agentDiscovery =
      parsed.action === "run" && parsed.agent !== undefined
        ? yield* discoverAgents({
            projectPath: process.cwd(),
            userDir: resolveUserAgentsDir(env),
          }).pipe(
            Effect.mapError(
              (cause) =>
                new CliConfigError({
                  ...(cause.cause === undefined ? {} : { cause: cause.cause }),
                  message: cause.message,
                  reason: cause.reason,
                }),
            ),
          )
        : undefined;
    if (agentDiscovery !== undefined) {
      for (const diagnostic of agentDiscovery.diagnostics) {
        yield* errorWriter
          .write(`Agent definition ${diagnostic.filePath} skipped: ${diagnostic.detail}.\n`)
          .pipe(
            Effect.mapError((cause) =>
              entryError("input_failed", `Could not write CLI stderr: ${cause.message}`, cause),
            ),
          );
      }
    }
    const config = yield* resolveConfig(parsed, env, agentDiscovery);
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
