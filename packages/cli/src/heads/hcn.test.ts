import { readFile } from "node:fs/promises";
import { Effect, Stream } from "effect";
import { expect, test } from "vitest";
import type { TurnOptions } from "../compose.js";
import { ProviderError, type ProviderService } from "../compose.js";
import { normalizeJsonLines, SESSION_ID_FIELDS } from "../test-support/json.js";
import {
  driverLayerWithProvider,
  failAssistantAppendLayer,
  headPrompts,
  scriptedHeadDriverLayer,
} from "../test-support/scripted-heads.js";
import { captureWriter } from "../test-support/writer.js";
import { runHcnHead } from "./hcn.js";
import { runJsonHead } from "./json.js";

const prompts = headPrompts;

type ScriptCase = "abort" | "budget" | "error" | "plain" | "tool" | "truncated";

const transientFailureDriverLayer = () =>
  driverLayerWithProvider({
    streamAssistant: () =>
      Stream.fromIterable([{ _tag: "textDelta" as const, text: "Partial." }]).pipe(
        Stream.concat(
          Stream.fail(new ProviderError({ message: "socket hang up", transient: true })),
        ),
      ),
  });

const journalFailureDriverLayer = () =>
  scriptedHeadDriverLayer({ journalLayer: failAssistantAppendLayer() });

const scriptedDriverLayer = () => scriptedHeadDriverLayer();

const runHcnGolden = async (scriptCase: ScriptCase, turnOptions?: TurnOptions): Promise<string> => {
  const capture = captureWriter();
  const exitCode = await Effect.runPromise(
    runHcnHead({
      prompts: [prompts[scriptCase]],
      ...(turnOptions === undefined ? {} : { turnOptions }),
      writer: capture.writer,
    }).pipe(Effect.provide(scriptedDriverLayer())),
  );
  const sections = [
    `CASE ${scriptCase}`,
    `HCN EXIT ${exitCode}`,
    normalizeJsonLines(capture.output(), SESSION_ID_FIELDS).trimEnd(),
  ];
  return `${sections.join("\n")}\n`;
};

const runHcnCase = async (prompt: string) => {
  const capture = captureWriter();
  const exitCode = await Effect.runPromise(
    runHcnHead({ prompts: [prompt], writer: capture.writer }).pipe(
      Effect.provide(scriptedDriverLayer()),
    ),
  );
  const events = capture
    .output()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as { readonly kind: string } & Record<string, unknown>);
  return { events, exitCode };
};

test("hcn head scopes the diagnostic to the current turn on resume", async () => {
  const first = captureWriter();
  const layer = scriptedDriverLayer();
  const firstExit = await Effect.runPromise(
    runHcnHead({
      prompts: [prompts.budget],
      turnOptions: { compaction: { enabled: false }, contextBudget: 0 },
      writer: first.writer,
    }).pipe(Effect.provide(layer)),
  );
  expect(firstExit).toBe(1);
  const sessionId = (
    JSON.parse(first.output().trimEnd().split("\n")[0] ?? "null") as {
      readonly sessionId: string;
    }
  ).sessionId as unknown as import("@dungle-scrubs/popeye-journal").SessionId;

  const second = captureWriter();
  const secondExit = await Effect.runPromise(
    runHcnHead({
      prompts: [prompts.error],
      sessionId,
      writer: second.writer,
    }).pipe(Effect.provide(layer)),
  );
  const events = second
    .output()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  expect(secondExit).toBe(1);
  expect(events.map((event) => event.kind)).toEqual([
    "identity",
    "token",
    "message",
    "error",
    "failure",
    "done",
  ]);
  expect(events[4]).toMatchObject({ kind: "failure", class: "task" });
  expect(events[5]).toMatchObject({
    kind: "done",
    failure: expect.objectContaining({ class: "task" }),
  });
});

test("hcn head emits identity first with harness-minted authority", async () => {
  const { events, exitCode } = await runHcnCase(prompts.plain);

  expect(exitCode).toBe(0);
  expect(events[0]).toMatchObject({
    kind: "identity",
    authority: "harness-minted",
    capabilities: expect.objectContaining({ streaming: "token", session: true }),
  });
  expect(typeof (events[0] as { readonly sessionId?: unknown }).sessionId).toBe("string");
});

