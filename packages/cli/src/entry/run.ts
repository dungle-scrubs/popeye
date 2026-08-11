/**
 * Owns executable I/O, Provider selection, Driver composition, and Head dispatch.
 * It exists so the bin has one Effect boundary and stdout remains owned by the selected Head.
 */
import { readFile } from "node:fs/promises";

import { JournalJsonl, SessionIdSchema } from "@pop-eye/journal";
import { Data, Effect, Layer, Logger, Schema, Stream } from "effect";

import type { AssistantItem, Driver, ProviderService } from "../compose.js";
import {
  AssistantStopReasonSchema,
  GenerationDriverDefault,
  PiAiProviderLive,
  Provider,
  ProviderError,
  ToolRegistryLive,
} from "../compose.js";
import { runJsonHead } from "../heads/json.js";
import { runPrintHead } from "../heads/print.js";
import type { RpcInteractions } from "../heads/rpc.js";
import { RpcInteractionsLive, runRpcHead } from "../heads/rpc.js";
import type { HeadExitCode, HeadWriteError, HeadWriter } from "../heads/shared.js";
import { errorMessage, makeWritableHeadWriter, makeWritableLogfmtLogger } from "../heads/shared.js";
import { composePluginRuntime } from "../plugins/pipeline.js";
import type { CliRunConfig } from "./config.js";
import type { CliIo } from "./execute.js";

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

export class CliRunError extends Data.TaggedError("CliRunError")<{
  readonly cause?: unknown;
  readonly message: string;
  readonly reason: "composition_failed" | "fake_provider_invalid" | "missing_prompt";
}> {}

const runError = (reason: CliRunError["reason"], message: string, cause?: unknown): CliRunError =>
  new CliRunError({
    ...(cause === undefined ? {} : { cause }),
    message,
    reason,
  });

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

const startupLine = (config: CliRunConfig): string =>
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
  })}\n`;

const dispatch = (
  config: CliRunConfig,
  io: CliIo,
  errorWriter: HeadWriter,
  writer: HeadWriter,
): Effect.Effect<HeadExitCode, CliRunError> =>
  Effect.gen(function* () {
    const resumeSessionId =
      config.resume === undefined ? undefined : SessionIdSchema.make(config.resume);
    const provider =
      config.fakeProviderScript === undefined
        ? undefined
        : yield* loadFakeProvider(config.fakeProviderScript);
    const pluginGeneration = yield* composePluginRuntime({
      noProjectPlugins: config.noProjectPlugins,
      pluginPaths: config.pluginPaths,
      projectPath: process.cwd(),
      userPluginDir: config.userPluginDir,
    }).pipe(
      Effect.mapError((cause) =>
        runError(
          "composition_failed",
          `Could not compose Plugins (composition_failed): ${errorMessage(cause)}`,
          cause,
        ),
      ),
    );
    const tools = ToolRegistryLive([]);
    const providerLayer =
      provider === undefined
        ? PiAiProviderLive({
            ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
            baseUrl: config.baseUrl,
            modelId: config.model,
            provider: "openai",
          }).pipe(Layer.provide(tools))
        : Layer.succeed(Provider, provider);
    const dependencies = Layer.mergeAll(JournalJsonl(config.sessionDir), providerLayer, tools);
    const driver = GenerationDriverDefault(pluginGeneration).pipe(Layer.provide(dependencies));
    const runtime = Layer.merge(driver, RpcInteractionsLive);
    let head: Effect.Effect<HeadExitCode, CliRunError | HeadWriteError, Driver | RpcInteractions>;
    if (config.mode === "rpc") {
      head = runRpcHead({
        errorWriter,
        input: io.input,
        loggerOutput: io.stderr,
        ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
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
      Effect.ensuring(pluginGeneration.close),
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
  });

export const run = (config: CliRunConfig, io: CliIo): Effect.Effect<HeadExitCode, CliRunError> => {
  const writer = makeWritableHeadWriter(io.stdout);
  const errorWriter = makeWritableHeadWriter(io.stderr);
  return errorWriter.write(startupLine(config)).pipe(
    Effect.zipRight(dispatch(config, io, errorWriter, writer)),
    Effect.provide(Logger.replace(Logger.defaultLogger, makeWritableLogfmtLogger(io.stderr))),
    Effect.mapError((cause) =>
      cause instanceof CliRunError
        ? cause
        : runError("composition_failed", `Could not write CLI stderr: ${cause.message}`, cause),
    ),
  );
};
