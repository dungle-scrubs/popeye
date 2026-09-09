import { spawn } from "node:child_process";
import { PassThrough, Readable } from "node:stream";

import { createMemoryJournalBacking, JournalMemory } from "@pop-eye/journal";
import { InteractionTimeout, ProtocolError } from "@pop-eye/protocol";
import { Deferred, Effect, Either, Fiber, Layer, Stream, Tracer } from "effect";
import { expect, test } from "vitest";

import {
  Driver,
  FirstPartyDriverDefault,
  Provider,
  type ProviderService,
  ToolRegistryLive,
} from "../compose.js";
import { HeadWriteError, type HeadWriter } from "./head-wire.js";
import {
  MAX_RPC_FRAME_BYTES,
  RpcInteractions,
  RpcInteractionsLive,
  runRpcHead,
  strictLfFrames,
} from "./rpc.js";
import { RPC_SESSION_QUEUE_CAPACITY } from "./rpc-dispatch.js";
import { FakeTransport } from "./rpc-transport.js";

const idleProvider: ProviderService = {
  streamAssistant: () => Stream.empty,
};

const rpcDriverLayer = Layer.merge(
  FirstPartyDriverDefault().pipe(
    Layer.provide(
      Layer.mergeAll(
        JournalMemory(createMemoryJournalBacking()),
        Layer.succeed(Provider, idleProvider),
        ToolRegistryLive([]),
      ),
    ),
  ),
  RpcInteractionsLive,
);

const captureWriter = (): {
  readonly lines: () => ReadonlyArray<Record<string, unknown>>;
  readonly writer: HeadWriter;
} => {
  const chunks: Array<string> = [];
  return {
    lines: () =>
      chunks
        .join("")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    writer: { write: (text) => Effect.sync(() => void chunks.push(text)) },
  };
};

test("rpc framing uses LF only and preserves Unicode separators, CRLF, empty lines, and huge frames", async () => {
  const content = `left\u2028middle\u2029right`;
  const huge = "x".repeat(256 * 1_024);
  const first = JSON.stringify({ _tag: "prompt", content, id: "unicode", sessionId: "session-1" });
  const second = JSON.stringify({
    _tag: "prompt",
    content: huge,
    id: "huge",
    sessionId: "session-1",
  });
  const partial = JSON.stringify({ _tag: "list", id: "partial" });
  const input = Readable.from([
    Buffer.from(`${first}\r`),
    Buffer.from(`\n\n${second.slice(0, 65_537)}`),
    Buffer.from(`${second.slice(65_537)}\n${partial}`),
  ]);

  const frames = await Effect.runPromise(Stream.runCollect(strictLfFrames(input)));
  const decoded = Array.from(frames, (frame) => JSON.parse(frame) as Record<string, unknown>);

  expect(decoded).toEqual([
    { _tag: "prompt", content, id: "unicode", sessionId: "session-1" },
    { _tag: "prompt", content: huge, id: "huge", sessionId: "session-1" },
  ]);
});

test("rpc abort bypasses a stalled prompt and correlates both responses", async () => {
  const input = new PassThrough();
  const providerEntered = Promise.withResolvers<void>();
  const releaseProvider = Promise.withResolvers<void>();
  const abortWritten = Promise.withResolvers<Record<string, unknown>>();
  const promptWritten = Promise.withResolvers<Record<string, unknown>>();
  const stalledProvider: ProviderService = {
    streamAssistant: () =>
      Stream.fromEffect(
        Effect.sync(() => providerEntered.resolve()).pipe(
          Effect.as({ _tag: "textDelta" as const, text: "Partial answer." }),
        ),
      ).pipe(
        Stream.concat(
          Stream.fromEffect(
            Effect.promise(() => releaseProvider.promise).pipe(
              Effect.as({ _tag: "done" as const, stopReason: "done" as const }),
            ),
          ),
        ),
      ),
  };
  const stalledLayer = Layer.merge(
    FirstPartyDriverDefault().pipe(
      Layer.provide(
        Layer.mergeAll(
          JournalMemory(createMemoryJournalBacking()),
          Layer.succeed(Provider, stalledProvider),
          ToolRegistryLive([]),
        ),
      ),
    ),
    RpcInteractionsLive,
  );
  const writer: HeadWriter = {
    write: (text) =>
      Effect.sync(() => {
        const frame = JSON.parse(text) as Record<string, unknown>;
        if (frame.id === "abort-stalled") {
          abortWritten.resolve(frame);
        }
        if (frame.id === "prompt-stalled") {
          promptWritten.resolve(frame);
        }
      }),
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      const head = yield* runRpcHead({ input, writer }).pipe(Effect.forkDaemon);
      input.write(
        `${JSON.stringify({
          _tag: "prompt",
          content: "Stall until aborted.",
          id: "prompt-stalled",
          sessionId: session.id,
        })}\n`,
      );
      yield* Effect.promise(() => providerEntered.promise);
      input.write(
        `${JSON.stringify({ _tag: "abort", id: "abort-stalled", sessionId: session.id })}\n`,
      );

      const abort = yield* Effect.raceFirst(
        Effect.promise(() => abortWritten.promise).pipe(
          Effect.map((frame) => frame as Record<string, unknown> | undefined),
        ),
        Effect.sleep("200 millis").pipe(Effect.as(undefined)),
      );
      if (abort === undefined) {
        releaseProvider.resolve();
        input.end();
        yield* Fiber.join(head);
        return undefined;
      }
      const prompt = yield* Effect.promise(() => promptWritten.promise).pipe(
        Effect.timeout("200 millis"),
      );
      input.end();
      const exitCode = yield* Fiber.join(head);
      return { abort, exitCode, prompt };
    }).pipe(Effect.ensuring(Effect.sync(() => input.end())), Effect.provide(stalledLayer)),
  );

  expect(result).toBeDefined();
  if (result === undefined) {
    return;
  }
  expect(result.exitCode).toBe(0);
  expect(result.abort).toMatchObject({
    id: "abort-stalled",
    result: { _tag: "abortTurnAborted", aborted: true },
  });
  expect(result.prompt).toMatchObject({
    id: "prompt-stalled",
    result: {
      entries: expect.arrayContaining([
        expect.objectContaining({
          kind: "message",
          payload: expect.objectContaining({ role: "assistant", stopReason: "aborted" }),
        }),
      ]),
    },
  });
});

test("rpc abort outracing a queued prompt reports that no turn was aborted", async () => {
  const input = new PassThrough();
  const setModelStarted = Promise.withResolvers<void>();
  const releaseSetModel = Promise.withResolvers<void>();
  const abortWritten = Promise.withResolvers<Record<string, unknown>>();
  const promptWritten = Promise.withResolvers<Record<string, unknown>>();
  const modelWritten = Promise.withResolvers<Record<string, unknown>>();
  const writer: HeadWriter = {
    write: (text) =>
      Effect.sync(() => {
        const frame = JSON.parse(text) as Record<string, unknown>;
        if (frame.id === "abort-before-prompt") {
          abortWritten.resolve(frame);
        }
        if (frame.id === "prompt-after-blocker") {
          promptWritten.resolve(frame);
        }
        if (frame.id === "model-blocker") {
          modelWritten.resolve(frame);
        }
      }),
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      const blockedDriver = {
        ...driver,
        setModel: (...args: Parameters<typeof driver.setModel>) =>
          Effect.sync(() => setModelStarted.resolve()).pipe(
            Effect.zipRight(Effect.promise(() => releaseSetModel.promise)),
            Effect.zipRight(driver.setModel(...args)),
          ),
      } satisfies typeof driver;
      const head = yield* runRpcHead({ input, writer }).pipe(
        Effect.provide(Layer.merge(Layer.succeed(Driver, blockedDriver), RpcInteractionsLive)),
        Effect.fork,
      );
      input.write(
        `${JSON.stringify({
          _tag: "set-model",
          id: "model-blocker",
          model: "provider/blocked",
          sessionId: session.id,
        })}\n`,
      );
      yield* Effect.promise(() => setModelStarted.promise);
      input.write(
        `${JSON.stringify({
          _tag: "prompt",
          content: "This prompt must still be queued.",
          id: "prompt-after-blocker",
          sessionId: session.id,
        })}\n`,
      );
      input.write(
        `${JSON.stringify({
          _tag: "abort",
          id: "abort-before-prompt",
          sessionId: session.id,
        })}\n`,
      );
      const abort = yield* Effect.promise(() => abortWritten.promise).pipe(
        Effect.timeout("200 millis"),
      );
      releaseSetModel.resolve();
      yield* Effect.promise(() => modelWritten.promise);
      yield* Effect.promise(() => promptWritten.promise);
      input.end();
      const exitCode = yield* Fiber.join(head);
      return { abort, exitCode };
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          releaseSetModel.resolve();
          input.end();
        }),
      ),
      Effect.provide(rpcDriverLayer),
    ),
  );

  expect(result.exitCode).toBe(0);
  expect(result.abort).toMatchObject({
    id: "abort-before-prompt",
    result: { _tag: "abortTurnNotAborted", aborted: false, reason: "none" },
  });
});

