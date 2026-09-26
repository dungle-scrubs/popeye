import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createMemoryJournalBacking, Journal, JournalMemory } from "@dungle-scrubs/popeye-journal";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import {
  createAssistantMessageEventStream,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";
import {
  Cause,
  Chunk,
  Effect,
  Either,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  Stream,
  Tracer,
} from "effect";
import { expect, test } from "vitest";
import { ProviderError } from "../errors.js";
import type { PiAiProviderLayerOptions } from "../index.js";
import { PiAiProviderLive } from "../index.js";
import { Provider } from "../provider.js";
import { accountingRows } from "../request-accounting.js";
import { defineTool, ToolRegistryLive } from "../tool.js";
import {
  abortFixture,
  errorFixture,
  fixtureMessage,
  fixtureModel,
  interleavedFixture,
  mutatedSettlementFixture,
  type RecordedFixture,
  stopReasonFixture,
  unterminatedFixture,
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

const trackedStream = (
  events: ReadonlyArray<AssistantMessageEvent>,
  onReturn: () => void,
): AssistantMessageEventStream =>
  ({
    [Symbol.asyncIterator]: () => {
      const iterator = events[Symbol.iterator]();
      return {
        next: async () => iterator.next(),
        return: async () => {
          onReturn();
          return { done: true, value: undefined };
        },
      };
    },
    result: async () => events.at(-1),
  }) as unknown as AssistantMessageEventStream;

interface CapturedRequest {
  readonly authorization: string | undefined;
  readonly body: unknown;
}

const withOpenAiSseServer = async <TResult>(
  chunks: ReadonlyArray<unknown>,
  run: (baseUrl: string, requests: Array<CapturedRequest>) => Promise<TResult>,
): Promise<TResult> => {
  const requests: Array<CapturedRequest> = [];
  const server = createServer((request, response) => {
    const body: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => body.push(chunk));
    request.on("end", () => {
      requests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(body).toString("utf8")) as unknown,
      });
      response.writeHead(200, {
        "content-type": "text/event-stream",
      });
      for (const chunk of chunks) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("SSE test server did not expose a TCP address.");
  }
  try {
    return await run(`http://127.0.0.1:${address.port}/v1`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
};

test("one provider invocation writes a count-only start and terminal receipt", async () => {
  const stream = createAssistantMessageEventStream();
  const partial = fixtureMessage("pending");
  const final = {
    ...fixtureMessage("stop"),
    usage: {
      ...fixtureMessage("stop").usage,
      input: 31,
      output: 4,
    },
  };
  stream.push({ partial, type: "start" });
  stream.push({ message: final, reason: "stop", type: "done" });
  const journalLayer = JournalMemory(createMemoryJournalBacking());
  const providerLayer = makePiAiProviderLayer(
    fixtureModel,
    {
      classifyError: () => false,
      streamSimple: () => stream,
    },
    undefined,
    undefined,
    undefined,
    undefined,
    { recordUsage: true },
  );
  const rows = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      const provider = yield* Provider;
      yield* Stream.runDrain(
        provider.streamAssistant([{ role: "user", content: "PRIVATE SENTINEL" }], {
          attempt: 1,
          turnOrdinal: 1,
          accountingScope: { sessionId: session.id, ownerId: "turn-a" },
        }),
      );
      return accountingRows(session.id, yield* journal.readRecords(session.id));
    }).pipe(
      Effect.provide(providerLayer),
      Effect.provide(Layer.merge(journalLayer, ToolRegistryLive([]))),
    ),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    outcome: "done",
    counts: {
      input: { status: "normalized", value: 31 },
      output: { status: "normalized", value: 4 },
      cacheRead: { status: "unknown", reason: "ambiguous_zero" },
    },
  });
  expect(JSON.stringify(rows)).not.toContain("PRIVATE SENTINEL");
});

