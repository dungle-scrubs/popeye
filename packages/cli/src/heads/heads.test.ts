import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";

import { createMemoryJournalBacking, Journal, JournalError, JournalMemory } from "@pop-eye/journal";
import { Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import { expect, test } from "vitest";

import {
  defineTool,
  FirstPartyDriverDefault,
  Provider,
  type ProviderService,
  type Tool,
  ToolRegistryLive,
} from "../compose.js";
import { normalizeJsonLines } from "../test-support/json.js";
import { HEAD_EXIT_CODES, type HeadWriter, makeWritableHeadWriter } from "./head-wire.js";
import { runJsonHead } from "./json.js";
import { runPrintHead } from "./print.js";

type ScriptCase = "abort" | "error" | "plain" | "tool";
type ScriptPrompt = "defect" | ScriptCase;

const prompts = {
  abort: "Run the aborted turn.",
  defect: "Run the defective turn.",
  error: "Run the error turn.",
  plain: "Run the plain turn.",
  tool: "Run the tool turn.",
} as const satisfies Readonly<Record<ScriptPrompt, string>>;

interface ScriptedDriverOptions {
  readonly journalLayer?: Layer.Layer<Journal, JournalError>;
  readonly onProviderRequest?: (prompt: string | undefined) => void;
}

const scriptedDriverLayer = (options: ScriptedDriverOptions = {}) => {
  const provider: ProviderService = {
    streamAssistant: (context) => {
      const prompt = context.findLast((item) => item.role === "user")?.content;
      options.onProviderRequest?.(prompt);
      if (prompt === prompts.defect) {
        return Stream.die(new Error("Injected provider defect."));
      }
      if (prompt === prompts.tool) {
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
      if (prompt === prompts.error) {
        return Stream.fromIterable([
          { _tag: "textDelta" as const, text: "Error-settled answer." },
          { _tag: "done" as const, stopReason: "error" as const },
        ]);
      }
      if (prompt === prompts.abort) {
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

const failAssistantAppendLayer = (): Layer.Layer<Journal, JournalError> => {
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

const captureWriter = (): {
  readonly output: () => string;
  readonly writer: HeadWriter;
} => {
  const chunks: Array<string> = [];
  return {
    output: () => chunks.join(""),
    writer: { write: (text) => Effect.sync(() => void chunks.push(text)) },
  };
};

const runPrintCase = async (scriptCase: ScriptCase) => {
  const capture = captureWriter();
  const exitCode = await Effect.runPromise(
    runPrintHead({ prompts: [prompts[scriptCase]], writer: capture.writer }).pipe(
      Effect.provide(scriptedDriverLayer()),
    ),
  );
  return { exitCode, output: capture.output() };
};

const runJsonCase = async (scriptCase: ScriptCase) => {
  const capture = captureWriter();
  const exitCode = await Effect.runPromise(
    runJsonHead({ prompts: [prompts[scriptCase]], writer: capture.writer }).pipe(
      Effect.provide(scriptedDriverLayer()),
    ),
  );
  return { exitCode, output: capture.output() };
};

const runGoldenTranscript = async (): Promise<string> => {
  const sections: Array<string> = [];
  for (const scriptCase of ["plain", "tool", "error", "abort"] as const) {
    const printed = await runPrintCase(scriptCase);
    const json = await runJsonCase(scriptCase);
    sections.push(
      [
        `CASE ${scriptCase}`,
        `PRINT EXIT ${printed.exitCode}`,
        printed.output.trimEnd(),
        `JSON EXIT ${json.exitCode}`,
        normalizeJsonLines(json.output).trimEnd(),
      ].join("\n"),
    );
  }
  return `${sections.join("\n\n")}\n`;
};

test("print head emits final assistant text only and exits 0 on done", async () => {
  const capture = captureWriter();
  const exitCode = await Effect.runPromise(
    runPrintHead({ prompts: [prompts.plain, prompts.tool], writer: capture.writer }).pipe(
      Effect.provide(scriptedDriverLayer()),
    ),
  );

  expect(exitCode).toBe(HEAD_EXIT_CODES.done);
  expect(capture.output()).toBe("Plain answer.\nTool answer: contents:fixture.txt\n");
});

test("print head exits non-zero with distinct codes on error and aborted stop reasons", async () => {
  const error = await runPrintCase("error");
  const aborted = await runPrintCase("abort");

  expect(error).toEqual({ exitCode: HEAD_EXIT_CODES.error, output: "Error-settled answer.\n" });
  expect(aborted).toEqual({ exitCode: HEAD_EXIT_CODES.aborted, output: "Aborted answer.\n" });
  expect(error.exitCode).not.toBe(aborted.exitCode);
});

test("print and json heads stop before later prompts after the first non-zero exit", async () => {
  for (const head of ["print", "json"] as const) {
    const capture = captureWriter();
    const providerRequests: Array<string | undefined> = [];
    const program =
      head === "print"
        ? runPrintHead({
            errorWriter: capture.writer,
            prompts: [prompts.error, prompts.plain],
            writer: capture.writer,
          })
        : runJsonHead({
            prompts: [prompts.error, prompts.plain],
            writer: capture.writer,
          });
    const exitCode = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          scriptedDriverLayer({
            onProviderRequest: (prompt) => providerRequests.push(prompt),
          }),
        ),
      ),
    );

    expect(exitCode).toBe(HEAD_EXIT_CODES.error);
    expect(providerRequests).toEqual([prompts.error]);
    expect(capture.output()).not.toContain("Plain answer.");
  }
});

test("turn JournalError terminates print stderr and json stdout with a non-zero exit", async () => {
  const printOutput = captureWriter();
  const printErrors = captureWriter();
  const printExit = await Effect.runPromise(
    runPrintHead({
      errorWriter: printErrors.writer,
      prompts: [prompts.plain],
      writer: printOutput.writer,
    }).pipe(Effect.provide(scriptedDriverLayer({ journalLayer: failAssistantAppendLayer() }))),
  );

  expect(printExit).toBe(HEAD_EXIT_CODES.turnFailure);
  expect(printOutput.output()).toBe("");
  expect(JSON.parse(printErrors.output())).toMatchObject({
    _tag: "headError",
    error: {
      kind: "failure",
      message: "Injected assistant append failure.",
      tag: "JournalError",
    },
  });

  const jsonOutput = captureWriter();
  const jsonExit = await Effect.runPromise(
    runJsonHead({ prompts: [prompts.plain], writer: jsonOutput.writer }).pipe(
      Effect.provide(scriptedDriverLayer({ journalLayer: failAssistantAppendLayer() })),
    ),
  );
  const jsonItems = jsonOutput
    .output()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  expect(jsonExit).toBe(HEAD_EXIT_CODES.turnFailure);
  expect(jsonItems.some((item) => item._tag === "turnSettled")).toBe(true);
  expect(jsonItems.at(-1)).toMatchObject({
    _tag: "headError",
    error: {
      kind: "failure",
      message: "Injected assistant append failure.",
      tag: "JournalError",
    },
  });
});

test("provider defects terminate both heads with a structured error", async () => {
  for (const head of ["print", "json"] as const) {
    const capture = captureWriter();
    const program =
      head === "print"
        ? runPrintHead({
            errorWriter: capture.writer,
            prompts: [prompts.defect],
            writer: capture.writer,
          })
        : runJsonHead({ prompts: [prompts.defect], writer: capture.writer });
    const exitCode = await Effect.runPromise(program.pipe(Effect.provide(scriptedDriverLayer())));
    const terminal = JSON.parse(capture.output().trimEnd().split("\n").at(-1) ?? "null");

    expect(exitCode).toBe(HEAD_EXIT_CODES.turnFailure);
    expect(terminal).toMatchObject({
      _tag: "headError",
      error: {
        kind: "defect",
        message: "Injected provider defect.",
        tag: "Error",
      },
    });
  }
});

test("json head emits one JSON item per line and honors stdout backpressure", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const firstWriteStarted = yield* Deferred.make<void>();
      const releaseFirstWrite = yield* Deferred.make<void>();
      const chunks: Array<string> = [];
      let writeCount = 0;
      const slowWriter: HeadWriter = {
        write: (text) => {
          writeCount += 1;
          chunks.push(text);
          return writeCount === 1
            ? Deferred.succeed(firstWriteStarted, undefined).pipe(
                Effect.zipRight(Deferred.await(releaseFirstWrite)),
              )
            : Effect.void;
        },
      };
      const headFiber = yield* runJsonHead({ prompts: [prompts.tool], writer: slowWriter }).pipe(
        Effect.provide(scriptedDriverLayer()),
        Effect.fork,
      );

      yield* Deferred.await(firstWriteStarted);
      expect(Option.isNone(yield* Fiber.poll(headFiber))).toBe(true);
      yield* Deferred.succeed(releaseFirstWrite, undefined);
      expect(yield* Fiber.join(headFiber)).toBe(HEAD_EXIT_CODES.done);

      const lines = chunks.join("").trimEnd().split("\n");
      const items = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines).toHaveLength(items.length);
      expect(items.some((item) => item._tag === "toolStarted")).toBe(true);
      expect(items.some((item) => item._tag === "toolCompleted")).toBe(true);
      expect(items.at(-1)).toMatchObject({ phase: "IDLE", revision: 8 });
      expect(items.at(-1)).toHaveProperty("leafEntryId");
      expect(items.at(-1)).not.toHaveProperty("_tag");
    }),
  );
});

test("writable Head writer waits for drain from a real asynchronous Node Writable", async () => {
  const releaseWrite = Promise.withResolvers<void>();
  const writeStarted = Promise.withResolvers<void>();
  const chunks: Array<string> = [];

  class SlowWritable extends Writable {
    public constructor() {
      super({ highWaterMark: 1 });
    }

    public override _write(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ): void {
      chunks.push(chunk.toString());
      writeStarted.resolve();
      void releaseWrite.promise.then(() => callback());
    }
  }

  const writer = makeWritableHeadWriter(new SlowWritable());
  let completed = false;
  const pending = Effect.runPromise(writer.write("x")).then(() => {
    completed = true;
  });

  await writeStarted.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(completed).toBe(false);
  releaseWrite.resolve();
  await pending;

  expect(completed).toBe(true);
  expect(chunks).toEqual(["x"]);
});

test("golden transcripts stay stable across scripted plain, tool, error, and aborted turns", async () => {
  const first = await runGoldenTranscript();
  const second = await runGoldenTranscript();
  const golden = await readFile(
    new URL("../../test-fixtures/heads.golden.txt", import.meta.url),
    "utf8",
  );

  expect(first).toBe(second);
  expect(first).toBe(golden);
});