test("rpc applies set-model before a same-session prompt under adversarial scheduling", async () => {
  const input = new PassThrough();
  const setModelStarted = Promise.withResolvers<void>();
  const releaseSetModel = Promise.withResolvers<void>();
  const providerStarted = Promise.withResolvers<void>();
  const bothResponsesWritten = Promise.withResolvers<void>();
  const responseOrder: Array<string> = [];
  let observedModel: string | undefined;
  let providerStartCount = 0;
  const observingProvider: ProviderService = {
    streamAssistant: (_context, options) =>
      Stream.fromEffect(
        Effect.sync(() => {
          providerStartCount += 1;
          observedModel = options.model;
          providerStarted.resolve();
        }).pipe(Effect.as({ _tag: "done" as const, stopReason: "done" as const })),
      ),
  };
  const observingLayer = Layer.merge(
    FirstPartyDriverDefault().pipe(
      Layer.provide(
        Layer.mergeAll(
          JournalMemory(createMemoryJournalBacking()),
          Layer.succeed(Provider, observingProvider),
          ToolRegistryLive([]),
        ),
      ),
    ),
    RpcInteractionsLive,
  );
  const writer: HeadWriter = {
    write: (text) =>
      Effect.sync(() => {
        const frame = JSON.parse(text) as Record<string, unknown>;
        if (frame.id === "model-before-prompt" || frame.id === "prompt-after-model") {
          responseOrder.push(frame.id);
          if (responseOrder.length === 2) {
            bothResponsesWritten.resolve();
          }
        }
      }),
  };

  const exitCode = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      const blockedDriver = {
        ...driver,
        setModel: (...args: Parameters<typeof driver.setModel>) =>
          Effect.sync(() => setModelStarted.resolve()).pipe(
            Effect.zipRight(Effect.promise(() => releaseSetModel.promise)),
            Effect.zipRight(driver.setModel(...args)),
          ),
      } satisfies typeof driver;
      const head = yield* runRpcHead({ input, writer }).pipe(
        Effect.provide(Layer.merge(Layer.succeed(Driver, blockedDriver), RpcInteractionsLive)),
        Effect.fork,
      );
      input.write(
        `${JSON.stringify({
          _tag: "set-model",
          id: "model-before-prompt",
          model: "provider/in-order",
          sessionId: session.id,
        })}\n`,
      );
      input.write(
        `${JSON.stringify({
          _tag: "prompt",
          content: "Use the model selected by the preceding frame.",
          id: "prompt-after-model",
          sessionId: session.id,
        })}\n`,
      );
      yield* Effect.promise(() => setModelStarted.promise);
      yield* Effect.yieldNow();
      yield* Effect.yieldNow();
      expect(providerStartCount).toBe(0);
      releaseSetModel.resolve();
      yield* Effect.promise(() => providerStarted.promise).pipe(Effect.timeout("200 millis"));
      yield* Effect.promise(() => bothResponsesWritten.promise).pipe(Effect.timeout("200 millis"));
      input.end();
      return yield* Fiber.join(head);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          releaseSetModel.resolve();
          input.end();
        }),
      ),
      Effect.provide(observingLayer),
    ),
  );

  expect(exitCode).toBe(0);
  expect(observedModel).toBe("provider/in-order");
  expect(responseOrder).toEqual(["model-before-prompt", "prompt-after-model"]);
});

test("rpc runs distinct sessions concurrently while each provider stream is stalled", async () => {
  const input = new PassThrough();
  const bothProvidersStarted = Promise.withResolvers<void>();
  const releaseProviders = Promise.withResolvers<void>();
  const promptAWritten = Promise.withResolvers<void>();
  const promptBWritten = Promise.withResolvers<void>();
  let providerStarts = 0;
  const stalledProvider: ProviderService = {
    streamAssistant: () =>
      Stream.fromEffect(
        Effect.sync(() => {
          providerStarts += 1;
          if (providerStarts === 2) {
            bothProvidersStarted.resolve();
          }
        }).pipe(
          Effect.zipRight(Effect.promise(() => releaseProviders.promise)),
          Effect.as({ _tag: "done" as const, stopReason: "done" as const }),
        ),
      ),
  };
  const stalledLayer = Layer.merge(
    FirstPartyDriverDefault().pipe(
      Layer.provide(
        Layer.mergeAll(
          JournalMemory(createMemoryJournalBacking()),
          Layer.succeed(Provider, stalledProvider),
          ToolRegistryLive([]),
        ),
      ),
    ),
    RpcInteractionsLive,
  );
  const writer: HeadWriter = {
    write: (text) =>
      Effect.sync(() => {
        const frame = JSON.parse(text) as Record<string, unknown>;
        if (frame.id === "prompt-concurrent-a") {
          promptAWritten.resolve();
        }
        if (frame.id === "prompt-concurrent-b") {
          promptBWritten.resolve();
        }
      }),
  };

  const exitCode = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const sessionA = yield* driver.createSession();
      const sessionB = yield* driver.createSession();
      const head = yield* runRpcHead({ input, writer }).pipe(Effect.fork);
      input.write(
        `${JSON.stringify({
          _tag: "prompt",
          content: "Stall session A.",
          id: "prompt-concurrent-a",
          sessionId: sessionA.id,
        })}\n`,
      );
      input.write(
        `${JSON.stringify({
          _tag: "prompt",
          content: "Stall session B.",
          id: "prompt-concurrent-b",
          sessionId: sessionB.id,
        })}\n`,
      );
      yield* Effect.promise(() => bothProvidersStarted.promise).pipe(Effect.timeout("200 millis"));
      releaseProviders.resolve();
      yield* Effect.promise(() => promptAWritten.promise);
      yield* Effect.promise(() => promptBWritten.promise);
      input.end();
      return yield* Fiber.join(head);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          releaseProviders.resolve();
          input.end();
        }),
      ),
      Effect.provide(stalledLayer),
    ),
  );

  expect(providerStarts).toBe(2);
  expect(exitCode).toBe(0);
});

