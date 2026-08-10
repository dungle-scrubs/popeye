import { readFile } from "node:fs/promises";
import type { AssistantMessage, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";

import {
  createAssistantMessageEventStream,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";
import { Chunk, Effect, Either, Exit, Fiber, Layer, Option, Schema, Stream, Tracer } from "effect";
import { expect, test } from "vitest";
import { ProviderError } from "../errors.js";
import type { PiAiProviderLayerOptions } from "../index.js";
import { PiAiProviderLive } from "../index.js";
import { Provider } from "../provider.js";
import { defineTool, ToolRegistryLive } from "../tool.js";
import {
  abortFixture,
  errorFixture,
  fixtureModel,
  interleavedFixture,
  mutatedSettlementFixture,
  type RecordedFixture,
} from "./fixtures.js";
import { makePiAiProviderLayer } from "./seam.js";

const fixtureProviderLayer = (
  fixture: RecordedFixture,
  classifyError: (message: AssistantMessage) => boolean,
) =>
  makePiAiProviderLayer(fixtureModel, {
    classifyError,
    streamSimple: () => fixture.stream,
  });

test("recorded interleaved pi-ai fixture maps context, tools, deltas, and settlement in order", async () => {
  const fixture = interleavedFixture();
  let receivedContext: Context | undefined;
  let receivedOptions: SimpleStreamOptions | undefined;
  const providerLayer = makePiAiProviderLayer(fixtureModel, {
    classifyError: () => false,
    streamSimple: (_model, context, options) => {
      receivedContext = context;
      receivedOptions = options;
      return fixture.stream;
    },
  }).pipe((provider) => provider);
  const weather = defineTool({
    description: "Get the weather for a city.",
    execute: () => Effect.succeed({ content: "sunny" }),
    name: "weather",
    parameters: Schema.Struct({ city: Schema.String }),
  });

  const items = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      return yield* Stream.runCollect(
        provider.streamAssistant(
          [
            { content: "Be concise.", role: "system" },
            { content: "Weather?", role: "user" },
            {
              content: "",
              role: "assistant",
              toolCalls: [{ argumentsJson: '{"city":"Bangkok"}', id: "prior-1", name: "weather" }],
            },
            {
              content: "sunny",
              isError: false,
              role: "toolResult",
              toolCallId: "prior-1",
            },
          ],
          { attempt: 2, turnOrdinal: 7 },
        ),
      );
    }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([weather]))),
  );

  expect(Chunk.toArray(items)).toEqual([
    { _tag: "textDelta", text: "hel" },
    { _tag: "textDelta", text: "lo" },
    { _tag: "thinkingDelta", text: "rea" },
    { _tag: "thinkingDelta", text: "son" },
    {
      _tag: "toolCallDelta",
      argumentsJsonDelta: '{"city":"Bang',
      id: "tool-1",
      index: 2,
      name: "weather",
    },
    {
      _tag: "toolCallDelta",
      argumentsJsonDelta: 'kok"}',
      id: "tool-1",
      index: 2,
      name: "weather",
    },
    {
      _tag: "toolCall",
      argumentsJson: '{"city":"Bangkok"}',
      id: "tool-1",
      name: "weather",
    },
    { _tag: "done", stopReason: "toolCalls" },
  ]);
  expect(receivedContext).toMatchObject({
    messages: [
      { content: "Weather?", role: "user" },
      {
        content: [
          {
            arguments: { city: "Bangkok" },
            id: "prior-1",
            name: "weather",
            type: "toolCall",
          },
        ],
        role: "assistant",
      },
      {
        content: [{ text: "sunny", type: "text" }],
        isError: false,
        role: "toolResult",
        toolCallId: "prior-1",
        toolName: "weather",
      },
    ],
    systemPrompt: "Be concise.",
    tools: [
      {
        description: "Get the weather for a city.",
        name: "weather",
        parameters: {
          additionalProperties: false,
          properties: { city: { type: "string" } },
          required: ["city"],
          type: "object",
        },
      },
    ],
  });
  expect(receivedOptions?.signal).toBeInstanceOf(AbortSignal);
  await expect(fixture.stream.result()).resolves.toBe(fixture.final);
});

