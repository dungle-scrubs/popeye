/**
 * Owns ToolInvocationPipeline deep module for vetting Tool calls.
 * It exists to consolidate capability-undeclared filtering, shadowing resolution,
 * gate emission, session-scoped allow-list, and diagnostics behind one seam.
 * Why this module: before, adapter owned shadowing, tool-gate owned a global Ref,
 * and tool-vetting imported that Ref upward. The pipeline owns the ONE
 * generation-scoped Ref via ToolSessionMemory and shares ONE gate instance per
 * generation+grants across all adapted Tools, so "allow for session" is coherent
 * and a new vetting policy plugs as another Hook without touching the cache.
 * Not responsible for Tool execution (kernel/tool-batch owns that) or for
 * PluginInteractions transport (heads own that); it only decides allow/block/replace.
 */

import type { CapabilityGrants, PluginGeneration } from "@dungle-scrubs/popeye-plugins";
import { Context, Effect, Layer, type Ref } from "effect";

import {
  clearToolSessionMemory,
  hasToolSessionMemory,
  sessionMemoryRef,
} from "./tool-session-memory.js";

export type GateDecision =
  | { readonly _tag: "Allowed"; readonly replacementArguments?: unknown }
  | { readonly _tag: "Rejected"; readonly plugin: string; readonly reason: string };

export interface ToolInvocationPipeline {
  readonly clear: Effect.Effect<void>;
  readonly memoryRef: Ref.Ref<Set<string>>;
  readonly vet: (
    toolCallId: string,
    toolName: string,
    args: unknown,
    sessionId: string | undefined,
  ) => Effect.Effect<GateDecision>;
}

export class ToolInvocationPipelineTag extends Context.Tag(
  "@dungle-scrubs/popeye/ToolInvocationPipeline",
)<ToolInvocationPipelineTag, ToolInvocationPipeline>() {}