test("rpc soaks interleaved Session queues, slow Progress, and an oversized final frame", async () => {
  const input = new PassThrough();
  const providerStreamsStarted = Promise.withResolvers<void>();
  const releaseProviders = Promise.withResolvers<void>();
  const releaseSlowProgressWrite = Promise.withResolvers<void>();
  const initialProgressWritten = Promise.withResolvers<void>();
  const promptsCompleted = Promise.withResolvers<void>();
  const slowProgressWriteStarted = Promise.withResolvers<void>();
  const subscribeResponseWritten = Promise.withResolvers<void>();
  const allResponsesWritten = Promise.withResolvers<void>();
  const fakeTransport = new FakeTransport();
  const expectedResponseIds = new Set([
    "model-soak-a",
    "model-soak-b",
    "model-soak-c",
    "prompt-soak-a",
    "prompt-soak-b",
    "prompt-soak-c",
    "snapshot-soak-a",
    "snapshot-soak-b",
    "snapshot-soak-c",
    "subscribe-soak",
  ]);
  const writtenResponseIds = new Set<string>();
  let promptCompleteCount = 0;
  let providerStartCount = 0;
  const providerStartLog: Array<string> = [];
  let slowProgressSessionId = "";
  let slowWriteUsed = false;
  const waitForSignal = (label: string, signal: Promise<void>) =>
    Effect.promise(() => signal).pipe(
      Effect.timeoutFail({
        duration: "2 seconds",
        onTimeout: () =>
          new Error(`Timed out waiting for ${label}. Provider starts: ${providerStartCount}.`),
      }),
    );
  const stalledProvider: ProviderService = {
    streamAssistant: (context) => {
      const promptContent = context.find((item) => item.role === "user")?.content ?? "unknown";
      // Derive a stable per-Session label from prompt content for FIFO ordering.
      const label = promptContent.includes("Session A")
        ? "A"
        : promptContent.includes("Session B")
          ? "B"
          : promptContent.includes("Session C")
            ? "C"
            : `other:${promptContent.slice(0, 20)}`;
      providerStartLog.push(label);
      return Stream.fromEffect(
        Effect.sync(() => {
          providerStartCount += 1;
          if (providerStartCount === 3) {
            providerStreamsStarted.resolve();
          }
        }).pipe(Effect.as({ _tag: "textDelta" as const, text: "soak-delta-0\n" })),
      ).pipe(
        Stream.concat(
          Stream.fromIterable(
            Array.from({ length: 95 }, (_, index) => ({
              _tag: "textDelta" as const,
              text: `soak-delta-${index + 1}\n`,
            })),
          ),
        ),
        Stream.concat(
          Stream.fromEffect(
            Effect.promise(() => releaseProviders.promise).pipe(
              Effect.as({ _tag: "done" as const, stopReason: "done" as const }),
            ),
          ),
        ),
      );
    },
  };
  const stalledLayer = Layer.merge(
    FirstPartyDriverDefault().pipe(
      Layer.provide(
        Layer.mergeAll(
          JournalMemory(createMemoryJournalBacking()),
          Layer.succeed(Provider, stalledProvider),
          ToolRegistryLive([]),
        ),
      ),
    ),
    RpcInteractionsLive,
  );
  const writer: HeadWriter = {
    write: (text) =>
      Effect.promise(async () => {
        const frame = JSON.parse(text) as Record<string, unknown>;
        if (
          !slowWriteUsed &&
          frame._tag === "assistantText" &&
          frame.sessionId === slowProgressSessionId
        ) {
          slowWriteUsed = true;
          slowProgressWriteStarted.resolve();
          await releaseSlowProgressWrite.promise;
        }
        fakeTransport.capturedBytes.push(Buffer.from(text, "utf8"));
        if (frame._tag === "phaseChanged" && frame.sessionId === slowProgressSessionId) {
          initialProgressWritten.resolve();
        }
        if (typeof frame.id === "string" && expectedResponseIds.has(frame.id)) {
          writtenResponseIds.add(frame.id);
          if (frame.id === "subscribe-soak") {
            subscribeResponseWritten.resolve();
          }
          if (writtenResponseIds.size === expectedResponseIds.size) {
            allResponsesWritten.resolve();
          }
        }
      }),
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const sessionA = yield* driver.createSession();
      const sessionB = yield* driver.createSession();
      const sessionC = yield* driver.createSession();
      slowProgressSessionId = sessionA.id;
      const observedDriver = {
        ...driver,
        prompt: (...args: Parameters<typeof driver.prompt>) =>
          driver.prompt(...args).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                promptCompleteCount += 1;
                if (promptCompleteCount === 3) {
                  promptsCompleted.resolve();
                }
              }),
            ),
          ),
      } satisfies typeof driver;
      const head = yield* runRpcHead({ input, writer }).pipe(
        Effect.provide(Layer.succeed(Driver, observedDriver)),
        Effect.fork,
      );
      const send = (frame: Record<string, unknown>): void => {
        input.write(`${JSON.stringify(frame)}\n`);
      };

      send({ _tag: "subscribe-progress", id: "subscribe-soak", sessionId: sessionA.id });
      yield* waitForSignal("the subscribe response", subscribeResponseWritten.promise);
      yield* waitForSignal("initial Progress", initialProgressWritten.promise);

      send({
        _tag: "prompt",
        content: "Stall Session A.",
        id: "prompt-soak-a",
        sessionId: sessionA.id,
      });
      send({
        _tag: "prompt",
        content: "Stall Session B.",
        id: "prompt-soak-b",
        sessionId: sessionB.id,
      });
      send({
        _tag: "set-model",
        id: "model-soak-a",
        model: "provider/soak-a",
        sessionId: sessionA.id,
      });
      send({
        _tag: "prompt",
        content: "Stall Session C.",
        id: "prompt-soak-c",
        sessionId: sessionC.id,
      });
      send({ _tag: "get-snapshot", id: "snapshot-soak-b", sessionId: sessionB.id });
      send({
        _tag: "set-model",
        id: "model-soak-c",
        model: "provider/soak-c",
        sessionId: sessionC.id,
      });
      send({ _tag: "get-snapshot", id: "snapshot-soak-a", sessionId: sessionA.id });
      send({
        _tag: "set-model",
        id: "model-soak-b",
        model: "provider/soak-b",
        sessionId: sessionB.id,
      });
      send({ _tag: "get-snapshot", id: "snapshot-soak-c", sessionId: sessionC.id });

      yield* waitForSignal("3 Provider streams", providerStreamsStarted.promise);
      releaseProviders.resolve();
      yield* waitForSignal("the slow Progress write", slowProgressWriteStarted.promise);
      yield* waitForSignal("3 completed prompts", promptsCompleted.promise);
      releaseSlowProgressWrite.resolve();
      yield* waitForSignal("all correlated responses", allResponsesWritten.promise);

      send({
        _tag: "prompt",
        content: "x".repeat(MAX_RPC_FRAME_BYTES + 1),
        id: "oversized-soak",
        sessionId: sessionA.id,
      });
      const exitCode = yield* Fiber.join(head).pipe(Effect.timeout("2 seconds"));
      return { exitCode, sessionA, sessionB, sessionC };
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          releaseProviders.resolve();
          releaseSlowProgressWrite.resolve();
          input.end();
        }),
      ),
      Effect.provide(stalledLayer),
    ),
  );

  const stdout = Buffer.concat(fakeTransport.capturedBytes).toString("utf8");
  const stdoutLines = stdout.trimEnd().split("\n");
  const frames = stdoutLines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const outputChunks = fakeTransport.capturedBytes.map((b) => b.toString("utf8"));
  const correlatedIds = frames.flatMap((frame) =>
    typeof frame.id === "string" && expectedResponseIds.has(frame.id) ? [frame.id] : [],
  );
  const responseOrderFor = (sessionId: string): ReadonlyArray<string> =>
    frames.flatMap((frame) => {
      const resultFrame =
        typeof frame.result === "object" && frame.result !== null
          ? (frame.result as Record<string, unknown>)
          : undefined;
      return resultFrame?.sessionId === sessionId && typeof frame.id === "string" ? [frame.id] : [];
    });

  // === Tightened core assertions (no loose equalities) ===
  expect(result.exitCode).toStrictEqual(0);
  expect(providerStartCount).toStrictEqual(3);
  expect(providerStartLog).toHaveLength(3);
  // FIFO per Session via transport queue: each Session's provider start appears at most once; Set(["A","B","C"]) via transport ordering.
  expect(new Set(providerStartLog)).toStrictEqual(new Set(["A", "B", "C"]));
  // Also verify transport's per-Session FIFO via captured frame order (transport queue guarantees ordering).
  const sessionAFrames = frames.filter(
    (f) =>
      (f as Record<string, unknown>).result !== undefined &&
      ((f as Record<string, unknown>).result as Record<string, unknown>).sessionId ===
        result.sessionA.id,
  );
  expect(sessionAFrames.length).toBeGreaterThan(0);
  expect(slowWriteUsed).toStrictEqual(true);
  // Correlated ids must be exactly the expected set, no extra/missing, strict length.
  expect(correlatedIds).toHaveLength(expectedResponseIds.size);
  expect(new Set(correlatedIds)).toStrictEqual(expectedResponseIds);
  expect(new Set(correlatedIds).size).toStrictEqual(expectedResponseIds.size);
  expect(responseOrderFor(result.sessionA.id)).toStrictEqual([
    "subscribe-soak",
    "prompt-soak-a",
    "model-soak-a",
    "snapshot-soak-a",
  ]);
  expect(responseOrderFor(result.sessionB.id)).toStrictEqual([
    "prompt-soak-b",
    "snapshot-soak-b",
    "model-soak-b",
  ]);
  expect(responseOrderFor(result.sessionC.id)).toStrictEqual([
    "prompt-soak-c",
    "model-soak-c",
    "snapshot-soak-c",
  ]);
  // progressDropped must be a bounded integer >0, not any Number.
  const dropped = frames.find((f) => (f as Record<string, unknown>)._tag === "progressDropped") as
    | Record<string, unknown>
    | undefined;
  expect(dropped).toBeDefined();
  expect(typeof dropped?.count).toBe("number");
  expect(Number.isInteger(dropped?.count)).toBe(true);
  expect((dropped?.count as number) > 0).toBe(true);
  expect(dropped?.sessionId).toStrictEqual(result.sessionA.id);
  // Oversized frame must be a typed protocol_error with malformed_frame and byte limit in message.
  const oversizedError = frames.find(
    (f) => typeof (f as Record<string, unknown>).error === "object",
  ) as Record<string, unknown> | undefined;
  expect(oversizedError).toBeDefined();
  const oversizeErr = (oversizedError?.error ?? {}) as Record<string, unknown>;
  expect(oversizeErr.code).toStrictEqual("protocol_error");
  expect((oversizeErr.details as Record<string, unknown>)?.reason).toStrictEqual("malformed_frame");
  expect(String(oversizeErr.message)).toContain(String(MAX_RPC_FRAME_BYTES));
  // Every writer chunk must be LF-terminated and respect the byte bound.
  expect(outputChunks.every((chunk) => chunk.endsWith("\n"))).toStrictEqual(true);
  // FakeTransport capturedBytes: each Buffer LF-terminated, Buffer provenance, total decodes to same frames.
  const rawStdout = Buffer.concat(fakeTransport.capturedBytes);
  expect(rawStdout.length).toStrictEqual(Buffer.byteLength(stdout, "utf8"));
  expect(rawStdout.toString("utf8")).toStrictEqual(stdout);
  // Also verify FakeTransport decode via transport yields same frames (Buffer → string strictEqual).
  const decodedViaFake = fakeTransport.decodeCaptured();
  expect(decodedViaFake).toStrictEqual(frames);
  for (const buf of fakeTransport.capturedBytes) {
    expect(buf.length > 0).toStrictEqual(true);
    expect(buf[buf.length - 1]).toStrictEqual(0x0a); // LF
    expect(buf.length).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES + 1 + 128); // frame + newline + JSON overhead slack
    // Each buffer must decode to exactly one LF-terminated JSON line.
    const text = buf.toString("utf8");
    expect(text.endsWith("\n")).toStrictEqual(true);
    expect(() => JSON.parse(text.trimEnd())).not.toThrow();
  }
  expect(frames).toHaveLength(stdoutLines.length);
  // Byte-boundary frame integrity: re-chunk raw bytes at arbitrary byte offsets and re-parse must yield identical frames.
  const reparseWithChunkSize = async (byteChunkSize: number) => {
    const chunks: Array<Buffer> = [];
    for (let offset = 0; offset < rawStdout.length; offset += byteChunkSize) {
      chunks.push(rawStdout.subarray(offset, Math.min(offset + byteChunkSize, rawStdout.length)));
    }
    const inputStream = Readable.from(chunks);
    const reparsed = await Effect.runPromise(Stream.runCollect(strictLfFrames(inputStream)));
    const lines = Array.from(reparsed, (f) => JSON.parse(f) as Record<string, unknown>);
    expect(lines).toHaveLength(frames.length);
    expect(lines).toStrictEqual(frames);
  };
  // Deterministic byte-boundary sizes: 1-byte, 7-byte, 13-byte, 256-byte, and 1024-byte torn frames.
  await reparseWithChunkSize(1);
  await reparseWithChunkSize(7);
  await reparseWithChunkSize(13);
  await reparseWithChunkSize(256);
  await reparseWithChunkSize(1024);
  // Random-ish split: 3 + 5 + varying to cover UTF-8 boundary tearing (frames are ASCII but decoder must handle splits).
  const mixedChunks: Array<Buffer> = [];
  const pattern = [3, 5, 2, 11, 17];
  let pi = 0;
  for (let offset = 0; offset < rawStdout.length; ) {
    const size = pattern[pi % pattern.length] ?? 1;
    pi += 1;
    mixedChunks.push(rawStdout.subarray(offset, Math.min(offset + size, rawStdout.length)));
    offset += size;
  }
  {
    const mixedStream = Readable.from(mixedChunks);
    const reparsed = await Effect.runPromise(Stream.runCollect(strictLfFrames(mixedStream)));
    const lines = Array.from(reparsed, (f) => JSON.parse(f) as Record<string, unknown>);
    expect(lines).toStrictEqual(frames);
  }
  // Each frame's raw byte length (without trailing LF) must be <= MAX_RPC_FRAME_BYTES
  for (const line of stdoutLines) {
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES);
  }
}, 10_000);

