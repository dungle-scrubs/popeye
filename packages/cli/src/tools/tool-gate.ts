/**
 * Owns ToolGateService deep module for vetting Tool calls (vet + diagnostics + generation-scoped Ref).
 * It exists to centralize gate branching, diagnostics, and generation-scoped session memory behind one seam.
 * Why this module: adapter was doing gate emit directly and vetting plugin owned closure Set per factory import, relying on ESM cacheKey for forget.
 * This module owns the ONE Ref<Set<string>> and clears it on GenerationSwap; no ESM cacheKey hack.
 * Not responsible for PluginInteractions transport (heads own that) or Hook emission (emitter owns that) beyond the vet seam.
 */

import type { CapabilityGrants, PluginGeneration } from "@pop-eye/plugins";
import { Context, Effect, Layer, Ref } from "effect";

export type GateDecision =
  | { readonly _tag: "Allowed"; readonly replacementArguments?: unknown }
  | { readonly _tag: "Rejected"; readonly plugin: string; readonly reason: string };

export interface ToolGateService {
  readonly clear: Effect.Effect<void>;
  readonly memoryRef: Ref.Ref<Set<string>>;
  readonly vet: (
    toolCallId: string,
    toolName: string,
    args: unknown,
    sessionId: string | undefined,
  ) => Effect.Effect<GateDecision>;
}

export class ToolGateServiceTag extends Context.Tag("@pop-eye/cli/ToolGateService")<
  ToolGateServiceTag,
  ToolGateService
>() {}

// Generation-scoped session memory: allowed (sessionId + toolName) pairs.
// Owned here, cleared on GenerationSwap, not per-factory closure.
export const toolGateSessionMemoryRef: Ref.Ref<Set<string>> = Effect.runSync(
  Ref.make(new Set<string>()),
);

export const clearToolGateSessionMemory: Effect.Effect<void> = Ref.set(
  toolGateSessionMemoryRef,
  new Set<string>(),
);

export const makeToolGateService = (options: {
  readonly generation: PluginGeneration;
  readonly grants: CapabilityGrants;
}): ToolGateService => {
  const { generation, grants } = options;
  const memoryRef = toolGateSessionMemoryRef;

  const vet: ToolGateService["vet"] = (toolCallId, toolName, args, sessionId) =>
    Effect.gen(function* () {
      const key = `${sessionId ?? "no-session"}:${toolName}`;
      const mem = yield* Ref.get(memoryRef);
      if (mem.has(key)) {
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

  const clear = Ref.set(memoryRef, new Set<string>());

  return { clear, memoryRef, vet };
};

export const ToolGateServiceLive = (options: {
  readonly generation: PluginGeneration;
  readonly grants: CapabilityGrants;
}): Layer.Layer<ToolGateServiceTag> =>
  Layer.succeed(ToolGateServiceTag, makeToolGateService(options));

export const onGenerationSwap: Effect.Effect<void> = clearToolGateSessionMemory;