test("error and local abort each retain a distinct request receipt", async () => {
  const backing = createMemoryJournalBacking();
  const journalLayer = JournalMemory(backing);
  let invocation = 0;
  const providerLayer = makePiAiProviderLayer(
    fixtureModel,
    {
      classifyError: () => true,
      streamSimple: () => {
        invocation += 1;
        if (invocation === 1) return errorFixture().stream;
        const partial = fixtureMessage("pending", [{ text: "", type: "text" }]);
        return trackedStream(
          [
            { partial, type: "start" },
            { contentIndex: 0, partial, type: "text_start" },
            { contentIndex: 0, delta: "partial", partial, type: "text_delta" },
          ],
          () => undefined,
        );
      },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    { recordUsage: true },
  );
  const rows = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const session = yield* journal.createSession();
      const provider = yield* Provider;
      const scope = { sessionId: session.id, ownerId: "turn-a" };
      yield* Effect.either(
        Stream.runDrain(
          provider.streamAssistant([], { attempt: 1, turnOrdinal: 1, accountingScope: scope }),
        ),
      );
      yield* Stream.runDrain(
        provider
          .streamAssistant([], { attempt: 2, turnOrdinal: 1, accountingScope: scope })
          .pipe(Stream.take(1)),
      );
      return accountingRows(session.id, yield* journal.readRecords(session.id));
    }).pipe(
      Effect.provide(providerLayer),
      Effect.provide(Layer.merge(journalLayer, ToolRegistryLive([]))),
    ),
  );
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.outcome)).toEqual(["error", "aborted"]);
  expect(new Set(rows.map((row) => row.requestId)).size).toBe(2);
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
              toolName: "weather",
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
    {
      _tag: "done",
      stopReason: "toolCalls",
      usage: { contextWindowTokens: 32_000, inputTokens: 15, source: "estimate" },
    },
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

test("taking one mapped item aborts exactly once and releases the pi-ai iterator", async () => {
  let abortCount = 0;
  let returnCount = 0;
  const partial = fixtureMessage("pending", [{ text: "", type: "text" }]);
  const source = trackedStream(
    [
      { partial, type: "start" },
      { contentIndex: 0, partial, type: "text_start" },
      { contentIndex: 0, delta: "first", partial, type: "text_delta" },
    ],
    () => {
      returnCount += 1;
    },
  );
  const providerLayer = makePiAiProviderLayer(fixtureModel, {
    classifyError: () => false,
    streamSimple: (_model, _context, options) => {
      options?.signal?.addEventListener("abort", () => {
        abortCount += 1;
      });
      return source;
    },
  });

  const items = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      return yield* Stream.runCollect(
        provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 }).pipe(Stream.take(1)),
      );
    }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([]))),
  );

  expect(Chunk.toArray(items)).toEqual([{ _tag: "textDelta", text: "first" }]);
  expect(abortCount).toBe(1);
  expect(returnCount).toBe(1);
});

test("mid-stream mapping failure aborts and releases the pi-ai iterator", async () => {
  let abortCount = 0;
  let returnCount = 0;
  const partial = fixtureMessage("pending");
  const source = trackedStream(
    [
      { partial, type: "start" },
      { contentIndex: 0, delta: "{}", partial, type: "toolcall_delta" },
    ],
    () => {
      returnCount += 1;
    },
  );
  const providerLayer = makePiAiProviderLayer(fixtureModel, {
    classifyError: () => false,
    streamSimple: (_model, _context, options) => {
      options?.signal?.addEventListener("abort", () => {
        abortCount += 1;
      });
      return source;
    },
  });

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      return yield* Effect.flip(
        Stream.runDrain(provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 })),
      );
    }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([]))),
  );

  expect(error).toMatchObject({
    _tag: "ProviderError",
    message: "pi-ai tool-call delta 0 omitted its partial tool call.",
    transient: false,
  });
  expect(abortCount).toBe(1);
  expect(returnCount).toBe(1);
});