test("rpc EOF interrupts a waiting prompt handler without cancelling accepted kernel work", async () => {
  const input = new PassThrough();
  const providerEntered = Promise.withResolvers<void>();
  const releaseProvider = Promise.withResolvers<void>();
  const output: Array<Record<string, unknown>> = [];
  const stalledProvider: ProviderService = {
    streamAssistant: () =>
      Stream.fromEffect(
        Effect.sync(() => providerEntered.resolve()).pipe(
          Effect.as({ _tag: "textDelta" as const, text: "Accepted before EOF." }),
        ),
      ).pipe(
        Stream.concat(
          Stream.fromEffect(
            Effect.promise(() => releaseProvider.promise).pipe(
              Effect.as({ _tag: "done" as const, stopReason: "done" as const }),
            ),
          ),
        ),
      ),
  };
  const stalledLayer = Layer.merge(
    FirstPartyDriverDefault().pipe(
      Layer.provide(
        Layer.mergeAll(
          JournalMemory(createMemoryJournalBacking()),
          Layer.succeed(Provider, stalledProvider),
          ToolRegistryLive([]),
        ),
      ),
    ),
    RpcInteractionsLive,
  );
  const writer: HeadWriter = {
    write: (text) =>
      Effect.sync(() => {
        output.push(JSON.parse(text) as Record<string, unknown>);
      }),
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      const head = yield* runRpcHead({ input, writer }).pipe(Effect.fork);
      input.write(
        `${JSON.stringify({
          _tag: "prompt",
          content: "Keep working after the connection closes.",
          id: "prompt-before-eof",
          sessionId: session.id,
        })}\n`,
      );
      yield* Effect.promise(() => providerEntered.promise);
      input.end();
      const earlyExit = yield* Effect.raceFirst(
        Fiber.join(head).pipe(Effect.map((exitCode) => exitCode as number | undefined)),
        Effect.sleep("200 millis").pipe(Effect.as(undefined)),
      );
      releaseProvider.resolve();
      const exitCode = earlyExit ?? (yield* Fiber.join(head));
      const settledSnapshot = yield* driver.getSnapshot(session.id);
      return { earlyExit, exitCode, settledSnapshot };
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          releaseProvider.resolve();
          input.end();
        }),
      ),
      Effect.provide(stalledLayer),
    ),
  );

  expect(result.earlyExit).toBe(0);
  expect(result.exitCode).toBe(0);
  expect(result.settledSnapshot.entries).toContainEqual(
    expect.objectContaining({
      kind: "message",
      payload: expect.objectContaining({ role: "assistant", stopReason: "done" }),
    }),
  );
  expect(output).toEqual([]);
});

test("rpc.frame spans describe session, queue depth, and control bypass", async () => {
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
        traceId: "rpc-captured",
      } satisfies Tracer.Span;
    },
  });
  const traceLayer = Layer.merge(Layer.setTracer(tracer), Layer.setTracerEnabled(true));
  const capture = captureWriter();

  const sessionId = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      const input = Readable.from(
        `${[
          { _tag: "list", id: "trace-list" },
          { _tag: "get-snapshot", id: "trace-session", sessionId: session.id },
          { _tag: "abort", id: "trace-control", sessionId: session.id },
        ]
          .map((frame) => JSON.stringify(frame))
          .join("\n")}\n`,
      );
      yield* runRpcHead({ input, writer: capture.writer });
      return session.id;
    }).pipe(Effect.provide(Layer.merge(rpcDriverLayer, traceLayer))),
  );

  const frameSpans = spans.filter((span) => span.name === "rpc.frame");
  const listSpan = frameSpans.find((span) => span.attributes.get("command") === "list");
  const sessionSpan = frameSpans.find((span) => span.attributes.get("command") === "get-snapshot");
  const controlSpan = frameSpans.find((span) => span.attributes.get("command") === "abort");
  expect(listSpan?.attributes.get("bypass")).toBe(false);
  expect(listSpan?.attributes.get("queueDepth")).toBe(0);
  expect(listSpan?.attributes.get("session")).toBe("sessionless");
  expect(sessionSpan?.attributes.get("bypass")).toBe(false);
  expect(sessionSpan?.attributes.get("queueDepth")).toBe(0);
  expect(sessionSpan?.attributes.get("session")).toBe(sessionId);
  expect(controlSpan?.attributes.get("bypass")).toBe(true);
  expect(controlSpan?.attributes.get("queueDepth")).toBe(0);
  expect(controlSpan?.attributes.get("session")).toBe("control");
});

test("rpc attach and detach normalize Snapshot attached state per connection", async () => {
  const capture = captureWriter();

  await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      const input = Readable.from(
        `${[
          { _tag: "attach", id: "attach-1", sessionId: session.id },
          { _tag: "get-snapshot", id: "snapshot-1", sessionId: session.id },
          { _tag: "detach", id: "detach-1", sessionId: session.id },
          { _tag: "get-snapshot", id: "snapshot-2", sessionId: session.id },
        ]
          .map((frame) => JSON.stringify(frame))
          .join("\n")}\n`,
      );

      const exitCode = yield* runRpcHead({ input, writer: capture.writer });
      expect(exitCode).toBe(0);
    }).pipe(Effect.provide(rpcDriverLayer)),
  );

  expect(capture.lines()).toMatchObject([
    { id: "attach-1", result: { _tag: "snapshot", attached: true } },
    { id: "snapshot-1", result: { _tag: "snapshot", attached: true } },
    { id: "detach-1", result: { _tag: "snapshot", attached: false } },
    { id: "snapshot-2", result: { _tag: "snapshot", attached: false } },
  ]);
});

test("rpc attach installs its interactive head before writing the response", async () => {
  const input = new PassThrough();
  const attachResponseReached = Promise.withResolvers<void>();
  const releaseAttachResponse = Promise.withResolvers<void>();
  const interactionRequestWritten = Promise.withResolvers<void>();
  const writer: HeadWriter = {
    write: (text) => {
      const frame = JSON.parse(text) as Record<string, unknown>;
      if (frame.id === "attach-before-response") {
        return Effect.sync(() => attachResponseReached.resolve()).pipe(
          Effect.zipRight(Effect.promise(() => releaseAttachResponse.promise)),
        );
      }
      if (frame._tag === "interaction-request") {
        interactionRequestWritten.resolve();
      }
      return Effect.void;
    },
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const interactions = yield* RpcInteractions;
      const session = yield* driver.createSession();
      const head = yield* runRpcHead({ input, writer }).pipe(Effect.fork);
      input.write(
        `${JSON.stringify({
          _tag: "attach",
          id: "attach-before-response",
          interactive: true,
          sessionId: session.id,
        })}\n`,
      );
      yield* Effect.promise(() => attachResponseReached.promise);
      const pending = yield* interactions
        .request(session.id, {
          _tag: "interaction-request",
          fallback: { kind: "confirm", value: false },
          id: "interaction-after-attach-response",
          kind: "confirm",
          prompt: "Was the interactive head installed?",
          timeoutMs: 20,
        })
        .pipe(Effect.fork);
      const earlyResolution = yield* Effect.raceFirst(
        Fiber.join(pending).pipe(
          Effect.map((resolution) => resolution as typeof resolution | undefined),
        ),
        Effect.sleep("40 millis").pipe(Effect.as(undefined)),
      );
      releaseAttachResponse.resolve();
      if (earlyResolution !== undefined) {
        input.end();
        yield* Fiber.join(head);
        return { earlyResolution, resolution: earlyResolution };
      }
      yield* Effect.promise(() => interactionRequestWritten.promise).pipe(
        Effect.timeout("200 millis"),
      );
      yield* interactions.respond({
        _tag: "interaction-response",
        id: "interaction-after-attach-response",
        kind: "confirm",
        value: true,
      });
      const resolution = yield* Fiber.join(pending);
      input.end();
      yield* Fiber.join(head);
      return { earlyResolution, resolution };
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          releaseAttachResponse.resolve();
          input.end();
        }),
      ),
      Effect.provide(rpcDriverLayer),
    ),
  );

  expect(result.earlyResolution).toBeUndefined();
  expect(result.resolution).toMatchObject({
    response: { id: "interaction-after-attach-response", value: true },
    source: "head",
  });
});