test("hcn head sources identity grants from the snapshot audit", async () => {
  const capture = captureWriter();
  const exitCode = await Effect.runPromise(
    runHcnHead({
      prompts: [prompts.plain],
      snapshotAudit: {
        capabilityGrants: ["compact", "session-name"],
        loadedGeneration: { id: "gen-1", plugins: ["compact"] },
      },
      writer: capture.writer,
    }).pipe(Effect.provide(scriptedDriverLayer())),
  );
  const events = capture
    .output()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  expect(exitCode).toBe(0);
  expect(events[0]).toMatchObject({
    kind: "identity",
    capabilities: expect.objectContaining({ grantedCapabilities: ["compact", "session-name"] }),
  });
});

test("hcn head emits compaction started and compacted through a compacting turn", async () => {
  const compacting: ProviderService = {
    streamAssistant: (_context, options) =>
      options.purpose === "compaction"
        ? Stream.fromIterable([
            { _tag: "textDelta" as const, text: "summary" },
            { _tag: "done" as const, stopReason: "done" as const },
          ])
        : Stream.fromIterable([
            { _tag: "textDelta" as const, text: "After compaction." },
            { _tag: "done" as const, stopReason: "done" as const },
          ]),
  };
  const capture = captureWriter();
  const exitCode = await Effect.runPromise(
    runHcnHead({
      prompts: ["Seed the branch with older content.", "Compact me."],
      turnOptions: { compaction: { retainedTailCount: 1, sliceBudget: 256 }, contextBudget: 12 },
      writer: capture.writer,
    }).pipe(Effect.provide(driverLayerWithProvider(compacting))),
  );
  const events = capture
    .output()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const kinds = events.map((event) => event.kind);

  expect(kinds[0]).toBe("identity");
  expect(kinds).toContain("compaction");
  const compactions = events.filter((event) => event.kind === "compaction");
  expect(compactions.map((event) => event.state)).toEqual(["started", "compacted"]);
  expect(compactions[0]).toMatchObject({
    detail: expect.stringContaining("entries"),
  });
  expect(events.at(-1)).toMatchObject({
    kind: "done",
    exitCode,
    failure: expect.objectContaining({ class: "budget" }),
  });
});

test("hcn head reads message text from the snapshot, not Progress", async () => {
  const capture = captureWriter();
  const exitCode = await Effect.runPromise(
    runHcnHead({
      prompts: [prompts.budget],
      turnOptions: { compaction: { enabled: false }, contextBudget: 0 },
      writer: capture.writer,
    }).pipe(Effect.provide(scriptedDriverLayer())),
  );
  const events = capture
    .output()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  expect(exitCode).toBe(1);
  expect(events.map((event) => event.kind)).toEqual([
    "identity",
    "message",
    "error",
    "failure",
    "done",
  ]);
  expect(events[1]).toMatchObject({
    kind: "message",
    text: "branch to an earlier entry or start a new session",
  });
});

test("hcn boundary failures end failed with exit 1 and HCN events", async () => {
  const capture = captureWriter();
  const exitCode = await Effect.runPromise(
    runHcnHead({
      prompts: [prompts.plain],
      sessionId: "missing-session" as unknown as import("@dungle-scrubs/popeye-journal").SessionId,
      writer: capture.writer,
    }).pipe(Effect.provide(scriptedDriverLayer())),
  );
  const events = capture
    .output()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  expect(exitCode).toBe(1);
  expect(exitCode).not.toBe(4);
  expect(events.map((event) => event.kind)).toEqual(["message", "error", "failure", "done"]);
  expect(events.at(-1)).toMatchObject({ kind: "done", exitCode: 1, cause: "failed" });
});

test("hcn head emits token plus one trailing message per turn", async () => {
  const { events } = await runHcnCase(prompts.plain);
  const kinds = events.map((event) => event.kind);

  expect(kinds).toEqual(["identity", "token", "message", "done"]);
  expect(events[1]).toEqual({ kind: "token", text: "Plain answer." });
  expect(events[2]).toEqual({ kind: "message", role: "assistant", text: "Plain answer." });
  expect(events[3]).toMatchObject({ kind: "done", exitCode: 0, cause: "clean" });
});

