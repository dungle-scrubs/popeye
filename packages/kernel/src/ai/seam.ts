/**
 * Owns the sole pi-ai import seam selected by D-001.
 * Pi-ai's own names are exempt only inside this directory. No pi-ai type crosses the seam because
 * every request, stream item, and failure maps to the kernel's stable Provider interface.
 * This mapping is intentionally one-way: thinking signatures are not persisted or round-tripped.
 * Anthropic extended-thinking turns that also use tools will need that support in Phase 4 or later.
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
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { Effect, JSONSchema, Layer, Option, type Scope, Stream } from "effect";

import { ProviderError } from "../errors.js";
import type {
  AssistantItem,
  AssistantStopReason,
  ContextItem,
  ProviderStreamOptions,
} from "../provider.js";
import { Provider } from "../provider.js";
import type { RegisteredTool } from "../tool.js";
import { ToolRegistry } from "../tool.js";

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_LOCAL_CONTEXT_WINDOW = 128_000;
const DEFAULT_LOCAL_MAX_TOKENS = 32_000;

let modelRegistry: ReturnType<typeof builtinModels> | undefined;

const getModelRegistry = (): ReturnType<typeof builtinModels> => {
  modelRegistry ??= builtinModels();
  return modelRegistry;
};

interface PiAiRuntime {
  readonly classifyError: (message: AssistantMessage) => boolean;
  readonly streamSimple: (
    model: Model<Api>,
    context: PiAiContext,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream;
}

export type PiAiProviderThinkingLevel = "high" | "low" | "max" | "medium" | "minimal" | "xhigh";

export interface PiAiProviderLayerOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /** Fabricated base-URL models default to 128,000 tokens. */
  readonly contextWindow?: number;
  readonly idleTimeoutMs?: number;
  /** Fabricated base-URL models default to 32,000 output tokens. */
  readonly maxTokens?: number;
  readonly modelId: string;
  readonly provider: string;
  /** Fabricated base-URL models default to non-reasoning. */
  readonly reasoning?: boolean;
  readonly thinkingLevel?: PiAiProviderThinkingLevel;
}

// This assignment is a compile-time pin: an upstream ThinkingLevel addition or rename fails here.
const pinThinkingLevel = (level: ThinkingLevel): PiAiProviderThinkingLevel => level;

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

const malformedContext = (index: number, detail: string): TypeError =>
  new TypeError(`Provider context item ${index} is malformed: ${detail}.`);

const assertString = (value: unknown, index: number, field: string): string => {
  if (typeof value !== "string") {
    throw malformedContext(index, `${field} must be a string`);
  }
  return value;
};

const hasSchemaReference = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(hasSchemaReference);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if ("$defs" in value || "$ref" in value) {
    return true;
  }
  return Object.values(value).some(hasSchemaReference);
};

const toPiAiTool = (tool: RegisteredTool): PiAiTool => {
  const generated = JSONSchema.make(tool.parameters) as unknown as Record<string, unknown>;
  if (hasSchemaReference(generated)) {
    throw new TypeError(
      `Tool schema ${tool.name} uses $defs/$ref, which the v1 provider seam does not support.`,
    );
  }
  const { $id: _id, $schema: _schema, ...parameters } = generated;
  // JSONSchema.make(Schema.Struct({})) emits anyOf[object,array] with no root type, which
  // OpenAI-compatible endpoints reject: parameters.type must be "object" for every tool.
  const anyOfTypes =
    parameters.type === undefined && Array.isArray(parameters.anyOf)
      ? parameters.anyOf
          .map((member: unknown) =>
            typeof member === "object" && member !== null && Object.keys(member).length === 1
              ? (member as { readonly type?: unknown }).type
              : undefined,
          )
          .sort()
      : undefined;
  const isEmptyStructArtifact =
    anyOfTypes !== undefined &&
    anyOfTypes.length === 2 &&
    anyOfTypes[0] === "array" &&
    anyOfTypes[1] === "object";
  if (isEmptyStructArtifact) {
    return {
      description: tool.description,
      name: tool.name,
      parameters: {
        additionalProperties: false,
        properties: {},
        type: "object",
      } as PiAiTool["parameters"],
    };
  }
  if (parameters.type !== "object") {
    throw new TypeError(
      `Tool schema ${tool.name} must have an object root; providers reject non-object parameters.`,
    );
  }
  return {
    description: tool.description,
    name: tool.name,
    parameters: parameters as PiAiTool["parameters"],
  };
};

