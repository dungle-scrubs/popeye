/**
 * Owns generation-scoped session memory for Tool vetting.
 * It exists so "allow for session" decisions are remembered per (sessionId, toolName) without
 * relying on ESM cache keys or per-factory closure Sets. The memory is generation-scoped:
 * it is cleared on GenerationSwap, so a new generation starts untrusted.
 * Why this module: tool-gate owned a global Ref via Effect.runSync and exported it, and
 * tool-vetting imported that Ref upward. This module is the single owner of the ONE
 * Ref<Set<string>>; both the gate and the vetting Plugin depend on this neutral seam,
 * not on each other. Not responsible for Hook emission (emitter owns that) or for
 * Tool execution (tool-batch owns that); it only owns the session allow-list.
 */

import { Effect, Ref } from "effect";

// The ONE generation-scoped session allow-list Ref. Cleared on generation swap.
// Exported for ToolInvocationPipeline's memoryRef member; all other access goes through the helpers below.
export const sessionMemoryRef: Ref.Ref<Set<string>> = Effect.runSync(Ref.make(new Set<string>()));

const keyOf = (sessionId: string | undefined, toolName: string): string =>
  `${sessionId ?? "no-session"}:${toolName}`;

export const hasToolSessionMemory = (
  sessionId: string | undefined,
  toolName: string,
): Effect.Effect<boolean> =>
  Ref.get(sessionMemoryRef).pipe(Effect.map((set) => set.has(keyOf(sessionId, toolName))));

export const rememberToolForSession = (
  sessionId: string | undefined,
  toolName: string,
): Effect.Effect<void> =>
  Ref.update(sessionMemoryRef, (set) => new Set([...set, keyOf(sessionId, toolName)]));

export const clearToolSessionMemory: Effect.Effect<void> = Ref.set(
  sessionMemoryRef,
  new Set<string>(),
);