test("normal terminal completion releases the iterator without aborting", async () => {
  let abortCount = 0;
  let returnCount = 0;
  const final = fixtureMessage("stop");
  const source = trackedStream(
    [
      { partial: fixtureMessage("pending"), type: "start" },
      { message: final, reason: "stop", type: "done" },
    ],
    () => {
      returnCount += 1;
    },
  );
  const providerLayer = makePiAiProviderLayer(fixtureModel, {
    classifyError: () => false,
    streamSimple: (_model, _context, options) => {
      options?.signal?.addEventListener("abort", () => {
        abortCount += 1;
      });
      return source;
    },
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      yield* Stream.runDrain(provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 }));
    }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([]))),
  );

  expect(abortCount).toBe(0);
  expect(returnCount).toBe(1);
});

test("interrupting the consuming fiber aborts the per-request signal received by pi-ai", async () => {
  let abortCount = 0;
  let markSignalReady: (() => void) | undefined;
  const signalReady = new Promise<void>((resolve) => {
    markSignalReady = resolve;
  });
  const stalled = createAssistantMessageEventStream();
  const providerLayer = makePiAiProviderLayer(fixtureModel, {
    classifyError: () => false,
    streamSimple: (_model, _context, options) => {
      options?.signal?.addEventListener("abort", () => {
        abortCount += 1;
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

  expect(abortCount).toBe(1);
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

test("pi-ai length settles as the distinguishable kernel stop reason truncated", async () => {
  const fixture = stopReasonFixture("length");
  const providerLayer = fixtureProviderLayer(fixture, () => false);

  const items = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      return yield* Stream.runCollect(provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 }));
    }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([]))),
  );

  expect(Chunk.toArray(items)).toEqual([{ _tag: "done", stopReason: "truncated" }]);
});

test("pi-ai deferred settlement fails typed with the v1 diagnostic", async () => {
  const fixture = stopReasonFixture("deferred");
  const providerLayer = fixtureProviderLayer(fixture, () => false);

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      return yield* Effect.flip(
        Stream.runDrain(provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 })),
      );
    }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([]))),
  );

  expect(error).toMatchObject({
    _tag: "ProviderError",
    message: "deferred responses unsupported in v1",
    transient: false,
  });
});

test("pi-ai iterator end without a terminal item fails typed", async () => {
  const providerLayer = makePiAiProviderLayer(fixtureModel, {
    classifyError: () => false,
    streamSimple: () => unterminatedFixture(),
  });

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      return yield* Effect.flip(
        Stream.runDrain(provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 })),
      );
    }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([]))),
  );

  expect(error).toMatchObject({
    _tag: "ProviderError",
    message: "pi-ai stream ended without a terminal item.",
    transient: false,
  });
});

test("unknown and malformed context items fail typed instead of degrading to user messages", async () => {
  const fixture = interleavedFixture();
  const providerLayer = fixtureProviderLayer(fixture, () => false);
  const malformed = [{ content: "bad", role: "future-role" }] as unknown as Array<
    Parameters<Provider["Type"]["streamAssistant"]>[0][number]
  >;

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      return yield* Effect.flip(
        Stream.runDrain(provider.streamAssistant(malformed, { attempt: 1, turnOrdinal: 1 })),
      );
    }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([]))),
  );

  expect(error).toMatchObject({
    _tag: "ProviderError",
    message: "Provider context item 0 is malformed: unsupported role future-role.",
    transient: false,
  });
});

test("synchronous stream creation failures are permanent ProviderErrors", async () => {
  const providerLayer = makePiAiProviderLayer(fixtureModel, {
    classifyError: () => false,
    streamSimple: () => {
      throw new Error("adapter construction failed");
    },
  });

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      return yield* Effect.flip(
        Stream.runDrain(provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 })),
      );
    }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([]))),
  );

  expect(error).toMatchObject({
    _tag: "ProviderError",
    message: "adapter construction failed",
    transient: false,
  });
});

