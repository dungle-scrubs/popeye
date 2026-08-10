/**
 * Owns bounded, interruption-safe execution of one assistant Tool call batch.
 * It exists so call-order durability is independent from completion order and Tool implementations.
 */

import { Cause, Chunk, Effect, Either, Option, ParseResult, Schema } from "effect";

import type { ToolError } from "./errors.js";
import { type ToolExecutionContext, ToolRegistry, type ToolResult } from "./tool.js";

export const DEFAULT_TOOL_CONCURRENCY = 4;
const MAX_CAUSE_DETAIL_LENGTH = 2_000;
const strict: { readonly onExcessProperty: "error" } = { onExcessProperty: "error" };

export interface ToolCall {
  readonly argumentsJson: string;
  readonly id: string;
  readonly name: string;
}

export interface ToolBatchOptions<E = never> {
  readonly concurrency?: number;
  readonly onToolCompleted?: (result: ToolBatchResult) => Effect.Effect<void, E>;
  readonly onToolStarted?: (call: ToolCall) => Effect.Effect<void, E>;
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

const bounded = (detail: string): string =>
  detail.length <= MAX_CAUSE_DETAIL_LENGTH
    ? detail
    : `${detail.slice(0, MAX_CAUSE_DETAIL_LENGTH)}...[truncated]`;

const failureContent = (call: ToolCall, cause: Cause.Cause<ToolError>): string => {
  if (Chunk.isNonEmpty(Cause.defects(cause))) {
    return `Tool ${call.name} failed with a defect:\n${bounded(Cause.pretty(cause))}`;
  }
  const failure = Option.getOrUndefined(Cause.failureOption(cause));
  return failure === undefined ? bounded(Cause.pretty(cause)) : failure.message;
};

const invalidArguments = (call: ToolCall, detail: string): ToolBatchResult =>
  errorResult(call, `Invalid arguments for tool ${call.name}: ${bounded(detail)}`);

const decodeArguments = (
  call: ToolCall,
  parameters: Schema.Schema<unknown>,
): Effect.Effect<unknown, ToolBatchResult> =>
  Effect.try({
    catch: (cause) =>
      invalidArguments(
        call,
        cause instanceof Error ? cause.message : Cause.pretty(Cause.fail(cause)),
      ),
    try: () => JSON.parse(call.argumentsJson) as unknown,
  }).pipe(
    Effect.flatMap((arguments_) =>
      Schema.decodeUnknown(
        parameters,
        strict,
      )(arguments_).pipe(
        Effect.mapError((error) =>
          invalidArguments(call, ParseResult.TreeFormatter.formatErrorSync(error)),
        ),
      ),
    ),
  );

const executeCall = <E>(
  call: ToolCall,
  context: ToolExecutionContext,
  onToolCompleted: ((result: ToolBatchResult) => Effect.Effect<void, E>) | undefined,
  onToolStarted: ((call: ToolCall) => Effect.Effect<void, E>) | undefined,
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry;
      yield* onToolStarted?.(call) ?? Effect.void;
      const tool = registry.get(call.name);
      const result =
        tool === undefined
          ? errorResult(call, `Unknown tool: ${call.name}.`)
          : yield* Effect.either(decodeArguments(call, tool.parameters)).pipe(
              Effect.flatMap((decoded) =>
                Either.isLeft(decoded)
                  ? Effect.succeed(decoded.left)
                  : restore(Effect.scoped(tool.execute(decoded.right, context))).pipe(
                      Effect.map((output) => ({ ...output, toolCallId: call.id })),
                      Effect.catchAllCause((cause) => {
                        if (Cause.isInterruptedOnly(cause)) {
                          return Effect.failCause(cause as Cause.Cause<never>);
                        }
                        const result = errorResult(call, failureContent(call, cause));
                        return Chunk.isNonEmpty(Cause.defects(cause))
                          ? Effect.logError("Tool execution failed with a defect", cause).pipe(
                              Effect.as(result),
                            )
                          : Effect.succeed(result);
                      }),
                    ),
              ),
            );
      yield* Effect.annotateCurrentSpan({
        outcome: result.isError === true ? "error" : "success",
      });
      yield* onToolCompleted?.(result) ?? Effect.void;
      return result;
    }),
  ).pipe(
    Effect.withSpan("kernel.tool", {
      attributes: { name: call.name, sessionId: context.sessionId, toolCallId: call.id },
    }),
  );

export const executeToolBatch = <E = never>(
  calls: ReadonlyArray<ToolCall>,
  context: ToolExecutionContext,
  options: ToolBatchOptions<E> = {},
): Effect.Effect<ToolBatchResults, E, ToolRegistry> => {
  const configuredConcurrency = options.concurrency ?? DEFAULT_TOOL_CONCURRENCY;
  if (!Number.isSafeInteger(configuredConcurrency) || configuredConcurrency < 1) {
    throw new RangeError("Tool concurrency must be a positive safe integer.");
  }
  return Effect.gen(function* () {
    const registry = yield* ToolRegistry;
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
};