test("rpc invoke-command routes a Plugin Command end to end", async () => {
  const capture = captureWriter();

  await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      const input = Readable.from(
        `${[
          {
            _tag: "invoke-command",
            args: { name: "RPC Session" },
            id: "invoke-1",
            name: "session-name",
            sessionId: session.id,
          },
          { _tag: "get-snapshot", id: "snapshot-1", sessionId: session.id },
        ]
          .map((frame) => JSON.stringify(frame))
          .join("\n")}\n`,
      );

      yield* runRpcHead({ input, writer: capture.writer });
    }).pipe(Effect.provide(rpcDriverLayer)),
  );

  expect(capture.lines()).toMatchObject([
    {
      id: "invoke-1",
      result: { _tag: "commandInvoked", commandName: "session-name", value: null },
    },
    {
      id: "snapshot-1",
      result: {
        _tag: "snapshot",
        entries: [
          expect.objectContaining({ kind: "session_root" }),
          expect.objectContaining({ kind: "session_name", payload: { name: "RPC Session" } }),
        ],
        name: "RPC Session",
      },
    },
  ]);
});

test("rpc interaction request round-trips through an attached interactive Head", async () => {
  const input = new PassThrough();
  const attached = Promise.withResolvers<void>();
  const requestWritten = Promise.withResolvers<void>();
  const output: Array<Record<string, unknown>> = [];
  const writer: HeadWriter = {
    write: (text) =>
      Effect.sync(() => {
        const frame = JSON.parse(text) as Record<string, unknown>;
        output.push(frame);
        if (frame.id === "attach-1") {
          attached.resolve();
        }
        if (frame._tag === "interaction-request") {
          requestWritten.resolve();
        }
      }),
  };

  const resolution = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const interactions = yield* RpcInteractions;
      const session = yield* driver.createSession();
      const head = yield* runRpcHead({ input, writer }).pipe(Effect.fork);

      input.write(
        `${JSON.stringify({
          _tag: "attach",
          id: "attach-1",
          interactive: true,
          sessionId: session.id,
        })}\n`,
      );
      yield* Effect.promise(() => attached.promise);
      const pending = yield* interactions
        .request(session.id, {
          _tag: "interaction-request",
          fallback: { kind: "confirm", value: false },
          id: "interaction-1",
          kind: "confirm",
          prompt: "Continue?",
          timeoutMs: 1_000,
        })
        .pipe(Effect.fork);
      yield* Effect.promise(() => requestWritten.promise);

      input.write(
        `${JSON.stringify({
          _tag: "interaction-response",
          id: "interaction-1",
          kind: "confirm",
          value: true,
        })}\n`,
      );
      const result = yield* Effect.fromFiber(pending);
      input.end();
      yield* Effect.fromFiber(head);
      return result;
    }).pipe(Effect.provide(rpcDriverLayer)),
  );

  expect(output).toContainEqual({
    _tag: "interaction-request",
    fallback: { kind: "confirm", value: false },
    id: "interaction-1",
    kind: "confirm",
    prompt: "Continue?",
    timeoutMs: 1_000,
  });
  expect(resolution).toEqual({
    response: {
      _tag: "interaction-response",
      id: "interaction-1",
      kind: "confirm",
      value: true,
    },
    source: "head",
  });
});

test("rpc interaction response resolves while the session turn is still running", async () => {
  const input = new PassThrough();
  const attached = Promise.withResolvers<void>();
  const providerEntered = Promise.withResolvers<void>();
  const releaseProvider = Promise.withResolvers<void>();
  const requestWritten = Promise.withResolvers<void>();
  const promptWritten = Promise.withResolvers<void>();
  const stalledProvider: ProviderService = {
    streamAssistant: () =>
      Stream.fromEffect(
        Effect.sync(() => providerEntered.resolve()).pipe(
          Effect.as({ _tag: "textDelta" as const, text: "Waiting for interaction." }),
        ),
      ).pipe(
        Stream.concat(
          Stream.fromEffect(
            Effect.promise(() => releaseProvider.promise).pipe(
              Effect.as({ _tag: "done" as const, stopReason: "done" as const }),
            ),
          ),
        ),
      ),
  };
  const stalledLayer = Layer.merge(
    FirstPartyDriverDefault().pipe(
      Layer.provide(
        Layer.mergeAll(
          JournalMemory(createMemoryJournalBacking()),
          Layer.succeed(Provider, stalledProvider),
          ToolRegistryLive([]),
        ),
      ),
    ),
    RpcInteractionsLive,
  );
  const writer: HeadWriter = {
    write: (text) =>
      Effect.sync(() => {
        const frame = JSON.parse(text) as Record<string, unknown>;
        if (frame.id === "attach-running-interaction") {
          attached.resolve();
        }
        if (frame._tag === "interaction-request") {
          requestWritten.resolve();
        }
        if (frame.id === "prompt-running-interaction") {
          promptWritten.resolve();
        }
      }),
  };

  const resolution = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const interactions = yield* RpcInteractions;
      const session = yield* driver.createSession();
      const head = yield* runRpcHead({ input, writer }).pipe(Effect.fork);
      input.write(
        `${JSON.stringify({
          _tag: "attach",
          id: "attach-running-interaction",
          interactive: true,
          sessionId: session.id,
        })}\n`,
      );
      yield* Effect.promise(() => attached.promise);
      input.write(
        `${JSON.stringify({
          _tag: "prompt",
          content: "Keep this turn active.",
          id: "prompt-running-interaction",
          sessionId: session.id,
        })}\n`,
      );
      yield* Effect.promise(() => providerEntered.promise);
      const pending = yield* interactions
        .request(session.id, {
          _tag: "interaction-request",
          fallback: { kind: "confirm", value: false },
          id: "interaction-during-turn",
          kind: "confirm",
          prompt: "Continue the active turn?",
          timeoutMs: 5_000,
        })
        .pipe(Effect.fork);
      yield* Effect.promise(() => requestWritten.promise);
      input.write(
        `${JSON.stringify({
          _tag: "interaction-response",
          id: "interaction-during-turn",
          kind: "confirm",
          value: true,
        })}\n`,
      );
      const result = yield* Fiber.join(pending).pipe(Effect.timeout("200 millis"));
      releaseProvider.resolve();
      yield* Effect.promise(() => promptWritten.promise);
      input.end();
      yield* Fiber.join(head);
      return result;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          releaseProvider.resolve();
          input.end();
        }),
      ),
      Effect.provide(stalledLayer),
    ),
  );

  expect(resolution).toEqual({
    response: {
      _tag: "interaction-response",
      id: "interaction-during-turn",
      kind: "confirm",
      value: true,
    },
    source: "head",
  });
});

test("rpc interaction timeout resolves the declared fallback and reports InteractionTimeout", async () => {
  const resolution = await Effect.runPromise(
    Effect.gen(function* () {
      const interactions = yield* RpcInteractions;
      return yield* interactions.request("session-timeout", {
        _tag: "interaction-request",
        fallback: { kind: "input", value: "fallback text" },
        id: "interaction-timeout",
        kind: "input",
        prompt: "Supply text.",
        timeoutMs: 20,
      });
    }).pipe(Effect.provide(RpcInteractionsLive)),
  );

  expect(resolution).toMatchObject({
    error: {
      _tag: "InteractionTimeout",
      requestId: "interaction-timeout",
      timeoutMs: 20,
    },
    response: {
      _tag: "interaction-response",
      id: "interaction-timeout",
      kind: "input",
      value: "fallback text",
    },
    source: "fallback",
  });
  expect(resolution.error).toBeInstanceOf(InteractionTimeout);
});

test("concurrent interaction responses atomically claim one pending request", async () => {
  const outcomes = await Effect.runPromise(
    Effect.gen(function* () {
      const interactions = yield* RpcInteractions;
      const requestSent = yield* Deferred.make<void>();
      yield* interactions.attach("session-atomic-response", {
        send: () => Deferred.succeed(requestSent, undefined).pipe(Effect.asVoid),
      });
      const pending = yield* interactions
        .request("session-atomic-response", {
          _tag: "interaction-request",
          fallback: { kind: "confirm", value: false },
          id: "interaction-atomic-response",
          kind: "confirm",
          prompt: "Choose exactly one response.",
          timeoutMs: 5_000,
        })
        .pipe(Effect.forkDaemon);
      yield* Deferred.await(requestSent);

      const responses = yield* Effect.forEach(
        [true, false],
        (value) =>
          Effect.yieldNow().pipe(
            Effect.zipRight(
              Effect.either(
                interactions.respond({
                  _tag: "interaction-response",
                  id: "interaction-atomic-response",
                  kind: "confirm",
                  value,
                }),
              ),
            ),
            Effect.withMaxOpsBeforeYield(16),
          ),
        { concurrency: "unbounded" },
      );
      yield* Fiber.join(pending).pipe(Effect.timeout("200 millis"));
      return responses;
    }).pipe(Effect.provide(RpcInteractionsLive)),
  );

  const winners = outcomes.filter(Either.isRight);
  const losers = outcomes.filter(Either.isLeft);
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  expect(losers[0]?.left).toBeInstanceOf(ProtocolError);
  expect(losers[0]?.left.message).toContain("has no pending request");
});

