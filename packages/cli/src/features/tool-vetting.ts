/**
 * Owns the opt-in tool-vetting Plugin as a linkable module (second adapter for tool-call-gate).
 * It exists so a human can vet each Tool call via PluginInteractions: allow once, allow for session, or reject.
 * Why this module: provides the human vetting decision as a Hook contribution; session memory
 * itself lives in ToolSessionMemory's generation-scoped Ref, accessed via a neutral seam.
 * This module depends on ToolSessionMemory, not on ToolGateService, so the dependency
 * direction is Plugin -> memory, not Plugin -> gate.
 * Not responsible for transport (heads own that) or for Hook emission (emitter owns that); this module only owns the vetting prompt decision.
 */

import {
  DEFAULT_INTERACTION_TIMEOUT_MILLIS,
  defineHookContribution,
  PluginInteractions,
  type ToolCallGateHookInput,
  type ToolCallGateHookOutput,
} from "@pop-eye/plugins";
import { Effect } from "effect";

import { hasToolSessionMemory, rememberToolForSession } from "../tools/tool-session-memory.js";

const makeToolVettingPlugin = () => {
  const hookRun = (
    input: ToolCallGateHookInput,
  ): Effect.Effect<ToolCallGateHookOutput, unknown, PluginInteractions> =>
    Effect.gen(function* () {
      const allowed = yield* hasToolSessionMemory(input.sessionId, input.toolName);
      if (allowed) {
        yield* Effect.logInfo(
          JSON.stringify({
            diagnostic: "tool_vetting_allow_session_cached",
            sessionId: input.sessionId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            type: "tool_vetting_allow",
          }),
        ).pipe(
          Effect.annotateLogs({
            diagnostic: "tool_vetting_allow_session_cached",
            sessionId: input.sessionId ?? "none",
            toolCallId: input.toolCallId,
            toolName: input.toolName,
          }),
        );
        return { decision: "continue" } as ToolCallGateHookOutput;
      }

      const interactions = yield* PluginInteractions;
      const requestId = `tool-vetting-${input.toolCallId}-${Date.now().toString(36)}`;
      const resolution = yield* interactions.request({
        fallback: { kind: "select", value: "reject" },
        id: requestId,
        kind: "select",
        options: [
          { label: "Allow once", value: "allow-once" },
          { label: "Allow for session", value: "allow-for-session" },
          { label: "Reject", value: "reject" },
        ],
        prompt: `Tool "${input.toolName}" wants to run with arguments ${JSON.stringify(input.arguments)}. Allow?`,
        timeoutMs: DEFAULT_INTERACTION_TIMEOUT_MILLIS,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      });

      // The PluginInteractions live/null layers stamp pluginName and enforce timeout nesting,
      // so the fallback (reject) decides, not the hook timeout.
      const choice = (resolution.response as { readonly value: string }).value;

      if (choice === "reject") {
        yield* Effect.logWarning(
          JSON.stringify({
            diagnostic: "tool_vetting_rejected",
            plugin: "tool-vetting",
            reason: `Tool ${input.toolName} rejected by vetting gate.`,
            sessionId: input.sessionId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            type: "tool_vetting_rejected",
          }),
        ).pipe(
          Effect.annotateLogs({
            diagnostic: "tool_vetting_rejected",
            plugin: "tool-vetting",
            reason: `Tool ${input.toolName} rejected by vetting gate.`,
            sessionId: input.sessionId ?? "none",
            toolCallId: input.toolCallId,
            toolName: input.toolName,
          }),
        );
        return {
          decision: "block",
          reason: `Tool ${input.toolName} rejected by vetting gate.`,
        } as ToolCallGateHookOutput;
      }

      if (choice === "allow-for-session") {
        yield* rememberToolForSession(input.sessionId, input.toolName);
        yield* Effect.logInfo(
          JSON.stringify({
            diagnostic: "tool_vetting_allow_for_session",
            plugin: "tool-vetting",
            sessionId: input.sessionId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            type: "tool_vetting_allow",
          }),
        ).pipe(
          Effect.annotateLogs({
            diagnostic: "tool_vetting_allow_for_session",
            plugin: "tool-vetting",
            sessionId: input.sessionId ?? "none",
            toolCallId: input.toolCallId,
            toolName: input.toolName,
          }),
        );
        return { decision: "continue" } as ToolCallGateHookOutput;
      }

      // allow-once (also the path for any unexpected value, fail open to continue)
      yield* Effect.logInfo(
        JSON.stringify({
          diagnostic: "tool_vetting_allow_once",
          plugin: "tool-vetting",
          sessionId: input.sessionId,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          type: "tool_vetting_allow",
        }),
      ).pipe(
        Effect.annotateLogs({
          diagnostic: "tool_vetting_allow_once",
          plugin: "tool-vetting",
          sessionId: input.sessionId ?? "none",
          toolCallId: input.toolCallId,
          toolName: input.toolName,
        }),
      );
      return { decision: "continue" } as ToolCallGateHookOutput;
    });

  return {
    contributions: [
      defineHookContribution({
        mergeClass: "FirstWins",
        name: "tool-vetting-gate",
        point: "tool-call-gate",
        run: hookRun as (input: unknown) => Effect.Effect<unknown, unknown, PluginInteractions>,
      }),
    ],
    manifest: {
      capabilities: [{ name: "interaction" }],
      description:
        "Vets each Tool call with an interactive prompt: allow once, allow for session, or reject.",
      name: "tool-vetting",
      version: "1.0.0",
    },
  } as const;
};

export const toolVettingPlugin = makeToolVettingPlugin();

export const plugin = makeToolVettingPlugin;

export default makeToolVettingPlugin;