test("terminal pi-ai error fixture fails with typed ProviderError instead of throwing", async () => {
  const fixture = errorFixture("invalid authentication");
  const providerLayer = fixtureProviderLayer(fixture, () => false);

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      return yield* Effect.flip(
        Stream.runCollect(provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 })),
      );
    }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([]))),
  );

  expect(error).toBeInstanceOf(ProviderError);
  expect(error).toMatchObject({
    _tag: "ProviderError",
    message: "invalid authentication",
    transient: false,
  });
  await expect(fixture.stream.result()).resolves.toBe(fixture.final);
});

test("ProviderError transient verdict delegates to pi-ai's assistant error classifier", async () => {
  const fixture = errorFixture("temporary network timeout");
  const classified: Array<unknown> = [];
  const providerLayer = fixtureProviderLayer(fixture, (message) => {
    classified.push(message);
    return isRetryableAssistantError(message);
  });

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      return yield* Effect.flip(
        Stream.runDrain(provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 })),
      );
    }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([]))),
  );

  expect(classified).toEqual([fixture.final]);
  expect(error).toMatchObject({ _tag: "ProviderError", transient: true });
});

test("terminal pi-ai aborted fixture settles with kernel stop reason aborted", async () => {
  const fixture = abortFixture();
  const providerLayer = fixtureProviderLayer(fixture, () => false);

  const items = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      return yield* Stream.runCollect(provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 }));
    }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([]))),
  );

  expect(Chunk.toArray(items)).toEqual([{ _tag: "done", stopReason: "aborted" }]);
  await expect(fixture.stream.result()).resolves.toBe(fixture.final);
});

test("interrupting the consuming fiber aborts the per-request signal received by pi-ai", async () => {
  let abortObserved = false;
  let markSignalReady: (() => void) | undefined;
  const signalReady = new Promise<void>((resolve) => {
    markSignalReady = resolve;
  });
  const stalled = createAssistantMessageEventStream();
  const providerLayer = makePiAiProviderLayer(fixtureModel, {
    classifyError: () => false,
    streamSimple: (_model, _context, options) => {
      options?.signal?.addEventListener("abort", () => {
        abortObserved = true;
      });
      markSignalReady?.();
      return stalled;
    },
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      const fiber = yield* Effect.fork(
        Stream.runDrain(provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 })),
      );
      yield* Effect.promise(() => signalReady);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([]))),
  );

  expect(abortObserved).toBe(true);
});

test("stalled pi-ai stream fails with a transient ProviderError at the configured idle timeout", async () => {
  const stalled = createAssistantMessageEventStream();
  const providerLayer = makePiAiProviderLayer(
    fixtureModel,
    {
      classifyError: () => false,
      streamSimple: () => stalled,
    },
    5,
  );

  const timed = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      return yield* Stream.runDrain(
        provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 }),
      ).pipe(Effect.either, Effect.timeoutOption("100 millis"));
    }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([]))),
  );

  expect(Option.isSome(timed)).toBe(true);
  const result = Option.getOrThrow(timed);
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(result.left).toMatchObject({
      _tag: "ProviderError",
      message: "pi-ai stream was idle for 5ms.",
      transient: true,
    });
  }
});