const toPiAiContext = (
  items: ReadonlyArray<ContextItem>,
  model: Model<Api>,
  declarations: Array<PiAiTool>,
): PiAiContext => {
  const systemPrompts: Array<string> = [];
  const messages: PiAiContext["messages"] = [];

  for (const [index, item] of items.entries()) {
    if (typeof item !== "object" || item === null || !("role" in item)) {
      throw malformedContext(index, "expected an object with a role");
    }
    if (item.role === "system") {
      systemPrompts.push(assertString(item.content, index, "content"));
      continue;
    }
    if (item.role === "assistant") {
      const content = assertString(item.content, index, "content");
      if (item.toolCalls !== undefined && !Array.isArray(item.toolCalls)) {
        throw malformedContext(index, "toolCalls must be an array");
      }
      const toolCalls = (item.toolCalls ?? []).map((call) => ({
        arguments: parseArguments(assertString(call.argumentsJson, index, "argumentsJson")),
        id: assertString(call.id, index, "tool call id"),
        name: assertString(call.name, index, "tool call name"),
        type: "toolCall" as const,
      }));
      messages.push({
        api: model.api,
        content: [
          ...(content.length === 0 ? [] : [{ text: content, type: "text" as const }]),
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
    if (item.role === "toolResult") {
      if (typeof item.isError !== "boolean") {
        throw malformedContext(index, "isError must be a boolean");
      }
      messages.push({
        content: [{ text: assertString(item.content, index, "content"), type: "text" }],
        isError: item.isError,
        role: "toolResult",
        timestamp: 0,
        toolCallId: assertString(item.toolCallId, index, "toolCallId"),
        toolName: assertString(item.toolName, index, "toolName"),
      });
      continue;
    }
    if (item.role === "user") {
      messages.push({
        content: assertString(item.content, index, "content"),
        role: "user",
        timestamp: 0,
      });
      continue;
    }
    throw malformedContext(index, `unsupported role ${String(item.role)}`);
  }

  return {
    messages,
    ...(systemPrompts.length === 0 ? {} : { systemPrompt: systemPrompts.join("\n\n") }),
    ...(declarations.length === 0 ? {} : { tools: declarations }),
  };
};

const stopReason = (
  reason: "deferred" | "length" | "stop" | "toolUse",
): Effect.Effect<AssistantStopReason, ProviderError> => {
  switch (reason) {
    case "stop":
      return Effect.succeed("done");
    case "toolUse":
      return Effect.succeed("toolCalls");
    case "length":
      return Effect.succeed("truncated");
    case "deferred":
      return Effect.fail(
        new ProviderError({
          message: "deferred responses unsupported in v1",
          transient: false,
        }),
      );
  }
};

const toolCallAt = (event: Extract<AssistantMessageEvent, { readonly type: "toolcall_delta" }>) => {
  const content = event.partial.content[event.contentIndex];
  return content?.type === "toolCall" ? content : undefined;
};

const mapStreamItem = (
  event: AssistantMessageEvent,
  runtime: PiAiRuntime,
  responseStatus: () => number | undefined,
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
        : stopReason(event.reason).pipe(
            Effect.map((reason) => Option.some({ _tag: "done", stopReason: reason })),
          );
    case "error": {
      if (event.reason === "aborted") {
        return Effect.succeed(Option.some({ _tag: "done", stopReason: "aborted" }));
      }
      const transient = runtime.classifyError(event.error);
      const status = responseStatus();
      return Effect.annotateCurrentSpan({ classifierVerdict: transient }).pipe(
        Effect.zipRight(
          Effect.fail(
            new ProviderError({
              message: event.error.errorMessage ?? "pi-ai provider request failed.",
              ...(status === undefined ? {} : { status }),
              transient,
            }),
          ),
        ),
      );
    }
    case "start":
    case "text_end":
    case "text_start":
    case "thinking_end":
    case "thinking_start":
    case "toolcall_start":
      return Effect.succeed(Option.none());
  }
};

const fromPiAiStream = (
  source: AssistantMessageEventStream,
  controller: AbortController,
): Effect.Effect<Stream.Stream<AssistantMessageEvent, ProviderError>, ProviderError, Scope.Scope> =>
  Effect.gen(function* () {
    const iterator = yield* Effect.try({
      catch: (cause) =>
        new ProviderError({
          message: cause instanceof Error ? cause.message : "pi-ai stream iteration failed.",
          transient: false,
        }),
      try: () => source[Symbol.asyncIterator](),
    });
    let settled = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        const abortBridgeFired = !settled;
        if (abortBridgeFired) {
          controller.abort();
        }
        try {
          const returned = iterator.return?.();
          if (returned !== undefined) {
            void Promise.resolve(returned).catch(() => undefined);
          }
        } catch {
          // Release is best effort because a provider failure must remain the primary error.
        }
        return abortBridgeFired;
      }).pipe(
        Effect.flatMap((abortBridgeFired) =>
          abortBridgeFired ? Effect.annotateCurrentSpan({ abortBridgeFired: true }) : Effect.void,
        ),
      ),
    );
    const next = Effect.tryPromise({
      catch: (cause) =>
        new ProviderError({
          message: cause instanceof Error ? cause.message : "pi-ai stream iteration failed.",
          transient: true,
        }),
      try: () => iterator.next(),
    }).pipe(
      Effect.mapError((error) => Option.some(error)),
      Effect.flatMap((result) =>
        result.done
          ? Effect.fail(
              Option.some(
                new ProviderError({
                  message: "pi-ai stream ended without a terminal item.",
                  transient: false,
                }),
              ),
            )
          : Effect.succeed(result.value),
      ),
      Effect.tap((event) =>
        event.type === "done" || event.type === "error"
          ? Effect.sync(() => {
              settled = true;
            })
          : Effect.void,
      ),
    );
    return Stream.repeatEffectOption(next).pipe(
      Stream.takeUntil((event) => event.type === "done" || event.type === "error"),
    );
  });