test("hcn head maps budget exhaustion to the budget class with exit 1", async () => {
  const capture = captureWriter();
  const exitCode = await Effect.runPromise(
    runHcnHead({
      prompts: [prompts.budget],
      turnOptions: { compaction: { enabled: false }, contextBudget: 0 },
      writer: capture.writer,
    }).pipe(Effect.provide(scriptedDriverLayer())),
  );
  const events = capture
    .output()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  expect(exitCode).toBe(1);
  expect(events.map((event) => event.kind)).toEqual([
    "identity",
    "message",
    "error",
    "failure",
    "done",
  ]);
  expect(events[3]).toMatchObject({ kind: "failure", class: "budget" });
  expect(events[4]).toMatchObject({
    kind: "done",
    cause: "failed",
    failure: expect.objectContaining({ class: "budget" }),
  });
});

test("hcn head maps status 429 to rate-limit with exit 1", async () => {
  const capture = captureWriter();
  const rateLimited: ProviderService = {
    streamAssistant: () =>
      Stream.fail(
        new ProviderError({ message: "Too many requests.", status: 429, transient: true }),
      ),
  };
  const exitCode = await Effect.runPromise(
    runHcnHead({ prompts: [prompts.rateLimited], writer: capture.writer }).pipe(
      Effect.provide(driverLayerWithProvider(rateLimited)),
    ),
  );
  const events = capture
    .output()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  expect(exitCode).toBe(1);
  expect(events[3]).toMatchObject({ kind: "failure", class: "rate-limit", retryable: true });
  expect(events[4]).toMatchObject({
    kind: "done",
    cause: "failed",
    failure: expect.objectContaining({ class: "rate-limit" }),
  });
});

test("hcn head maps auth failures to auth with exit 1", async () => {
  const capture = captureWriter();
  const unauthorized: ProviderService = {
    streamAssistant: () =>
      Stream.fail(
        new ProviderError({ message: "Invalid API key.", status: 401, transient: false }),
      ),
  };
  const exitCode = await Effect.runPromise(
    runHcnHead({ prompts: [prompts.rateLimited], writer: capture.writer }).pipe(
      Effect.provide(driverLayerWithProvider(unauthorized)),
    ),
  );
  const events = capture
    .output()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  expect(exitCode).toBe(1);
  expect(events[3]).toMatchObject({ kind: "failure", class: "auth" });
  expect(events[4]).toMatchObject({
    kind: "done",
    cause: "failed",
    failure: expect.objectContaining({ class: "auth" }),
  });
});

test("hcn head classifies an error turn as task and ends failed with exit 1", async () => {
  const { events, exitCode } = await runHcnCase(prompts.error);

  expect(exitCode).toBe(1);
  expect(events.map((event) => event.kind)).toEqual([
    "identity",
    "token",
    "message",
    "error",
    "failure",
    "done",
  ]);
  expect(events[4]).toMatchObject({ kind: "failure", class: "task" });
  expect(events[5]).toMatchObject({
    kind: "done",
    exitCode: 1,
    cause: "failed",
    failure: expect.objectContaining({ class: "task" }),
  });
});

test("hcn head maps abort to killed with exit 1, never exit 2", async () => {
  const { events, exitCode } = await runHcnCase(prompts.abort);

  expect(exitCode).toBe(1);
  expect(exitCode).not.toBe(2);
  expect(events.at(-1)).toMatchObject({ kind: "done", exitCode: 1, cause: "killed" });
});

test("hcn head ends truncation done-clean with a message note and no limit event", async () => {
  const { events, exitCode } = await runHcnCase(prompts.truncated);

  expect(exitCode).toBe(0);
  expect(events.map((event) => event.kind)).not.toContain("limit");
  expect(events[2]).toMatchObject({
    kind: "message",
    text: expect.stringContaining("turn truncated"),
  });
  expect(events.at(-1)).toMatchObject({ kind: "done", exitCode: 0, cause: "clean" });
});

test("hcn head reaches done through tool calls the kernel consumes", async () => {
  const { events, exitCode } = await runHcnCase(prompts.tool);

  expect(exitCode).toBe(0);
  expect(events.at(-1)).toMatchObject({ kind: "done", exitCode: 0, cause: "clean" });
});