test("rpc Head detach mid-interaction resolves the declared fallback", async () => {
  const input = new PassThrough();
  const attached = Promise.withResolvers<void>();
  const requestWritten = Promise.withResolvers<void>();
  const writer: HeadWriter = {
    write: (text) =>
      Effect.sync(() => {
        const frame = JSON.parse(text) as Record<string, unknown>;
        if (frame.id === "attach-detach") {
          attached.resolve();
        }
        if (frame._tag === "interaction-request") {
          requestWritten.resolve();
        }
      }),
  };

  const resolution = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const interactions = yield* RpcInteractions;
      const session = yield* driver.createSession();
      const head = yield* runRpcHead({ input, writer }).pipe(Effect.fork);
      input.write(
        `${JSON.stringify({
          _tag: "attach",
          id: "attach-detach",
          interactive: true,
          sessionId: session.id,
        })}\n`,
      );
      yield* Effect.promise(() => attached.promise);
      const pending = yield* interactions
        .request(session.id, {
          _tag: "interaction-request",
          fallback: { kind: "select", value: "safe" },
          id: "interaction-detach",
          kind: "select",
          options: [
            { label: "Safe", value: "safe" },
            { label: "Fast", value: "fast" },
          ],
          prompt: "Choose a mode.",
          timeoutMs: 5_000,
        })
        .pipe(Effect.fork);
      yield* Effect.promise(() => requestWritten.promise);
      input.write(`${JSON.stringify({ _tag: "detach", id: "detach-1", sessionId: session.id })}\n`);

      const result = yield* Effect.raceFirst(
        Effect.fromFiber(pending).pipe(Effect.map((value) => value as typeof value | undefined)),
        Effect.sleep("200 millis").pipe(Effect.as(undefined)),
      );
      input.end();
      yield* Effect.fromFiber(head);
      return result;
    }).pipe(Effect.provide(rpcDriverLayer)),
  );

  expect(resolution).toMatchObject({
    error: { _tag: "InteractionTimeout", requestId: "interaction-detach", timeoutMs: 5_000 },
    response: {
      _tag: "interaction-response",
      id: "interaction-detach",
      kind: "select",
      value: "safe",
    },
    source: "fallback",
  });
});

test("a newly attaching rpc Head receives the current Snapshot plus pending interactions", async () => {
  const input = new PassThrough();
  const requestWritten = Promise.withResolvers<void>();
  const output: Array<Record<string, unknown>> = [];
  const writer: HeadWriter = {
    write: (text) =>
      Effect.sync(() => {
        const frame = JSON.parse(text) as Record<string, unknown>;
        output.push(frame);
        if (frame._tag === "interaction-request") {
          requestWritten.resolve();
        }
      }),
  };

  await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const interactions = yield* RpcInteractions;
      const session = yield* driver.createSession();
      const pending = yield* interactions
        .request(session.id, {
          _tag: "interaction-request",
          fallback: { kind: "confirm", value: false },
          id: "interaction-pending",
          kind: "confirm",
          prompt: "Continue?",
          timeoutMs: 5_000,
        })
        .pipe(Effect.fork);
      const head = yield* runRpcHead({ input, writer }).pipe(Effect.fork);

      input.write(
        `${JSON.stringify({
          _tag: "attach",
          id: "attach-pending",
          interactive: true,
          sessionId: session.id,
        })}\n`,
      );
      yield* Effect.promise(() => requestWritten.promise);
      input.write(
        `${JSON.stringify({
          _tag: "interaction-response",
          id: "interaction-pending",
          kind: "confirm",
          value: true,
        })}\n`,
      );
      yield* Effect.fromFiber(pending);
      input.end();
      yield* Effect.fromFiber(head);
    }).pipe(Effect.provide(rpcDriverLayer)),
  );

  expect(output.slice(0, 2)).toMatchObject([
    {
      id: "attach-pending",
      result: { _tag: "snapshot", attached: true, phase: "IDLE" },
    },
    {
      _tag: "interaction-request",
      id: "interaction-pending",
      kind: "confirm",
    },
  ]);
});

test("rpc Progress uses bounded sliding buffers while Snapshots stay authoritative and report drops", async () => {
  const burstProvider: ProviderService = {
    streamAssistant: () =>
      Stream.fromIterable([
        ...Array.from({ length: 32 }, (_, index) => ({
          _tag: "textDelta" as const,
          text: `${index},`,
        })),
        { _tag: "done" as const, stopReason: "done" as const },
      ]),
  };
  const burstLayer = Layer.merge(
    FirstPartyDriverDefault({ progressCapacity: 2 }).pipe(
      Layer.provide(
        Layer.mergeAll(
          JournalMemory(createMemoryJournalBacking()),
          Layer.succeed(Provider, burstProvider),
          ToolRegistryLive([]),
        ),
      ),
    ),
    RpcInteractionsLive,
  );
  const input = new PassThrough();
  const progressBlocked = Promise.withResolvers<void>();
  const releaseProgress = Promise.withResolvers<void>();
  const dropsWritten = Promise.withResolvers<void>();
  const snapshotWritten = Promise.withResolvers<void>();
  const output: Array<Record<string, unknown>> = [];
  let blocked = false;
  const writer: HeadWriter = {
    write: (text) => {
      const frame = JSON.parse(text) as Record<string, unknown>;
      output.push(frame);
      if (frame._tag === "progressDropped") {
        dropsWritten.resolve();
      }
      if (frame.id === "snapshot-after-drops") {
        snapshotWritten.resolve();
      }
      if (!blocked && frame._tag === "phaseChanged") {
        blocked = true;
        progressBlocked.resolve();
        return Effect.promise(() => releaseProgress.promise);
      }
      return Effect.void;
    },
  };

  const authoritative = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      const head = yield* runRpcHead({ input, writer }).pipe(Effect.fork);
      input.write(
        `${JSON.stringify({
          _tag: "subscribe-progress",
          id: "subscribe-1",
          sessionId: session.id,
        })}\n`,
      );
      yield* Effect.promise(() => progressBlocked.promise);
      yield* driver.prompt(session.id, "Generate Progress.");
      const snapshot = yield* driver.getSnapshot(session.id);
      releaseProgress.resolve();
      yield* Effect.promise(() => dropsWritten.promise);
      input.write(
        `${JSON.stringify({
          _tag: "get-snapshot",
          id: "snapshot-after-drops",
          sessionId: session.id,
        })}\n`,
      );
      yield* Effect.promise(() => snapshotWritten.promise);
      input.end();
      yield* Effect.fromFiber(head);
      return snapshot;
    }).pipe(Effect.provide(burstLayer)),
  );

  const dropped = output.find((frame) => frame._tag === "progressDropped");
  const snapshot = output.find((frame) => frame.id === "snapshot-after-drops") as {
    readonly result?: { readonly revision?: number };
  };
  expect(dropped).toMatchObject({ sessionId: authoritative.sessionId });
  expect(dropped?.count).toBeTypeOf("number");
  expect(dropped?.count).toBeGreaterThan(0);
  expect(snapshot.result?.revision).toBe(authoritative.revision);
});

test("rpc frame errors emit typed ProtocolError diagnostics without killing the connection", async () => {
  const capture = captureWriter();
  const input = Readable.from(
    `${[
      '{"_tag":"list"',
      JSON.stringify({
        _tag: "interaction-response",
        id: "bad-response",
        kind: "confirm",
        value: true,
      }),
      JSON.stringify({ _tag: "list", id: "list-after-errors" }),
    ].join("\n")}\n`,
  );

  const exitCode = await Effect.runPromise(
    runRpcHead({ input, writer: capture.writer }).pipe(Effect.provide(rpcDriverLayer)),
  );

  expect(exitCode).toBe(0);
  expect(capture.lines()).toMatchObject([
    {
      error: {
        code: "protocol_error",
        details: { reason: "malformed_frame" },
      },
    },
    {
      error: {
        code: "protocol_error",
        details: { reason: "phase_invalid_command" },
      },
      id: "bad-response",
    },
    {
      id: "list-after-errors",
      result: { _tag: "sessionList", sessions: expect.any(Array) },
    },
  ]);
});

