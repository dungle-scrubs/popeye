import assert from "node:assert/strict";
import {
  createAssistantMessageEventStream,
  isRetryableAssistantError,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { Cause, Chunk, Data, Effect, Either, Exit, Fiber, Stream } from "effect";

class ProviderIterationError extends Data.TaggedError("ProviderIterationError")<{
  readonly cause: unknown;
}> {}

class ProviderTerminalError extends Data.TaggedError("ProviderTerminalError")<{
  readonly message: AssistantMessage;
}> {}

const usage = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input: 0,
  output: 0,
  totalTokens: 0,
} as const;

function message(
  stopReason: AssistantMessage["stopReason"],
  content: AssistantMessage["content"],
  errorMessage?: string,
): AssistantMessage {
  return {
    api: "openai-completions",
    content,
    errorMessage,
    model: "fixture-model",
    provider: "openai",
    role: "assistant",
    stopReason,
    timestamp: 0,
    usage,
  };
}

function asEffectStream(
  source: AssistantMessageEventStream,
): Stream.Stream<Exclude<AssistantMessageEvent, { readonly type: "error" }>, ProviderIterationError | ProviderTerminalError> {
  return Stream.fromAsyncIterable(
    source,
    (cause) => new ProviderIterationError({ cause }),
  ).pipe(
    Stream.mapEffect((event) =>
      event.type === "error"
        ? Effect.fail(new ProviderTerminalError({ message: event.error }))
        : Effect.succeed(event),
    ),
  );
}

function makeAssistantEventStream(): AssistantMessageEventStream {
  return createAssistantMessageEventStream();
}

async function collectSuccessFixture(): Promise<void> {
  const stream = makeAssistantEventStream();
  const partial = message("pending", []);
  const toolCall = { arguments: { city: "Bangkok" }, id: "tool-1", name: "weather", type: "toolCall" } as const;
  const final = message("toolUse", [
    { text: "hello", type: "text" },
    { thinking: "reason", type: "thinking" },
    toolCall,
  ]);

  const expectedTypes = [
    "start",
    "text_start",
    "text_delta",
    "text_end",
    "thinking_start",
    "thinking_delta",
    "thinking_end",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
    "done",
  ];

  stream.push({ partial, type: "start" });
  stream.push({ contentIndex: 0, partial, type: "text_start" });
  stream.push({ contentIndex: 0, delta: "hel", partial, type: "text_delta" });
  stream.push({ content: "hello", contentIndex: 0, partial, type: "text_end" });
  stream.push({ contentIndex: 1, partial, type: "thinking_start" });
  stream.push({ contentIndex: 1, delta: "rea", partial, type: "thinking_delta" });
  stream.push({ content: "reason", contentIndex: 1, partial, type: "thinking_end" });
  stream.push({ contentIndex: 2, partial, type: "toolcall_start" });
  stream.push({ contentIndex: 2, delta: '{"city":"Bang', partial, type: "toolcall_delta" });
  stream.push({ contentIndex: 2, partial, toolCall, type: "toolcall_end" });
  stream.push({ message: final, reason: "toolUse", type: "done" });

  const events = Chunk.toArray(await Effect.runPromise(Stream.runCollect(asEffectStream(stream))));
  assert.deepEqual(events.map((event) => event.type), expectedTypes);
  assert.equal(await stream.result(), final);
}

async function collectErrorFixture(): Promise<void> {
  const stream = makeAssistantEventStream();
  const partial = message("pending", []);
  const terminal = message("error", [], "temporary network timeout");
  stream.push({ partial, type: "start" });
  stream.push({ contentIndex: 0, partial, type: "text_start" });
  stream.push({ contentIndex: 0, delta: "partial", partial, type: "text_delta" });
  stream.push({ error: terminal, reason: "error", type: "error" });

  const result = await Effect.runPromise(Effect.either(Stream.runCollect(asEffectStream(stream))));
  assert.ok(Either.isLeft(result), "error terminal must fail in Effect's typed error channel");
  assert.ok(result.left instanceof ProviderTerminalError, "terminal failure must be ProviderTerminalError");
  assert.equal(result.left.message, terminal);
  assert.equal(await stream.result(), terminal);
  assert.equal(isRetryableAssistantError(terminal), true, "public retry classifier must accept the fixture");
}

async function collectAbortFixture(): Promise<void> {
  const stream = makeAssistantEventStream();
  const terminal = message("aborted", [], "request aborted by caller");
  stream.push({ partial: message("pending", []), type: "start" });
  stream.push({ error: terminal, reason: "aborted", type: "error" });

  const result = await Effect.runPromise(Effect.either(Stream.runCollect(asEffectStream(stream))));
  assert.ok(Either.isLeft(result));
  assert.ok(result.left instanceof ProviderTerminalError);
  assert.equal(result.left.message.stopReason, "aborted");
  assert.equal(await stream.result(), terminal);
}

async function testConsumerInterruption(): Promise<boolean> {
  const stream = makeAssistantEventStream();
  let producerContinuedAfterConsumerInterrupt = false;
  const producer = new Promise<void>((resolve) => {
    setTimeout(() => {
      producerContinuedAfterConsumerInterrupt = true;
      stream.push({ partial: message("pending", []), type: "start" });
      stream.push({ error: message("aborted", [], "test cleanup"), reason: "aborted", type: "error" });
      resolve();
    }, 20);
  });

  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const consumer = yield* Effect.fork(Stream.runDrain(asEffectStream(stream)));
      yield* Effect.sleep("2 millis");
      yield* Fiber.interrupt(consumer);
      return yield* Fiber.await(consumer);
    }),
  );
  assert.ok(Exit.isFailure(exit));
  assert.ok(Cause.isInterruptedOnly(exit.cause));
  await producer;
  return producerContinuedAfterConsumerInterrupt;
}

async function main(): Promise<void> {
  await collectSuccessFixture();
  await collectErrorFixture();
  await collectAbortFixture();
  const producerContinuedAfterConsumerInterrupt = await testConsumerInterruption();

  console.log(JSON.stringify({
    errorEncoding: "pass",
    interruption: producerContinuedAfterConsumerInterrupt ? "fail: producer continued after consumer interruption" : "pass",
    liveCall: "skipped: network access prohibited",
    orderingAndSettlement: "pass",
  }, null, 2));

  // pi-ai's public event-stream API exposes push/end/result but no cancellation hook.
  // This assertion intentionally makes the unsupported automatic-cancellation claim fail.
  assert.equal(producerContinuedAfterConsumerInterrupt, false, "consumer interruption must cancel the underlying producer");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
