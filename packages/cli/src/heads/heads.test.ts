import { readFile } from "node:fs/promises";

import { createMemoryJournalBacking, JournalMemory } from "@peye/journal";
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
import { runJsonHead } from "./json.js";
import { runPrintHead } from "./print.js";
import { HEAD_EXIT_CODES, type HeadWriter } from "./shared.js";

type ScriptCase = "abort" | "error" | "plain" | "tool";

const prompts = {
  abort: "Run the aborted turn.",
  error: "Run the error turn.",
  plain: "Run the plain turn.",
  tool: "Run the tool turn.",
} as const satisfies Readonly<Record<ScriptCase, string>>;

const scriptedDriverLayer = () => {
  const provider: ProviderService = {
    streamAssistant: (context) => {
      const prompt = context.findLast((item) => item.role === "user")?.content;
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
    JournalMemory(createMemoryJournalBacking()),
    Layer.succeed(Provider, provider),
    ToolRegistryLive([defineTool(readFileTool)]),
  );
  return FirstPartyDriverDefault().pipe(Layer.provide(dependencies));
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

const normalizeJsonLines = (text: string): string => {
  const replacements = new Map<string, string>();
  let identifierNumber = 0;

  const normalize = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === "id" || normalizedKey.endsWith("id")) {
        const replacement = replacements.get(value);
        if (replacement !== undefined) {
          return replacement;
        }
        identifierNumber += 1;
        const next = `<id-${identifierNumber}>`;
        replacements.set(value, next);
        return next;
      }
      return normalizedKey.includes("timestamp") ? "<timestamp>" : value;
    }
    if (typeof value === "number" && key.toLowerCase().includes("timestamp")) {
      return "<timestamp>";
    }
    if (Array.isArray(value)) {
      return value.map((item) => normalize(item));
    }
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([entryKey, item]) => [entryKey, normalize(item, entryKey)]),
      );
    }
    return value;
  };

  return `${text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.stringify(normalize(JSON.parse(line))))
    .join("\n")}\n`;
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