test("rpc operational failures are correlated per frame and isolated between Sessions", async () => {
  const capture = captureWriter();

  await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const sessionA = yield* driver.createSession();
      const sessionB = yield* driver.createSession();
      const missingSessionId = "missing-rpc-session";
      const input = Readable.from(
        `${[
          {
            _tag: "set-model",
            expectedRevision: 999,
            id: "stale-a",
            model: "provider/stale",
            sessionId: sessionA.id,
          },
          { _tag: "get-snapshot", id: "missing", sessionId: missingSessionId },
          {
            _tag: "invoke-command",
            args: {},
            id: "unknown-command",
            name: "does-not-exist",
            sessionId: sessionA.id,
          },
          {
            _tag: "invoke-command",
            args: { name: "x".repeat(201) },
            id: "invalid-session-name",
            name: "session-name",
            sessionId: sessionA.id,
          },
          {
            _tag: "set-model",
            id: "model-b",
            model: "provider/session-b",
            sessionId: sessionB.id,
          },
          { _tag: "get-snapshot", id: "snapshot-a", sessionId: sessionA.id },
          { _tag: "get-snapshot", id: "snapshot-b", sessionId: sessionB.id },
        ]
          .map((frame) => JSON.stringify(frame))
          .join("\n")}\n`,
      );

      const exitCode = yield* runRpcHead({ input, writer: capture.writer });
      expect(exitCode).toBe(0);
    }).pipe(Effect.provide(rpcDriverLayer)),
  );

  expect(capture.lines()).toMatchObject([
    {
      error: {
        code: "stale_revision",
        details: { actual: expect.any(Number), expected: 999, tag: "StaleRevision" },
      },
      id: "stale-a",
    },
    {
      error: {
        code: "session_not_found",
        details: { sessionId: "missing-rpc-session", tag: "MailboxSessionNotFound" },
      },
      id: "missing",
    },
    {
      error: {
        code: "invoke_command_error",
        details: {
          commandName: "does-not-exist",
          reason: "command_not_found",
          tag: "InvokeCommandError",
        },
      },
      id: "unknown-command",
    },
    {
      error: {
        code: "invoke_command_error",
        details: {
          commandName: "session-name",
          reason: "arguments_invalid",
          tag: "InvokeCommandError",
        },
      },
      id: "invalid-session-name",
    },
    {
      id: "model-b",
      result: { _tag: "snapshot", model: "provider/session-b" },
    },
    { id: "snapshot-a", result: { _tag: "snapshot", sessionId: expect.any(String) } },
    {
      id: "snapshot-b",
      result: {
        _tag: "snapshot",
        model: "provider/session-b",
        sessionId: expect.any(String),
      },
    },
  ]);
});

test("rpc queue overflow emits a bounded wire error and keeps accepted work and the connection alive", async () => {
  const input = new PassThrough();
  const setModelStarted = Promise.withResolvers<void>();
  const releaseSetModel = Promise.withResolvers<void>();
  const overflowWritten = Promise.withResolvers<void>();
  const listWritten = Promise.withResolvers<void>();
  const lastAcceptedWritten = Promise.withResolvers<void>();
  const output: Array<Record<string, unknown>> = [];
  const writer: HeadWriter = {
    write: (text) =>
      Effect.sync(() => {
        const frame = JSON.parse(text) as Record<string, unknown>;
        output.push(frame);
        if (frame.id === "queue-overflow") {
          overflowWritten.resolve();
        }
        if (frame.id === "list-after-overflow") {
          listWritten.resolve();
        }
        if (frame.id === `queue-accepted-${RPC_SESSION_QUEUE_CAPACITY - 1}`) {
          lastAcceptedWritten.resolve();
        }
      }),
  };

  const exitCode = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      const blockedDriver = {
        ...driver,
        setModel: (...args: Parameters<typeof driver.setModel>) =>
          Effect.sync(() => setModelStarted.resolve()).pipe(
            Effect.zipRight(Effect.promise(() => releaseSetModel.promise)),
            Effect.zipRight(driver.setModel(...args)),
          ),
      } satisfies typeof driver;
      const head = yield* runRpcHead({ input, writer }).pipe(
        Effect.provide(Layer.merge(Layer.succeed(Driver, blockedDriver), RpcInteractionsLive)),
        Effect.fork,
      );
      input.write(
        `${JSON.stringify({
          _tag: "set-model",
          id: "queue-blocker",
          model: "provider/queue-blocker",
          sessionId: session.id,
        })}\n`,
      );
      yield* Effect.promise(() => setModelStarted.promise);
      for (let index = 0; index < RPC_SESSION_QUEUE_CAPACITY; index += 1) {
        input.write(
          `${JSON.stringify({
            _tag: "get-snapshot",
            id: `queue-accepted-${index}`,
            sessionId: session.id,
          })}\n`,
        );
      }
      input.write(
        `${JSON.stringify({
          _tag: "get-snapshot",
          id: "queue-overflow",
          sessionId: session.id,
        })}\n`,
      );
      yield* Effect.promise(() => overflowWritten.promise).pipe(Effect.timeout("200 millis"));
      input.write(`${JSON.stringify({ _tag: "list", id: "list-after-overflow" })}\n`);
      yield* Effect.promise(() => listWritten.promise).pipe(Effect.timeout("200 millis"));
      releaseSetModel.resolve();
      yield* Effect.promise(() => lastAcceptedWritten.promise);
      input.end();
      return yield* Fiber.join(head);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          releaseSetModel.resolve();
          input.end();
        }),
      ),
      Effect.provide(rpcDriverLayer),
    ),
  );

  const overflow = output.find((frame) => frame.id === "queue-overflow");
  expect(overflow).toMatchObject({
    error: {
      code: "protocol_error",
      message: expect.stringContaining("session_queue"),
    },
    id: "queue-overflow",
  });
  expect((overflow?.error as { readonly message?: unknown } | undefined)?.message).toContain("64");
  expect(output.find((frame) => frame.id === "list-after-overflow")).toMatchObject({
    result: { _tag: "sessionList" },
  });
  expect(
    output.filter((frame) =>
      typeof frame.id === "string" ? frame.id.startsWith("queue-accepted-") : false,
    ),
  ).toHaveLength(RPC_SESSION_QUEUE_CAPACITY);
  expect(exitCode).toBe(0);
});

test("rpc converts a driver defect into a correlated error and continues", async () => {
  const capture = captureWriter();

  await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      let listCount = 0;
      const defectDriver = {
        ...driver,
        listSessions: () => {
          listCount += 1;
          return listCount === 1
            ? Effect.die(new Error("Injected rpc driver defect."))
            : driver.listSessions();
        },
      };
      const input = Readable.from(
        `${[
          { _tag: "list", id: "defect" },
          { _tag: "list", id: "after-defect" },
        ]
          .map((frame) => JSON.stringify(frame))
          .join("\n")}\n`,
      );

      const exitCode = yield* runRpcHead({ input, writer: capture.writer }).pipe(
        Effect.provide(Layer.merge(Layer.succeed(Driver, defectDriver), RpcInteractionsLive)),
      );
      expect(exitCode).toBe(0);
    }).pipe(Effect.provide(rpcDriverLayer)),
  );

  expect(capture.lines()).toMatchObject([
    {
      error: {
        code: "protocol_error",
        details: { kind: "defect", tag: "Error" },
        message: "Injected rpc driver defect.",
      },
      id: "defect",
    },
    {
      id: "after-defect",
      result: { _tag: "sessionList", sessions: expect.any(Array) },
    },
  ]);
});

test("rpc writer failure terminates the head before another frame is read", async () => {
  const failure = new HeadWriteError({
    cause: new Error("rpc sink closed"),
    message: "Head output failed: rpc sink closed",
  });
  const firstWriteStarted = Promise.withResolvers<void>();
  const promptHandlerInterrupted = Promise.withResolvers<void>();
  const promptHandlerSettled = Promise.withResolvers<void>();
  const providerEntered = Promise.withResolvers<void>();
  const releaseProvider = Promise.withResolvers<void>();
  const terminalErrors: Array<Record<string, unknown>> = [];
  const input = new PassThrough();
  const stalledProvider: ProviderService = {
    streamAssistant: () =>
      Stream.fromEffect(
        Effect.sync(() => providerEntered.resolve()).pipe(
          Effect.zipRight(Effect.promise(() => releaseProvider.promise)),
          Effect.as({ _tag: "done" as const, stopReason: "done" as const }),
        ),
      ),
  };
  const stalledLayer = Layer.merge(
    FirstPartyDriverDefault().pipe(
      Layer.provide(
        Layer.mergeAll(
          JournalMemory(createMemoryJournalBacking()),
          Layer.succeed(Provider, stalledProvider),
          ToolRegistryLive([]),
        ),
      ),
    ),
    RpcInteractionsLive,
  );
  const writer: HeadWriter = {
    write: () =>
      Effect.sync(() => firstWriteStarted.resolve()).pipe(Effect.zipRight(Effect.fail(failure))),
  };
  const errorWriter: HeadWriter = {
    write: (text) =>
      Effect.sync(() => {
        terminalErrors.push(JSON.parse(text) as Record<string, unknown>);
      }),
  };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      let listCalls = 0;
      const countedDriver = {
        ...driver,
        listSessions: () => {
          listCalls += 1;
          return driver.listSessions();
        },
        prompt: (...args: Parameters<typeof driver.prompt>) =>
          driver.prompt(...args).pipe(
            Effect.onInterrupt(() => Effect.sync(() => promptHandlerInterrupted.resolve())),
            Effect.ensuring(Effect.sync(() => promptHandlerSettled.resolve())),
          ),
      } satisfies typeof driver;
      const head = yield* runRpcHead({ errorWriter, input, writer }).pipe(
        Effect.provide(Layer.merge(Layer.succeed(Driver, countedDriver), RpcInteractionsLive)),
        Effect.fork,
      );
      input.write(
        `${JSON.stringify({
          _tag: "prompt",
          content: "Remain in flight when another handler loses its writer.",
          id: "writer-failure-stalled-prompt",
          sessionId: session.id,
        })}\n`,
      );
      yield* Effect.promise(() => providerEntered.promise);
      input.write(`${JSON.stringify({ _tag: "list", id: "writer-failure-first" })}\n`);
      yield* Effect.promise(() => firstWriteStarted.promise);
      const exitCode = yield* Effect.raceFirst(
        Fiber.join(head).pipe(Effect.map((code) => code as number | undefined)),
        Effect.sleep("200 millis").pipe(Effect.as(undefined)),
      );
      const handlerInterrupted = yield* Effect.raceFirst(
        Effect.promise(() => promptHandlerInterrupted.promise).pipe(Effect.as(true)),
        Effect.sleep("200 millis").pipe(Effect.as(false)),
      );
      const handlerSettled = yield* Effect.raceFirst(
        Effect.promise(() => promptHandlerSettled.promise).pipe(Effect.as(true)),
        Effect.sleep("200 millis").pipe(Effect.as(false)),
      );
      input.write(`${JSON.stringify({ _tag: "list", id: "writer-failure-unread" })}\n`);
      yield* Effect.yieldNow();
      yield* Effect.yieldNow();
      if (exitCode === undefined) {
        input.destroy();
        yield* Fiber.interruptFork(head);
      }
      releaseProvider.resolve();
      return { exitCode, handlerInterrupted, handlerSettled, listCalls };
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          releaseProvider.resolve();
          input.destroy();
        }),
      ),
      Effect.provide(stalledLayer),
    ),
  );

  expect(result.exitCode).toBe(4);
  expect(result.handlerSettled).toBe(true);
  expect(result.handlerInterrupted).toBe(true);
  expect(result.listCalls).toBe(1);
  expect(terminalErrors).toMatchObject([
    { _tag: "headError", error: { kind: "failure", tag: "HeadWriteError" } },
  ]);
});