test("hcn exit matrix: done 0 clean, truncated 0 clean, error 1 failed, aborted 1 killed", async () => {
  const plain = await runHcnCase(prompts.plain);
  const truncated = await runHcnCase(prompts.truncated);
  const error = await runHcnCase(prompts.error);
  const abort = await runHcnCase(prompts.abort);

  expect([plain.exitCode, truncated.exitCode, error.exitCode, abort.exitCode]).toEqual([
    0, 0, 1, 1,
  ]);
  expect(plain.events.at(-1)).toMatchObject({ cause: "clean" });
  expect(truncated.events.at(-1)).toMatchObject({ cause: "clean" });
  expect(error.events.at(-1)).toMatchObject({ cause: "failed" });
  expect(abort.events.at(-1)).toMatchObject({ cause: "killed" });
});

test("transient provider failures reach the diagnostic and map to transport", async () => {
  const capture = captureWriter();
  const exitCode = await Effect.runPromise(
    runHcnHead({ prompts: [prompts.plain], writer: capture.writer }).pipe(
      Effect.provide(transientFailureDriverLayer()),
    ),
  );
  const events = capture
    .output()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  expect(exitCode).toBe(1);
  expect(events.map((event) => event.kind)).toEqual([
    "identity",
    "message",
    "error",
    "failure",
    "done",
  ]);
  expect(events[3]).toMatchObject({ class: "transport", retryable: true });
  expect(events[4]).toMatchObject({
    kind: "done",
    cause: "failed",
    failure: expect.objectContaining({ class: "transport" }),
  });
});

test("golden transcripts stay stable across scripted hcn turns", async () => {
  const first = await runHcnGoldenTranscript();
  const second = await runHcnGoldenTranscript();
  const golden = await readFile(
    new URL("../../test-fixtures/hcn.golden.txt", import.meta.url),
    "utf8",
  );

  expect(first).toBe(second);
  expect(first).toBe(golden);
});

const runHcnGoldenTranscript = async (): Promise<string> => {
  const sections: Array<string> = [];
  for (const scriptCase of ["plain", "tool", "error", "budget", "truncated", "abort"] as const) {
    sections.push(
      await runHcnGolden(
        scriptCase,
        scriptCase === "budget" ? { compaction: { enabled: false }, contextBudget: 0 } : undefined,
      ),
    );
  }
  return `${sections.join("\n")}\n`;
};

test("hcn and json heads agree on exit codes across scripted turns", async () => {
  for (const prompt of [prompts.plain, prompts.error, prompts.abort] as const) {
    const capture = captureWriter();
    const jsonExit = await Effect.runPromise(
      runJsonHead({ prompts: [prompt], writer: capture.writer }).pipe(
        Effect.provide(scriptedDriverLayer()),
      ),
    );
    const { exitCode: hcnExit } = await runHcnCase(prompt);
    if (prompt === prompts.abort) {
      expect(jsonExit).toBe(2);
      expect(hcnExit).toBe(1);
    } else {
      expect(hcnExit).toBe(jsonExit);
    }
  }
});

test("provider defects terminate the hcn head with a task failure and exit 1", async () => {
  const capture = captureWriter();
  const defectProvider: ProviderService = {
    streamAssistant: () => Stream.die(new Error("Injected provider defect.")),
  };
  const exitCode = await Effect.runPromise(
    runHcnHead({ prompts: ["Run the defective turn."], writer: capture.writer }).pipe(
      Effect.provide(driverLayerWithProvider(defectProvider)),
    ),
  );
  const events = capture
    .output()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  expect(exitCode).toBe(1);
  expect(events.map((event) => event.kind)).toEqual([
    "identity",
    "message",
    "error",
    "failure",
    "done",
  ]);
  expect(events[3]).toMatchObject({ class: "task" });
});

test("journal failures terminate the hcn head with a task failure and exit 1", async () => {
  const capture = captureWriter();
  const exitCode = await Effect.runPromise(
    runHcnHead({ prompts: [prompts.plain], writer: capture.writer }).pipe(
      Effect.provide(journalFailureDriverLayer()),
    ),
  );
  const events = capture
    .output()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  expect(exitCode).toBe(1);
  expect(events.map((event) => event.kind)).toEqual([
    "identity",
    "message",
    "error",
    "failure",
    "done",
  ]);
  expect(events[3]).toMatchObject({ class: "task" });
});
