import { createMemoryJournalBacking, JournalMemory } from "@peye/journal";
import { Effect, Exit, Layer, Schema, Stream } from "effect";

import {
  defineTool,
  FirstPartyDriverDefault,
  Provider,
  ToolRegistryLive,
} from "../dist/compose.js";
import { RpcInteractionsLive, runRpcHead } from "../dist/heads/rpc.js";

const provider = {
  streamAssistant: (context) => {
    const toolFinished = context.some((item) => item.role === "toolResult");
    return toolFinished
      ? Stream.fromIterable([
          { _tag: "textDelta", text: "Tool answer: contents:fixture.txt" },
          { _tag: "done", stopReason: "done" },
        ])
      : Stream.fromIterable([
          {
            _tag: "toolCall",
            argumentsJson: '{"path":"fixture.txt"}',
            id: "read-call",
            name: "read-file",
          },
          { _tag: "done", stopReason: "toolCalls" },
        ]);
  },
};

const readFileTool = defineTool({
  description: "Reads the rpc process fixture.",
  execute: ({ path }) => Effect.succeed({ content: `contents:${path}` }),
  name: "read-file",
  parameters: Schema.Struct({ path: Schema.String }),
});

const driver = FirstPartyDriverDefault().pipe(
  Layer.provide(
    Layer.mergeAll(
      JournalMemory(createMemoryJournalBacking()),
      Layer.succeed(Provider, provider),
      ToolRegistryLive([readFileTool]),
    ),
  ),
);

const exit = await Effect.runPromiseExit(
  runRpcHead({ input: process.stdin }).pipe(
    Effect.provide(Layer.merge(driver, RpcInteractionsLive)),
  ),
);

process.exitCode = Exit.isSuccess(exit) ? exit.value : 4;
