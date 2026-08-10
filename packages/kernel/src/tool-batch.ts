/**
 * Owns bounded, interruption-safe execution of one assistant Tool call batch.
 * It exists so call-order durability is independent from completion order and Tool implementations.
 */

import { Cause, Effect, Either, Schema } from "effect";

import type { ToolError } from "./errors.js";
import { type ToolExecutionContext, ToolRegistry, type ToolResult } from "./tool.js";

export const DEFAULT_TOOL_CONCURRENCY = 4;

export interface ToolCall {
  readonly argumentsJson: string;
  readonly id: string;
  readonly name: string;
}

export interface ToolBatchOptions {
  readonly concurrency?: number;
  readonly onToolCompleted?: (result: ToolBatchResult) => Effect.Effect<void>;
  readonly onToolStarted?: (call: ToolCall) => Effect.Effect<void>;
}

export interface ToolBatchResult extends ToolResult {
  readonly toolCallId: string;
}

export interface ToolBatchResults {
  readonly concurrency: number;
  readonly mode: "parallel" | "sequential";
  readonly results: ReadonlyArray<ToolBatchResult>;
}

const errorResult = (call: ToolCall, content: string): ToolBatchResult => ({
  content,
  isError: true,
  toolCallId: call.id,
});

const failureContent = (failure: ToolError | unknown): string =>
  failure &&
  typeof failure === "object" &&
  "message" in failure &&
  typeof failure.message === "string"
    ? failure.message
    : Cause.pretty(Cause.fail(failure));

const decodeArguments = (
  call: ToolCall,
  parameters: Schema.Schema<unknown>,
): Effect.Effect<unknown, ToolBatchResult> =>
  Effect.try({
    catch: () => errorResult(call, `Invalid arguments for tool ${call.name}.`),
    try: () => JSON.parse(call.argumentsJson) as unknown,
  }).pipe(
    Effect.flatMap((arguments_) =>
      Schema.decodeUnknown(parameters)(arguments_).pipe(
        Effect.mapError(() => errorResult(call, `Invalid arguments for tool ${call.name}.`)),
      ),
    ),
  );

const executeCall = (
  call: ToolCall,
  context: ToolExecutionContext,
  onToolCompleted: ((result: ToolBatchResult) => Effect.Effect<void>) | undefined,
  onToolStarted: ((call: ToolCall) => Effect.Effect<void>) | undefined,
) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry;
    yield* onToolStarted?.(call) ?? Effect.void;
    const tool = registry.get(call.name);
    if (tool === undefined) {
      const result = errorResult(call, `Unknown tool: ${call.name}.`);
      yield* onToolCompleted?.(result) ?? Effect.void;
      return result;
    }
    const decoded = yield* Effect.either(decodeArguments(call, tool.parameters));
    const result = Either.isLeft(decoded)
      ? decoded.left
      : yield* Effect.scoped(tool.execute(decoded.right, context)).pipe(
          Effect.map((output) => ({ ...output, toolCallId: call.id })),
          Effect.catchAll((failure) => Effect.succeed(errorResult(call, failureContent(failure)))),
        );
    yield* Effect.annotateCurrentSpan({ outcome: result.isError === true ? "error" : "success" });
    yield* onToolCompleted?.(result) ?? Effect.void;
    return result;
  }).pipe(
    Effect.withSpan("kernel.tool", {
      attributes: { name: call.name, sessionId: context.sessionId, toolCallId: call.id },
    }),
  );

export const executeToolBatch = (
  calls: ReadonlyArray<ToolCall>,
  context: ToolExecutionContext,
  options: ToolBatchOptions = {},
) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry;
    const configuredConcurrency = options.concurrency ?? DEFAULT_TOOL_CONCURRENCY;
    const mode = calls.some((call) => registry.get(call.name)?.executionMode === "sequential")
      ? "sequential"
      : "parallel";
    const concurrency = mode === "sequential" ? 1 : configuredConcurrency;
    return yield* Effect.forEach(
      calls,
      (call) => executeCall(call, context, options.onToolCompleted, options.onToolStarted),
      { concurrency },
    ).pipe(
      Effect.map((results) => ({ concurrency, mode, results }) satisfies ToolBatchResults),
      Effect.withSpan("kernel.toolBatch", { attributes: { concurrency, mode } }),
    );
  });