export const makeToolInvocationPipeline = (options: {
  readonly generation: PluginGeneration;
  readonly grants: CapabilityGrants;
}): ToolInvocationPipeline => {
  const { generation, grants } = options;
  const memoryRef = sessionMemoryRef;

  const vet: ToolInvocationPipeline["vet"] = (toolCallId, toolName, args, sessionId) =>
    Effect.gen(function* () {
      const cached = yield* hasToolSessionMemory(sessionId, toolName);
      if (cached) {
        yield* Effect.logInfo(
          JSON.stringify({
            diagnostic: "tool_gate_decision",
            generationId: generation.id,
            outcome: "cached",
            plugin: "tool-vetting",
            sessionId,
            toolCallId,
            toolName,
            type: "tool_gate_decision",
          }),
        ).pipe(
          Effect.annotateLogs({
            diagnostic: "tool_gate_decision",
            generationId: generation.id,
            outcome: "cached",
            plugin: "tool-vetting",
            sessionId: sessionId ?? "none",
            toolCallId,
            toolName,
          }),
          Effect.ignore,
        );
        return { _tag: "Allowed" as const };
      }

      const gateInput = {
        arguments: args,
        toolCallId,
        toolName,
        ...(sessionId === undefined ? {} : { sessionId }),
      };

      const gateResult = yield* generation.emitter
        .emit("tool-call-gate", gateInput as never, grants)
        .pipe(Effect.either);

      if (gateResult._tag === "Left") {
        const error = gateResult.left as unknown as {
          readonly _tag?: string;
          readonly plugin?: string;
          readonly reason?: string;
          readonly message?: string;
        };
        if (
          error !== null &&
          typeof error === "object" &&
          "_tag" in error &&
          (error as { _tag: string })._tag === "GateRejected"
        ) {
          const plugin = (error as { plugin?: string }).plugin ?? "unknown";
          const reason =
            (error as { reason?: string }).reason ??
            (error as { message?: string }).message ??
            `Tool ${toolName} was rejected by vetting gate.`;
          yield* Effect.logWarning(
            JSON.stringify({
              diagnostic: "tool_gate_rejected",
              generationId: generation.id,
              plugin,
              reason,
              sessionId,
              toolCallId,
              toolName,
              type: "tool_gate_rejected",
            }),
          ).pipe(
            Effect.annotateLogs({
              diagnostic: "tool_gate_rejected",
              generationId: generation.id,
              plugin,
              reason,
              sessionId: sessionId ?? "none",
              toolCallId,
              toolName,
            }),
            Effect.ignore,
          );
          yield* Effect.logInfo(
            JSON.stringify({
              diagnostic: "tool_gate_decision",
              generationId: generation.id,
              outcome: "deny",
              plugin,
              reason,
              sessionId,
              toolCallId,
              toolName,
              type: "tool_gate_decision",
            }),
          ).pipe(
            Effect.annotateLogs({
              diagnostic: "tool_gate_decision",
              generationId: generation.id,
              outcome: "deny",
              plugin,
              reason,
              sessionId: sessionId ?? "none",
              toolCallId,
              toolName,
            }),
            Effect.ignore,
          );
          return { _tag: "Rejected" as const, plugin, reason };
        }
        yield* Effect.logWarning(
          JSON.stringify({
            diagnostic: "tool_gate_error",
            error: String(error),
            generationId: generation.id,
            toolCallId,
            toolName,
            type: "tool_gate_error",
          }),
        ).pipe(Effect.ignore);
        yield* Effect.logInfo(
          JSON.stringify({
            diagnostic: "tool_gate_decision",
            generationId: generation.id,
            outcome: "allow",
            plugin: "unknown",
            sessionId,
            toolCallId,
            toolName,
            type: "tool_gate_decision",
          }),
        ).pipe(
          Effect.annotateLogs({
            diagnostic: "tool_gate_decision",
            generationId: generation.id,
            outcome: "allow",
            plugin: "unknown",
            sessionId: sessionId ?? "none",
            toolCallId,
            toolName,
          }),
          Effect.ignore,
        );
        return { _tag: "Allowed" as const };
      }

      const hookResult = gateResult.right as unknown;
      if (
        hookResult !== undefined &&
        hookResult !== null &&
        typeof hookResult === "object" &&
        "arguments" in (hookResult as Record<string, unknown>) &&
        "toolCallId" in (hookResult as Record<string, unknown>) &&
        "toolName" in (hookResult as Record<string, unknown>)
      ) {
        const replacement = hookResult as { readonly arguments: unknown };
        yield* Effect.logInfo(
          JSON.stringify({
            diagnostic: "tool_gate_replaced",
            generationId: generation.id,
            toolCallId,
            toolName,
            type: "tool_gate_replaced",
          }),
        ).pipe(Effect.ignore);
        yield* Effect.logInfo(
          JSON.stringify({
            diagnostic: "tool_gate_decision",
            generationId: generation.id,
            outcome: "allow",
            plugin: "unknown",
            sessionId,
            toolCallId,
            toolName,
            type: "tool_gate_decision",
          }),
        ).pipe(
          Effect.annotateLogs({
            diagnostic: "tool_gate_decision",
            generationId: generation.id,
            outcome: "allow",
            plugin: "unknown",
            sessionId: sessionId ?? "none",
            toolCallId,
            toolName,
          }),
          Effect.ignore,
        );
        return {
          _tag: "Allowed" as const,
          replacementArguments: replacement.arguments,
        };
      }

      yield* Effect.logInfo(
        JSON.stringify({
          diagnostic: "tool_gate_decision",
          generationId: generation.id,
          outcome: "allow",
          plugin: "unknown",
          sessionId,
          toolCallId,
          toolName,
          type: "tool_gate_decision",
        }),
      ).pipe(
        Effect.annotateLogs({
          diagnostic: "tool_gate_decision",
          generationId: generation.id,
          outcome: "allow",
          plugin: "unknown",
          sessionId: sessionId ?? "none",
          toolCallId,
          toolName,
        }),
        Effect.ignore,
      );
      return { _tag: "Allowed" as const };
    }).pipe(
      Effect.withSpan("tool_gate.vet", { attributes: { toolName, generationId: generation.id } }),
    );

  const clear = clearToolSessionMemory;

  return { clear, memoryRef, vet };
};

export const ToolInvocationPipelineLive = (options: {
  readonly generation: PluginGeneration;
  readonly grants: CapabilityGrants;
}): Layer.Layer<ToolInvocationPipelineTag> =>
  Layer.succeed(ToolInvocationPipelineTag, makeToolInvocationPipeline(options));
