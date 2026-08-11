import { spawn } from "node:child_process";
import { PassThrough, Readable } from "node:stream";

import { createMemoryJournalBacking, JournalMemory } from "@peye/journal";
import { InteractionTimeout } from "@peye/protocol";
import { Effect, Layer, Stream } from "effect";
import { expect, test } from "vitest";

import {
  Driver,
  FirstPartyDriverDefault,
  Provider,
  type ProviderService,
  ToolRegistryLive,
} from "../compose.js";
import {
  MAX_RPC_FRAME_BYTES,
  RpcInteractions,
  RpcInteractionsLive,
  runRpcHead,
  strictLfFrames,
} from "./rpc.js";
import type { HeadWriter } from "./shared.js";

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
