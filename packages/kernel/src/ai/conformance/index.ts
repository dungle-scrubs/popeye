/**
 * Owns the published Provider adapter contract and the recorded pi-ai fixture implementation.
 * It exists so provider wrappers and pi-ai upgrades can prove the same mapping and failure rules.
 *
 * Vitest is a required peer dependency of this conformance subpath. The main package entry
 * deliberately does not import Vitest.
 */
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context as PiAiContext,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { Chunk, Effect, type Layer, Schema, Stream } from "effect";
import { ProviderError } from "../../errors.js";
import type { ContextItem } from "../../provider.js";
import { Provider } from "../../provider.js";
import type { Tool, ToolRegistry } from "../../tool.js";
import { defineTool, ToolRegistryLive } from "../../tool.js";
import {
  abortFixture,
  errorFixture,
  fixtureModel,
  interleavedFixture,
  mutatedSettlementFixture,
  stopReasonFixture,
  unterminatedFixture,
} from "../fixtures.js";
import { makePiAiProviderLayer } from "../seam.js";

export interface AiSeamContractFixtures<TFixture> {
  readonly aborted: () => TFixture;
  readonly deferred: () => TFixture;
  readonly error: (message: string) => TFixture;
  readonly interleaved: () => TFixture;
  readonly length: () => TFixture;
  readonly mutatedSettlement: () => TFixture;
  readonly unterminated: () => TFixture;
}

export interface AiSeamRequestCapture {
  readonly hasAbortSignal: boolean;
  readonly messages: ReadonlyArray<unknown>;
  readonly systemPrompt: string | undefined;
  readonly tools: ReadonlyArray<unknown>;
}

export interface AiSeamContractHarnessOptions {
  readonly classifyErrorAsTransient?: boolean;
  readonly onClassifyError?: (message: string) => void;
  readonly onRequest?: (request: AiSeamRequestCapture) => void;
}

export interface AiSeamContractHarness<TFixture> {
  readonly fixtures: AiSeamContractFixtures<TFixture>;
  readonly providerLayer: (
    fixture: TFixture,
    options?: AiSeamContractHarnessOptions,
  ) => Layer.Layer<Provider, ProviderError, ToolRegistry>;
}

export type MakeAiSeamContractHarness<TFixture> = () => AiSeamContractHarness<TFixture>;

interface PiAiContractFixture {
  readonly stream: AssistantMessageEventStream;
}

const captureRequest = (
  context: PiAiContext,
  options: SimpleStreamOptions | undefined,
): AiSeamRequestCapture => ({
  hasAbortSignal: options?.signal instanceof AbortSignal,
  messages: context.messages,
  systemPrompt: context.systemPrompt,
  tools: context.tools ?? [],
});

/** Creates a harness for the shipped pi-ai Provider layer and its recorded streams. */
export const createPiAiSeamContractHarness = (): AiSeamContractHarness<PiAiContractFixture> => ({
  fixtures: {
    aborted: abortFixture,
    deferred: () => stopReasonFixture("deferred"),
    error: errorFixture,
    interleaved: interleavedFixture,
    length: () => stopReasonFixture("length"),
    mutatedSettlement: mutatedSettlementFixture,
    unterminated: () => ({ stream: unterminatedFixture() }),
  },
  providerLayer: (fixture, options = {}) =>
    makePiAiProviderLayer(fixtureModel, {
      classifyError: (message: AssistantMessage) => {
        options.onClassifyError?.(message.errorMessage ?? "");
        return options.classifyErrorAsTransient ?? false;
      },
      streamSimple: (_model, context, streamOptions) => {
        options.onRequest?.(captureRequest(context, streamOptions));
        return fixture.stream;
      },
    }),
});

const collectProviderItems = async (
  layer: Layer.Layer<Provider, ProviderError, ToolRegistry>,
  context: ReadonlyArray<ContextItem>,
  tools: ReadonlyArray<Tool.Any>,
): Promise<ReadonlyArray<unknown>> => {
  const items = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider;
      return yield* Stream.runCollect(
        provider.streamAssistant(context, { attempt: 2, turnOrdinal: 7 }),
      );
    }).pipe(Effect.provide(layer), Effect.provide(ToolRegistryLive(tools))),
  );
  return Chunk.toReadonlyArray(items);
};