test("kernel.provider spans record attempt, classifier verdict, and abort-bridge firing", async () => {
  const spans: Array<{ readonly attributes: Map<string, unknown>; readonly name: string }> = [];
  const tracer = Tracer.make({
    context: (evaluate) => evaluate(),
    span: (name, parent, context, links, startTime, kind, options) => {
      const captured = {
        attributes: new Map(Object.entries(options?.attributes ?? {})),
        name,
      };
      spans.push(captured);
      return {
        _tag: "Span",
        addLinks: () => undefined,
        attribute: (key, value) => captured.attributes.set(key, value),
        attributes: captured.attributes,
        context,
        end: () => undefined,
        event: () => undefined,
        kind,
        links,
        name,
        parent,
        sampled: true,
        spanId: `${spans.length}`,
        status: { _tag: "Started", startTime },
        traceId: "captured",
      } satisfies Tracer.Span;
    },
  });
  const traceLayer = Layer.merge(Layer.setTracer(tracer), Layer.setTracerEnabled(true));
  const failed = errorFixture("temporary network timeout");
  const failedLayer = fixtureProviderLayer(failed, () => true);

  await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      yield* Stream.runDrain(provider.streamAssistant([], { attempt: 3, turnOrdinal: 9 })).pipe(
        Effect.exit,
      );
    }).pipe(
      Effect.provide(failedLayer),
      Effect.provide(ToolRegistryLive([])),
      Effect.provide(traceLayer),
    ),
  );

  let markReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const stalled = createAssistantMessageEventStream();
  const interruptedLayer = makePiAiProviderLayer(fixtureModel, {
    classifyError: () => false,
    streamSimple: () => {
      markReady?.();
      return stalled;
    },
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      const fiber = yield* Effect.fork(
        Stream.runDrain(provider.streamAssistant([], { attempt: 4, turnOrdinal: 10 })),
      );
      yield* Effect.promise(() => ready);
      const interrupted = yield* Fiber.interrupt(fiber);
      expect(Exit.isFailure(interrupted)).toBe(true);
    }).pipe(
      Effect.provide(interruptedLayer),
      Effect.provide(ToolRegistryLive([])),
      Effect.provide(traceLayer),
    ),
  );

  const providerSpans = spans.filter((span) => span.name === "kernel.provider");
  expect(providerSpans).toHaveLength(2);
  expect(providerSpans[0]?.attributes.get("attempt")).toBe(3);
  expect(providerSpans[0]?.attributes.get("classifierVerdict")).toBe(true);
  expect(providerSpans[0]?.attributes.get("modelId")).toBe(fixtureModel.id);
  expect(providerSpans[0]?.attributes.get("provider")).toBe(fixtureModel.provider);
  expect(providerSpans[0]?.attributes.get("turnOrdinal")).toBe(9);
  expect(providerSpans[1]?.attributes.get("abortBridgeFired")).toBe(true);
  expect(providerSpans[1]?.attributes.get("attempt")).toBe(4);
});

test("public ai seam signatures expose kernel-owned configuration without pi-ai types", () => {
  const options = {
    baseUrl: "http://127.0.0.1:1234/v1",
    idleTimeoutMs: 15_000,
    modelId: "local-model",
    provider: "lmstudio",
    thinkingLevel: "medium",
  } satisfies PiAiProviderLayerOptions;

  const layer = PiAiProviderLive(options);

  expect(Layer.isLayer(layer)).toBe(true);
  expect(options).toEqual({
    baseUrl: "http://127.0.0.1:1234/v1",
    idleTimeoutMs: 15_000,
    modelId: "local-model",
    provider: "lmstudio",
    thinkingLevel: "medium",
  });
});

test("requested thinking level is clamped by pi-ai before provider streaming", async () => {
  const fixture = interleavedFixture();
  let receivedOptions: SimpleStreamOptions | undefined;
  const providerLayer = makePiAiProviderLayer(
    fixtureModel,
    {
      classifyError: () => false,
      streamSimple: (_model, _context, options) => {
        receivedOptions = options;
        return fixture.stream;
      },
    },
    1_000,
    "max",
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      yield* Stream.runDrain(provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 }));
    }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([]))),
  );

  expect(receivedOptions?.reasoning).toBe("high");
});

test("pi-ai is exact-pinned and a mutated settlement fixture fails the contract suite loudly", async () => {
  const packageJson: unknown = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  expect(packageJson).toMatchObject({
    dependencies: { "@earendil-works/pi-ai": "0.84.1" },
  });

  const fixture = mutatedSettlementFixture();
  const providerLayer = fixtureProviderLayer(fixture, () => false);
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      return yield* Stream.runDrain(
        provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 }),
      ).pipe(Effect.either);
    }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([]))),
  );

  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(result.left).toMatchObject({
      _tag: "ProviderError",
      message: "pi-ai terminal mismatch: event=toolUse, message=stop.",
      transient: false,
    });
  }
});

test("OpenAI-compatible local model supplies pi-ai's required placeholder API key", async () => {
  const fixture = interleavedFixture();
  let receivedOptions: SimpleStreamOptions | undefined;
  const providerLayer = makePiAiProviderLayer(
    fixtureModel,
    {
      classifyError: () => false,
      streamSimple: (_model, _context, options) => {
        receivedOptions = options;
        return fixture.stream;
      },
    },
    1_000,
    undefined,
    "lm-studio",
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      yield* Stream.runDrain(provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 }));
    }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([]))),
  );

  expect(receivedOptions?.apiKey).toBe("lm-studio");
});