export const makePiAiProviderLayer = (
  model: Model<Api>,
  runtime: PiAiRuntime,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  thinkingLevel?: PiAiProviderLayerOptions["thinkingLevel"],
  apiKey?: string,
  resolveRequestModel: (modelId: string) => Model<Api> | undefined = (modelId) =>
    getModelRegistry().getModel(model.provider, modelId),
): Layer.Layer<Provider, ProviderError, ToolRegistry> => {
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1) {
    throw new RangeError("Provider idle timeout milliseconds must be a positive safe integer.");
  }
  return Layer.effect(
    Provider,
    Effect.gen(function* () {
      const toolRegistry = yield* ToolRegistry;
      const declarations = yield* Effect.try({
        catch: (cause) =>
          new ProviderError({
            message: cause instanceof Error ? cause.message : "Tool schema conversion failed.",
            transient: false,
          }),
        try: () => toolRegistry.list().map(toPiAiTool),
      });
      return {
        streamAssistant: (context: ReadonlyArray<ContextItem>, options: ProviderStreamOptions) =>
          Stream.unwrapScoped(
            Effect.gen(function* () {
              const controller = new AbortController();
              let responseStatus: number | undefined;
              const requestModel =
                options.model === undefined || options.model === model.id
                  ? model
                  : resolveRequestModel(options.model);
              if (requestModel === undefined) {
                return yield* new ProviderError({
                  message: `Unknown pi-ai model ${model.provider}/${options.model}.`,
                  transient: false,
                });
              }
              const piAiContext = yield* Effect.try({
                catch: (cause) =>
                  new ProviderError({
                    message:
                      cause instanceof Error
                        ? cause.message
                        : "Provider context conversion failed.",
                    transient: false,
                  }),
                try: () => toPiAiContext(context, requestModel, declarations),
              });
              const source = yield* Effect.try({
                catch: (cause) =>
                  new ProviderError({
                    message:
                      cause instanceof Error ? cause.message : "pi-ai stream creation failed.",
                    transient: false,
                  }),
                try: () => {
                  const requestThinkingLevel = options.thinkingLevel ?? thinkingLevel;
                  const reasoning =
                    requestThinkingLevel === undefined
                      ? undefined
                      : clampThinkingLevel(requestModel, pinThinkingLevel(requestThinkingLevel));
                  return runtime.streamSimple(requestModel, piAiContext, {
                    ...(reasoning === undefined || reasoning === "off" ? {} : { reasoning }),
                    ...(apiKey === undefined ? {} : { apiKey }),
                    onResponse: (response) => {
                      responseStatus = response.status;
                    },
                    signal: controller.signal,
                  });
                },
              });
              const stream = yield* fromPiAiStream(source, controller);
              return stream.pipe(
                Stream.mapEffect((event) => mapStreamItem(event, runtime, () => responseStatus)),
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
                modelId: options.model ?? model.id,
                provider: model.provider,
                purpose: options.purpose ?? "turn",
                ...(options.sliceIndex === undefined ? {} : { sliceIndex: options.sliceIndex }),
                turnOrdinal: options.turnOrdinal,
              },
            }),
          ),
      };
    }),
  );
};

const resolveModel = (options: PiAiProviderLayerOptions): Model<Api> | undefined => {
  const known = getModelRegistry().getModel(options.provider, options.modelId);
  if (known !== undefined) {
    return options.baseUrl === undefined ? known : { ...known, baseUrl: options.baseUrl };
  }
  if (options.baseUrl === undefined) {
    return undefined;
  }
  return {
    api: "openai-completions",
    baseUrl: options.baseUrl,
    contextWindow: options.contextWindow ?? DEFAULT_LOCAL_CONTEXT_WINDOW,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: options.modelId,
    input: ["text"],
    maxTokens: options.maxTokens ?? DEFAULT_LOCAL_MAX_TOKENS,
    name: options.modelId,
    provider: options.provider,
    reasoning: options.reasoning ?? false,
  };
};

export const PiAiProviderLive = (
  options: PiAiProviderLayerOptions,
): Layer.Layer<Provider, ProviderError, ToolRegistry> => {
  if (
    options.idleTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.idleTimeoutMs) || options.idleTimeoutMs < 1)
  ) {
    throw new RangeError("Provider idle timeout milliseconds must be a positive safe integer.");
  }
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
        options.apiKey ?? (options.provider === "lmstudio" ? "lm-studio" : undefined),
        (modelId) => resolveModel({ ...options, modelId }),
      );
};