export const describeAiSeamContract = async <TFixture>(
  makeHarness: MakeAiSeamContractHarness<TFixture>,
): Promise<void> => {
  const { describe, expect, test } = await import("vitest");

  describe("ai seam contract", () => {
    test("maps context, tools, interleaved deltas, and settlement in order", async () => {
      const harness = makeHarness();
      const requests: Array<AiSeamRequestCapture> = [];
      const weather = defineTool({
        description: "Get the weather for a city.",
        execute: () => Effect.succeed({ content: "sunny" }),
        name: "weather",
        parameters: Schema.Struct({ city: Schema.String }),
      });
      const items = await collectProviderItems(
        harness.providerLayer(harness.fixtures.interleaved(), {
          onRequest: (request) => requests.push(request),
        }),
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
        [weather],
      );

      expect(items).toEqual([
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
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        hasAbortSignal: true,
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
    });

    test("maps a terminal provider failure to a typed ProviderError", async () => {
      const harness = makeHarness();
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const provider = yield* Provider;
          return yield* Effect.flip(
            Stream.runDrain(provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 })),
          );
        }).pipe(
          Effect.provide(harness.providerLayer(harness.fixtures.error("invalid authentication"))),
          Effect.provide(ToolRegistryLive([])),
        ),
      );

      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({
        _tag: "ProviderError",
        message: "invalid authentication",
        transient: false,
      });
    });

    test("uses the adapter classifier for transient provider failures", async () => {
      const harness = makeHarness();
      const classified: Array<string> = [];
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const provider = yield* Provider;
          return yield* Effect.flip(
            Stream.runDrain(provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 })),
          );
        }).pipe(
          Effect.provide(
            harness.providerLayer(harness.fixtures.error("temporary network timeout"), {
              classifyErrorAsTransient: true,
              onClassifyError: (message) => classified.push(message),
            }),
          ),
          Effect.provide(ToolRegistryLive([])),
        ),
      );

      expect(classified).toEqual(["temporary network timeout"]);
      expect(error).toMatchObject({ _tag: "ProviderError", transient: true });
    });

    test("maps an aborted terminal item to the kernel stop reason", async () => {
      const harness = makeHarness();
      const items = await collectProviderItems(
        harness.providerLayer(harness.fixtures.aborted()),
        [],
        [],
      );

      expect(items).toEqual([{ _tag: "done", stopReason: "aborted" }]);
    });

    test("keeps length and deferred settlements distinguishable", async () => {
      const harness = makeHarness();
      const length = await collectProviderItems(
        harness.providerLayer(harness.fixtures.length()),
        [],
        [],
      );
      const deferred = await Effect.runPromise(
        Effect.gen(function* () {
          const provider = yield* Provider;
          return yield* Effect.flip(
            Stream.runDrain(provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 })),
          );
        }).pipe(
          Effect.provide(harness.providerLayer(harness.fixtures.deferred())),
          Effect.provide(ToolRegistryLive([])),
        ),
      );

      expect(length).toEqual([{ _tag: "done", stopReason: "truncated" }]);
      expect(deferred).toMatchObject({
        _tag: "ProviderError",
        message: "deferred responses unsupported in v1",
        transient: false,
      });
    });

    test("rejects a stream that ends without a terminal item", async () => {
      const harness = makeHarness();
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const provider = yield* Provider;
          return yield* Effect.flip(
            Stream.runDrain(provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 })),
          );
        }).pipe(
          Effect.provide(harness.providerLayer(harness.fixtures.unterminated())),
          Effect.provide(ToolRegistryLive([])),
        ),
      );

      expect(error).toMatchObject({
        _tag: "ProviderError",
        message: "pi-ai stream ended without a terminal item.",
        transient: false,
      });
    });

    test("rejects terminal reason drift", async () => {
      const harness = makeHarness();
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const provider = yield* Provider;
          return yield* Effect.flip(
            Stream.runDrain(provider.streamAssistant([], { attempt: 1, turnOrdinal: 1 })),
          );
        }).pipe(
          Effect.provide(harness.providerLayer(harness.fixtures.mutatedSettlement())),
          Effect.provide(ToolRegistryLive([])),
        ),
      );

      expect(error).toMatchObject({
        _tag: "ProviderError",
        message: "pi-ai terminal mismatch: event=toolUse, message=stop.",
        transient: false,
      });
    });
  });
};

export {
  abortFixture,
  errorFixture,
  fixtureMessage,
  fixtureModel,
  interleavedFixture,
  mutatedSettlementFixture,
  type RecordedFixture,
  stopReasonFixture,
  unterminatedFixture,
} from "../fixtures.js";