test("pi-ai response status is retained on terminal ProviderError", async () => {
  const fixture = errorFixture("rate limited");
  const providerLayer = makePiAiProviderLayer(fixtureModel, {
    classifyError: () => true,
    streamSimple: (model, _context, options) => {
      void options?.onResponse?.({ headers: {}, status: 429 }, model);
      return fixture.stream;
    },
  });

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      return yield* Effect.flip(
        Stream.runDrain(provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 })),
      );
    }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([]))),
  );

  expect(error).toMatchObject({ status: 429, transient: true });
});

test("provider idle timeout rejects zero at layer construction", () => {
  expect(() =>
    PiAiProviderLive({
      baseUrl: "http://127.0.0.1.invalid/v1",
      idleTimeoutMs: 0,
      modelId: "invalid-timeout",
      provider: "lmstudio",
    }),
  ).toThrow("Provider idle timeout milliseconds must be a positive safe integer.");
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
      yield* Stream.runDrain(
        provider.streamAssistant([], {
          attempt: 3,
          purpose: "compaction",
          sliceIndex: 2,
          turnOrdinal: 9,
        }),
      ).pipe(Effect.exit);
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
        Stream.runDrain(
          provider.streamAssistant([], { attempt: 4, purpose: "turn", turnOrdinal: 10 }),
        ),
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
  expect(providerSpans[0]?.attributes.get("purpose")).toBe("compaction");
  expect(providerSpans[0]?.attributes.get("sliceIndex")).toBe(2);
  expect(providerSpans[0]?.attributes.get("turnOrdinal")).toBe(9);
  expect(providerSpans[1]?.attributes.get("abortBridgeFired")).toBe(true);
  expect(providerSpans[1]?.attributes.get("attempt")).toBe(4);
  expect(providerSpans[1]?.attributes.get("purpose")).toBe("turn");
  expect(providerSpans[1]?.attributes.has("sliceIndex")).toBe(false);
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

test("tool schemas omit $schema and preserve optional unions and descriptions", async () => {
  const seenTools: Array<Context["tools"]> = [];
  const configurable = defineTool({
    description: "Configure output.",
    execute: () => Effect.succeed({ content: "configured" }),
    name: "configure",
    parameters: Schema.Struct({
      value: Schema.optional(
        Schema.Union(
          Schema.String.annotations({ description: "A named mode." }),
          Schema.Number.annotations({ description: "A numeric level." }),
        ),
      ),
    }),
  });
  const providerLayer = makePiAiProviderLayer(fixtureModel, {
    classifyError: () => false,
    streamSimple: (_model, context) => {
      seenTools.push(context.tools);
      return interleavedFixture().stream;
    },
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      yield* Stream.runDrain(provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 }));
      yield* Stream.runDrain(provider.streamAssistant([], { attempt: 2, turnOrdinal: 1 }));
    }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([configurable]))),
  );

  expect(seenTools).toHaveLength(2);
  expect(seenTools[0]).toBe(seenTools[1]);
  expect(seenTools[0]).toEqual([
    {
      description: "Configure output.",
      name: "configure",
      parameters: {
        additionalProperties: false,
        properties: {
          value: {
            anyOf: [
              { description: "A named mode.", type: "string" },
              { description: "A numeric level.", type: "number" },
            ],
          },
        },
        required: [],
        type: "object",
      },
    },
  ]);
});

test("no-argument tool schemas normalize to an object root providers accept", async () => {
  const seenTools: Array<Context["tools"]> = [];
  const noArguments = defineTool({
    description: "Report status.",
    execute: () => Effect.succeed({ content: "ok" }),
    name: "status",
    parameters: Schema.Struct({}),
  });
  const providerLayer = makePiAiProviderLayer(fixtureModel, {
    classifyError: () => false,
    streamSimple: (_model, context) => {
      seenTools.push(context.tools);
      return interleavedFixture().stream;
    },
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      yield* Stream.runDrain(provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 }));
    }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([noArguments]))),
  );

  expect(seenTools[0]).toEqual([
    {
      description: "Report status.",
      name: "status",
      parameters: {
        additionalProperties: false,
        properties: {},
        type: "object",
      },
    },
  ]);
});

