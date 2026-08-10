/**
 * Owns the sole pi-ai import seam selected by D-001.
 * Pi-ai's own names are exempt only inside this directory. No pi-ai type crosses the seam because
 * every request, stream item, and failure maps to the kernel's stable Provider interface.
 */

import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  clampThinkingLevel,
  isRetryableAssistantError,
  type Model,
  type Context as PiAiContext,
  type Tool as PiAiTool,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { Effect, JSONSchema, Layer, Option, Stream } from "effect";

import { ProviderError } from "../errors.js";
import type { AssistantItem, ContextItem, ProviderStreamOptions } from "../provider.js";
import { Provider } from "../provider.js";
import type { RegisteredTool } from "../tool.js";
import { ToolRegistry } from "../tool.js";

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const modelRegistry = builtinModels();

interface PiAiRuntime {
  readonly classifyError: (message: AssistantMessage) => boolean;
  readonly streamSimple: (
    model: Model<Api>,
    context: PiAiContext,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream;
}

export interface PiAiProviderLayerOptions {
  readonly baseUrl?: string;
  readonly idleTimeoutMs?: number;
  readonly modelId: string;
  readonly provider: string;
  readonly thinkingLevel?: "high" | "low" | "max" | "medium" | "minimal" | "xhigh";
}

const defaultRuntime: PiAiRuntime = {
  classifyError: isRetryableAssistantError,
  streamSimple,
};

const emptyUsage = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input: 0,
  output: 0,
  totalTokens: 0,
} as const;

const parseArguments = (argumentsJson: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(argumentsJson);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Tool-call arguments must decode to a JSON object.");
  }
  return value as Record<string, unknown>;
};

const toPiAiContext = (
  items: ReadonlyArray<ContextItem>,
  model: Model<Api>,
  tools: ReadonlyArray<RegisteredTool>,
): PiAiContext => {
  const toolNames = new Map<string, string>();
  const systemPrompts: Array<string> = [];
  const messages: PiAiContext["messages"] = [];

  for (const item of items) {
    if (item.role === "system") {
      systemPrompts.push(item.content);
      continue;
    }
    if (item.role === "assistant") {
      const toolCalls = (item.toolCalls ?? []).map((call) => {
        toolNames.set(call.id, call.name);
        return {
          arguments: parseArguments(call.argumentsJson),
          id: call.id,
          name: call.name,
          type: "toolCall" as const,
        };
      });
      messages.push({
        api: model.api,
        content: [
          ...(item.content.length === 0 ? [] : [{ text: item.content, type: "text" as const }]),
          ...toolCalls,
        ],
        model: model.id,
        provider: model.provider,
        role: "assistant",
        stopReason: toolCalls.length === 0 ? "stop" : "toolUse",
        timestamp: 0,
        usage: emptyUsage,
      });
      continue;
    }
    if (item.role === "toolResult" && item.toolCallId !== undefined) {
      messages.push({
        content: [{ text: item.content, type: "text" }],
        isError: item.isError === true,
        role: "toolResult",
        timestamp: 0,
        toolCallId: item.toolCallId,
        toolName: toolNames.get(item.toolCallId) ?? "unknown",
      });
      continue;
    }
    messages.push({ content: item.content, role: "user", timestamp: 0 });
  }

  const declarations: Array<PiAiTool> = tools.map((tool) => ({
    description: tool.description,
    name: tool.name,
    parameters: JSONSchema.make(tool.parameters) as PiAiTool["parameters"],
  }));

  return {
    messages,
    ...(systemPrompts.length === 0 ? {} : { systemPrompt: systemPrompts.join("\n\n") }),
    ...(declarations.length === 0 ? {} : { tools: declarations }),
  };
};

const stopReason = (reason: "deferred" | "length" | "stop" | "toolUse") =>
  reason === "toolUse" ? ("toolCalls" as const) : ("done" as const);

const toolCallAt = (event: Extract<AssistantMessageEvent, { readonly type: "toolcall_delta" }>) => {
  const content = event.partial.content[event.contentIndex];
  return content?.type === "toolCall" ? content : undefined;
};

const mapStreamItem = (
  event: AssistantMessageEvent,
  runtime: PiAiRuntime,
): Effect.Effect<Option.Option<AssistantItem>, ProviderError> => {
  switch (event.type) {
    case "text_delta":
      return Effect.succeed(Option.some({ _tag: "textDelta", text: event.delta }));
    case "thinking_delta":
      return Effect.succeed(Option.some({ _tag: "thinkingDelta", text: event.delta }));
    case "toolcall_delta": {
      const toolCall = toolCallAt(event);
      return toolCall === undefined
        ? Effect.fail(
            new ProviderError({
              message: `pi-ai tool-call delta ${event.contentIndex} omitted its partial tool call.`,
              transient: false,
            }),
          )
        : Effect.succeed(
            Option.some({
              _tag: "toolCallDelta",
              argumentsJsonDelta: event.delta,
              id: toolCall.id,
              index: event.contentIndex,
              name: toolCall.name,
            }),
          );
    }
    case "toolcall_end":
      return Effect.succeed(
        Option.some({
          _tag: "toolCall",
          argumentsJson: JSON.stringify(event.toolCall.arguments),
          id: event.toolCall.id,
          name: event.toolCall.name,
        }),
      );
    case "done":
      return event.message.stopReason !== event.reason
        ? Effect.fail(
            new ProviderError({
              message: `pi-ai terminal mismatch: event=${event.reason}, message=${event.message.stopReason}.`,
              transient: false,
            }),
          )
        : Effect.succeed(Option.some({ _tag: "done", stopReason: stopReason(event.reason) }));
    case "error": {
      if (event.reason === "aborted") {
        return Effect.succeed(Option.some({ _tag: "done", stopReason: "aborted" }));
      }
      const transient = runtime.classifyError(event.error);
      return Effect.annotateCurrentSpan({ classifierVerdict: transient }).pipe(
        Effect.zipRight(
          Effect.fail(
            new ProviderError({
              message: event.error.errorMessage ?? "pi-ai provider request failed.",
              transient,
            }),
          ),
        ),
      );
    }
    default:
      return Effect.succeed(Option.none());
  }
};