test("rpc bounds a never-terminated frame and closes with a ProtocolError response", async () => {
  const capture = captureWriter();
  const input = Readable.from("x".repeat(MAX_RPC_FRAME_BYTES + 1));

  const exitCode = await Effect.runPromise(
    runRpcHead({ input, writer: capture.writer }).pipe(Effect.provide(rpcDriverLayer)),
  );

  expect(exitCode).toBe(0);
  expect(capture.lines()).toMatchObject([
    {
      error: {
        code: "protocol_error",
        details: { reason: "malformed_frame" },
        message: expect.stringContaining(String(MAX_RPC_FRAME_BYTES)),
      },
    },
  ]);
});

test("an external process completes a full tool-using Session through rpc pipes", async () => {
  const child = spawn(
    process.execPath,
    [new URL("../../test-fixtures/rpc-process.mjs", import.meta.url).pathname],
    {
      cwd: new URL("../../../..", import.meta.url).pathname,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let buffered = "";
  let stderr = "";
  const frames: Array<Record<string, unknown>> = [];
  const unreadFrames: Array<Record<string, unknown>> = [];
  const stdoutParseErrors: Array<unknown> = [];
  const waiters: Array<(frame: Record<string, unknown>) => void> = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    let separator = buffered.indexOf("\n");
    while (separator >= 0) {
      const line = buffered.slice(0, separator);
      buffered = buffered.slice(separator + 1);
      if (line.length > 0) {
        try {
          const frame = JSON.parse(line) as Record<string, unknown>;
          frames.push(frame);
          const waiter = waiters.shift();
          if (waiter === undefined) {
            unreadFrames.push(frame);
          } else {
            waiter(frame);
          }
        } catch (cause) {
          stdoutParseErrors.push(cause);
        }
      }
      separator = buffered.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const nextFrame = (): Promise<Record<string, unknown>> => {
    const unread = unreadFrames.shift();
    return unread === undefined
      ? new Promise((resolve) => waiters.push(resolve))
      : Promise.resolve(unread);
  };
  const send = (frame: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  };

  send({ _tag: "create", id: "create-process" });
  const created = await nextFrame();
  const sessionId = (created.result as { readonly sessionId?: unknown } | undefined)?.sessionId;
  expect(sessionId).toBeTypeOf("string");
  if (typeof sessionId !== "string") {
    throw new Error("RPC create response did not contain a Session id.");
  }

  child.stdin.write('{"_tag":"list"\n');
  expect(await nextFrame()).toMatchObject({ error: { code: "protocol_error" } });
  send({
    _tag: "invoke-command",
    args: {},
    id: "bad-command-process",
    name: "does-not-exist",
    sessionId,
  });
  expect(await nextFrame()).toMatchObject({
    error: { code: "invoke_command_error" },
    id: "bad-command-process",
  });
  send({ _tag: "get-snapshot", id: "missing-process", sessionId: "missing-process-session" });
  expect(await nextFrame()).toMatchObject({
    error: { code: "session_not_found" },
    id: "missing-process",
  });

  send({ _tag: "attach", id: "attach-process", sessionId });
  await nextFrame();
  send({ _tag: "subscribe-progress", id: "subscribe-process", sessionId });
  await nextFrame();
  send({ _tag: "prompt", content: "Use the Tool.", id: "prompt-process", sessionId });

  let promptResponse: Record<string, unknown> | undefined;
  while (promptResponse === undefined) {
    const frame = await nextFrame();
    if (frame.id === "prompt-process") {
      promptResponse = frame;
    }
  }
  child.stdin.end();
  const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));

  expect(exitCode).toBe(0);
  expect(buffered).toBe("");
  expect(stdoutParseErrors).toEqual([]);
  expect(stderr).toContain("RPC protocol frame rejected.");
  expect(stderr).toContain("RPC command failed.");
  expect(stderr).toContain("RPC fixture provider warning.");
  expect(frames).toContainEqual(
    expect.objectContaining({ _tag: "toolStarted", name: "read-file", sessionId }),
  );
  expect(frames).toContainEqual(
    expect.objectContaining({ _tag: "toolCompleted", isError: false, sessionId }),
  );
  expect(promptResponse).toMatchObject({
    id: "prompt-process",
    result: {
      _tag: "snapshot",
      attached: true,
      entries: expect.arrayContaining([
        expect.objectContaining({
          kind: "message",
          payload: expect.objectContaining({
            content: "Tool answer: contents:fixture.txt",
            role: "assistant",
          }),
        }),
      ]),
      phase: "IDLE",
      sessionId,
    },
  });
}, 30_000);

test("rpc routes the remaining M20 Driver commands with correlated protocol results", async () => {
  const capture = captureWriter();

  await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* driver.createSession();
      const input = Readable.from(
        `${[
          {
            _tag: "set-model",
            id: "model-remaining",
            model: "provider/rpc-model",
            sessionId: session.id,
          },
          {
            _tag: "set-thinking",
            id: "thinking-remaining",
            sessionId: session.id,
            thinkingLevel: "high",
          },
          {
            _tag: "branch",
            id: "branch-remaining",
            sessionId: session.id,
            toEntryId: session.leaf.id,
          },
          {
            _tag: "fork",
            fromEntryId: session.leaf.id,
            id: "fork-remaining",
            sessionId: session.id,
          },
          { _tag: "resume", id: "resume-remaining", sessionId: session.id },
          { _tag: "abort", id: "abort-remaining", sessionId: session.id },
          {
            _tag: "steer",
            content: "No Turn is active.",
            id: "steer-remaining",
            sessionId: session.id,
          },
          { _tag: "list", id: "list-remaining" },
        ]
          .map((frame) => JSON.stringify(frame))
          .join("\n")}\n`,
      );

      yield* runRpcHead({ input, writer: capture.writer });
    }).pipe(Effect.provide(rpcDriverLayer)),
  );

  expect(capture.lines()).toMatchObject([
    {
      id: "model-remaining",
      result: { _tag: "snapshot", model: "provider/rpc-model" },
    },
    {
      id: "thinking-remaining",
      result: { _tag: "snapshot", thinkingLevel: "high" },
    },
    {
      id: "branch-remaining",
      result: { _tag: "snapshot", sessionId: expect.any(String) },
    },
    {
      id: "fork-remaining",
      result: { _tag: "snapshot", sessionId: expect.any(String) },
    },
    {
      id: "resume-remaining",
      result: { _tag: "snapshot", sessionId: expect.any(String) },
    },
    {
      id: "abort-remaining",
      result: { _tag: "abortTurnNotAborted", aborted: false, reason: "none" },
    },
    {
      error: {
        code: "protocol_error",
        details: { reason: "phase_invalid_command" },
      },
      id: "steer-remaining",
    },
    {
      id: "list-remaining",
      result: { _tag: "sessionList", sessions: expect.any(Array) },
    },
  ]);
  expect(capture.lines()[2]?.result).not.toHaveProperty("model");
  expect(capture.lines()[2]?.result).not.toHaveProperty("thinkingLevel");
  expect(
    (capture.lines()[3]?.result as { readonly sessionId?: unknown } | undefined)?.sessionId,
  ).not.toBe(
    (capture.lines()[4]?.result as { readonly sessionId?: unknown } | undefined)?.sessionId,
  );
});