test("union-rooted tool schemas fail clearly instead of being rewritten", async () => {
  const unionRooted = defineTool({
    description: "Accept a union root.",
    execute: () => Effect.succeed({ content: "never" }),
    name: "union-root",
    parameters: Schema.Union(Schema.String, Schema.Number) as never,
  });
  const providerLayer = makePiAiProviderLayer(fixtureModel, {
    classifyError: () => false,
    streamSimple: () => interleavedFixture().stream,
  });

  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const provider = yield* Provider;
      yield* Stream.runDrain(provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 }));
    }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([unionRooted]))),
  );

  expect(Exit.isFailure(exit)).toBe(true);
  expect(Cause.pretty(Exit.isFailure(exit) ? exit.cause : Cause.empty)).toContain(
    "must have an object root",
  );
});

test("transforming tool schemas with $defs/$ref fail clearly during layer build", async () => {
  const transforming = defineTool({
    description: "Decode a number.",
    execute: () => Effect.succeed({ content: "decoded" }),
    name: "decode_number",
    parameters: Schema.Struct({ value: Schema.NumberFromString }),
  });
  const providerLayer = makePiAiProviderLayer(fixtureModel, {
    classifyError: () => false,
    streamSimple: () => interleavedFixture().stream,
  });

  const error = await Effect.runPromise(
    Effect.flip(
      Effect.gen(function* () {
        yield* Provider;
      }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([transforming]))),
    ),
  );

  expect(error).toMatchObject({
    _tag: "ProviderError",
    message:
      "Tool schema decode_number uses $defs/$ref, which the v1 provider seam does not support.",
    transient: false,
  });
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

test("real openai-completions adapter preserves context, tools, deltas, and settlement", async () => {
  const chunks = [
    {
      choices: [{ delta: { content: "ack" }, finish_reason: null, index: 0 }],
      id: "completion-1",
      model: "wire-model",
      object: "chat.completion.chunk",
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                function: { arguments: '{"city":"Bang', name: "weather" },
                id: "wire-call",
                index: 0,
                type: "function",
              },
            ],
          },
          finish_reason: null,
          index: 0,
        },
      ],
      id: "completion-1",
      model: "wire-model",
      object: "chat.completion.chunk",
    },
    {
      choices: [
        {
          delta: { tool_calls: [{ function: { arguments: 'kok"}' }, index: 0 }] },
          finish_reason: null,
          index: 0,
        },
      ],
      id: "completion-1",
      model: "wire-model",
      object: "chat.completion.chunk",
    },
    {
      choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
      id: "completion-1",
      model: "wire-model",
      object: "chat.completion.chunk",
    },
  ];

  await withOpenAiSseServer(chunks, async (baseUrl, requests) => {
    const weather = defineTool({
      description: "Get weather.",
      execute: () => Effect.succeed({ content: "sunny" }),
      name: "weather",
      parameters: Schema.Struct({ city: Schema.String }),
    });
    const providerLayer = PiAiProviderLive({
      apiKey: "offline-key",
      baseUrl,
      maxTokens: 777,
      modelId: "wire-model",
      provider: "offline-openai",
      reasoning: true,
      thinkingLevel: "medium",
    });
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Provider;
        return yield* Stream.runCollect(
          provider.streamAssistant(
            [
              { content: "System rule.", role: "system" },
              { content: "Prior question.", role: "user" },
              {
                content: "",
                role: "assistant",
                toolCalls: [{ argumentsJson: '{"city":"Bangkok"}', id: "prior", name: "weather" }],
              },
              {
                content: "sunny",
                isError: false,
                role: "toolResult",
                toolCallId: "prior",
                toolName: "weather",
              },
            ],
            { attempt: 1, turnOrdinal: 2 },
          ),
        );
      }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([weather]))),
    );

    expect(Chunk.toArray(output)).toEqual([
      { _tag: "textDelta", text: "ack" },
      {
        _tag: "toolCallDelta",
        argumentsJsonDelta: '{"city":"Bang',
        id: "wire-call",
        index: 1,
        name: "weather",
      },
      {
        _tag: "toolCallDelta",
        argumentsJsonDelta: 'kok"}',
        id: "wire-call",
        index: 1,
        name: "weather",
      },
      {
        _tag: "toolCall",
        argumentsJson: '{"city":"Bangkok"}',
        id: "wire-call",
        name: "weather",
      },
      {
        _tag: "done",
        stopReason: "toolCalls",
        usage: { contextWindowTokens: 0, inputTokens: 13, source: "estimate" },
      },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      max_completion_tokens: 777,
      reasoning_effort: "medium",
      messages: [
        { content: "System rule.", role: "developer" },
        { content: "Prior question.", role: "user" },
        { role: "assistant", tool_calls: [{ function: { name: "weather" }, id: "prior" }] },
        { content: "sunny", role: "tool", tool_call_id: "prior" },
      ],
      tools: [{ function: { name: "weather" }, type: "function" }],
    });
  });
});