const fromPiAiStream = (
  source: AssistantMessageEventStream,
  controller: AbortController,
): Stream.Stream<AssistantMessageEvent, ProviderError> => {
  const iterator = source[Symbol.asyncIterator]();
  const next = Effect.tryPromise({
    catch: (cause) =>
      new ProviderError({
        message: cause instanceof Error ? cause.message : "pi-ai stream iteration failed.",
        transient: true,
      }),
    try: () => iterator.next(),
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.sync(() => controller.abort()).pipe(
        Effect.zipRight(Effect.annotateCurrentSpan({ abortBridgeFired: true })),
      ),
    ),
    Effect.mapError((error) => Option.some(error)),
    Effect.flatMap((result) =>
      result.done ? Effect.fail(Option.none()) : Effect.succeed(result.value),
    ),
  );
  return Stream.repeatEffectOption(next);
};

export const makePiAiProviderLayer = (
  model: Model<Api>,
  runtime: PiAiRuntime,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  thinkingLevel?: PiAiProviderLayerOptions["thinkingLevel"],
  apiKey?: string,
): Layer.Layer<Provider, never, ToolRegistry> =>
  Layer.effect(
    Provider,
    Effect.gen(function* () {
      const toolRegistry = yield* ToolRegistry;
      return {
        streamAssistant: (context: ReadonlyArray<ContextItem>, options: ProviderStreamOptions) =>
          Stream.unwrapScoped(
            Effect.gen(function* () {
              const controller = new AbortController();
              const piAiContext = yield* Effect.try({
                catch: (cause) =>
                  new ProviderError({
                    message:
                      cause instanceof Error
                        ? cause.message
                        : "Provider context conversion failed.",
                    transient: false,
                  }),
                try: () => toPiAiContext(context, model, toolRegistry.list()),
              });
              const source = yield* Effect.try({
                catch: (cause) =>
                  new ProviderError({
                    message:
                      cause instanceof Error ? cause.message : "pi-ai stream creation failed.",
                    transient: true,
                  }),
                try: () => {
                  const reasoning =
                    thinkingLevel === undefined
                      ? undefined
                      : clampThinkingLevel(model, thinkingLevel);
                  return runtime.streamSimple(model, piAiContext, {
                    ...(reasoning === undefined || reasoning === "off" ? {} : { reasoning }),
                    ...(apiKey === undefined ? {} : { apiKey }),
                    signal: controller.signal,
                  });
                },
              });
              return fromPiAiStream(source, controller).pipe(
                Stream.mapEffect((event) => mapStreamItem(event, runtime)),
                Stream.filterMap((item) => item),
                Stream.timeoutFail(
                  () =>
                    new ProviderError({
                      message: `pi-ai stream was idle for ${idleTimeoutMs}ms.`,
                      transient: true,
                    }),
                  idleTimeoutMs,
                ),
              );
            }),
          ).pipe(
            Stream.withSpan("kernel.provider", {
              attributes: {
                attempt: options.attempt,
                modelId: model.id,
                provider: model.provider,
                turnOrdinal: options.turnOrdinal,
              },
            }),
          ),
      };
    }),
  );

const resolveModel = (options: PiAiProviderLayerOptions): Model<Api> | undefined => {
  const known = modelRegistry.getModel(options.provider, options.modelId);
  if (known !== undefined) {
    return options.baseUrl === undefined ? known : { ...known, baseUrl: options.baseUrl };
  }
  if (options.baseUrl === undefined) {
    return undefined;
  }
  return {
    api: "openai-completions",
    baseUrl: options.baseUrl,
    contextWindow: 32_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: options.modelId,
    input: ["text"],
    maxTokens: 4_096,
    name: options.modelId,
    provider: options.provider,
    reasoning: false,
  };
};

export const PiAiProviderLive = (
  options: PiAiProviderLayerOptions,
): Layer.Layer<Provider, ProviderError, ToolRegistry> => {
  const model = resolveModel(options);
  return model === undefined
    ? Layer.fail(
        new ProviderError({
          message: `Unknown pi-ai model ${options.provider}/${options.modelId}.`,
          transient: false,
        }),
      )
    : makePiAiProviderLayer(
        model,
        defaultRuntime,
        options.idleTimeoutMs,
        options.thinkingLevel,
        options.baseUrl === undefined ? undefined : "lm-studio",
      );
};
