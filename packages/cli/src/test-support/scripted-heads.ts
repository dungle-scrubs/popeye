import {
  createMemoryJournalBacking,
  Journal,
  JournalError,
  JournalMemory,
} from "@dungle-scrubs/popeye-journal";
import { Effect, Layer, Schema, Stream } from "effect";

import {
  defineTool,
  FirstPartyDriverDefault,
  Provider,
  type ProviderService,
  type Tool,
  ToolRegistryLive,
} from "../compose.js";

export const headPrompts = {
  abort: "Run the aborted turn.",
  budget: "Run the budget turn.",
  defect: "Run the defective turn.",
  error: "Run the error turn.",
  plain: "Run the plain turn.",
  rateLimited: "Run the rate-limited turn.",
  tool: "Run the tool turn.",
  truncated: "Run the truncated turn.",
} as const;

export interface ScriptedHeadDriverOptions {
  readonly journalLayer?: Layer.Layer<Journal, JournalError>;
  readonly onProviderRequest?: (prompt: string | undefined) => void;
}

export const scriptedHeadDriverLayer = (options: ScriptedHeadDriverOptions = {}) => {
  const provider: ProviderService = {
    streamAssistant: (context) => {
      const prompt = context.findLast((item) => item.role === "user")?.content;
      options.onProviderRequest?.(prompt);
      if (prompt === headPrompts.defect) {
        return Stream.die(new Error("Injected provider defect."));
      }
      if (prompt === headPrompts.tool) {
        const toolFinished = context.some((item) => item.role === "toolResult");
        return toolFinished
          ? Stream.fromIterable([
              { _tag: "textDelta" as const, text: "Tool answer: contents:fixture.txt" },
              { _tag: "done" as const, stopReason: "done" as const },
            ])
          : Stream.fromIterable([
              {
                _tag: "toolCall" as const,
                argumentsJson: '{"path":"fixture.txt"}',
                id: "read-call",
                name: "read-file",
              },
              { _tag: "done" as const, stopReason: "toolCalls" as const },
            ]);
      }
      if (prompt === headPrompts.error) {
        return Stream.fromIterable([
          { _tag: "textDelta" as const, text: "Error-settled answer." },
          { _tag: "done" as const, stopReason: "error" as const },
        ]);
      }
      if (prompt === headPrompts.truncated) {
        return Stream.fromIterable([
          { _tag: "textDelta" as const, text: "Partial answer." },
          { _tag: "done" as const, stopReason: "truncated" as const },
        ]);
      }
      if (prompt === headPrompts.abort) {
        return Stream.fromIterable([
          { _tag: "textDelta" as const, text: "Aborted answer." },
          { _tag: "done" as const, stopReason: "aborted" as const },
        ]);
      }
      return Stream.fromIterable([
        { _tag: "textDelta" as const, text: "Plain answer." },
        { _tag: "done" as const, stopReason: "done" as const },
      ]);
    },
  };
  const readFileTool: Tool<{ readonly path: string }> = {
    description: "Reads the golden transcript fixture.",
    execute: ({ path }) => Effect.succeed({ content: `contents:${path}` }),
    name: "read-file",
    parameters: Schema.Struct({ path: Schema.String }),
  };
  const dependencies = Layer.mergeAll(
    options.journalLayer ?? JournalMemory(createMemoryJournalBacking()),
    Layer.succeed(Provider, provider),
    ToolRegistryLive([defineTool(readFileTool)]),
  );
  return FirstPartyDriverDefault().pipe(Layer.provide(dependencies));
};

export const driverLayerWithProvider = (provider: ProviderService) => {
  const dependencies = Layer.mergeAll(
    JournalMemory(createMemoryJournalBacking()),
    Layer.succeed(Provider, provider),
    ToolRegistryLive([]),
  );
  return FirstPartyDriverDefault().pipe(Layer.provide(dependencies));
};

export const failAssistantAppendLayer = (): Layer.Layer<Journal, JournalError> => {
  const base = JournalMemory(createMemoryJournalBacking());
  return Layer.effect(
    Journal,
    Effect.gen(function* () {
      const journal = yield* Journal;
      return {
        ...journal,
        appendEntry: (sessionId, entry) => {
          const payload = entry.payload as { readonly role?: unknown };
          return entry.kind === "message" && payload.role === "assistant"
            ? Effect.fail(
                new JournalError({
                  corruptionClass: "io_failure",
                  message: "Injected assistant append failure.",
                }),
              )
            : journal.appendEntry(sessionId, entry);
        },
      };
    }),
  ).pipe(Layer.provide(base));
};