test("per-request model and thinking level change the pi-ai wire request", async () => {
  const chunks = [
    {
      choices: [{ delta: { content: "ok" }, finish_reason: "stop", index: 0 }],
      id: "completion-options",
      model: "wire-default",
      object: "chat.completion.chunk",
    },
  ];

  await withOpenAiSseServer(chunks, async (baseUrl, requests) => {
    const providerLayer = PiAiProviderLive({
      apiKey: "offline-key",
      baseUrl,
      modelId: "wire-default",
      provider: "offline-openai",
      reasoning: true,
      thinkingLevel: "minimal",
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Provider;
        yield* Stream.runDrain(
          provider.streamAssistant([{ content: "default", role: "user" }], {
            attempt: 1,
            turnOrdinal: 1,
          }),
        );
        yield* Stream.runDrain(
          provider.streamAssistant([{ content: "override", role: "user" }], {
            attempt: 1,
            model: "wire-override",
            thinkingLevel: "high",
            turnOrdinal: 2,
          }),
        );
      }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([]))),
    );

    expect(requests.map((request) => request.body)).toMatchObject([
      { model: "wire-default", reasoning_effort: "minimal" },
      { model: "wire-override", reasoning_effort: "high" },
    ]);
  });
});

test("API key policy distinguishes lmstudio, explicit keys, and known-provider proxy env keys", async () => {
  const chunks = [
    {
      choices: [{ delta: { content: "ok" }, finish_reason: "stop", index: 0 }],
      id: "completion-auth",
      model: "auth-model",
      object: "chat.completion.chunk",
    },
  ];

  await withOpenAiSseServer(chunks, async (baseUrl, requests) => {
    const run = async (options: PiAiProviderLayerOptions): Promise<void> => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const provider = yield* Provider;
          yield* Stream.runDrain(
            provider.streamAssistant([{ content: "auth", role: "user" }], {
              attempt: 1,
              turnOrdinal: 1,
            }),
          );
        }).pipe(Effect.provide(PiAiProviderLive(options)), Effect.provide(ToolRegistryLive([]))),
      );
    };

    await run({ baseUrl, modelId: "local", provider: "lmstudio" });
    await run({ apiKey: "explicit-key", baseUrl, modelId: "custom", provider: "proxy" });
    process.env.GROQ_API_KEY = "env-key";
    try {
      await run({ baseUrl, modelId: "llama-3.1-8b-instant", provider: "groq" });
    } finally {
      delete process.env.GROQ_API_KEY;
    }

    expect(requests.map((request) => request.authorization)).toEqual([
      "Bearer lm-studio",
      "Bearer explicit-key",
      "Bearer env-key",
    ]);
  });
});
