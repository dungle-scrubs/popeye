/**
 * Owns generation-scoped session memory for Tool vetting.
 * It exists so "allow for session" decisions are remembered per (sessionId, toolName) without
 * relying on ESM cache keys or per-factory closure Sets. Entries are keyed by the generation whose gate recorded
 * them (CurrentToolGenerationFiberRef, set by ToolInvocationPipeline around each vet), so a new
 * generation starts untrusted and an old gate answered after a reload cannot authorize it (#93).
 * Why this module: tool-gate owned a global Ref via Effect.runSync and exported it, and
 * tool-vetting imported that Ref upward. This module is the single owner of the ONE
 * Ref<Set<string>>; both the gate and the vetting Plugin depend on this neutral seam,
 * not on each other. Not responsible for Hook emission (emitter owns that) or for
 * Tool execution (tool-batch owns that); it only owns the session allow-list.
 */

import { Effect, FiberRef, Option, Ref } from "effect";

// The ONE session allow-list Ref, keyed by generation.
// Exported for ToolInvocationPipeline's memoryRef member; all other access goes through the helpers below.
export const sessionMemoryRef: Ref.Ref<Set<string>> = Effect.runSync(Ref.make(new Set<string>()));

/** The generation whose tool-call gate is running; ToolInvocationPipeline.vet sets it (#93). */
export const CurrentToolGenerationFiberRef: FiberRef.FiberRef<Option.Option<string>> =
  FiberRef.unsafeMake<Option.Option<string>>(Option.none());

const keyOf = (generationId: string, sessionId: string | undefined, toolName: string): string =>
  JSON.stringify([generationId, sessionId ?? null, toolName]);

export const hasToolSessionMemory = (
  sessionId: string | undefined,
  toolName: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const generation = yield* FiberRef.get(CurrentToolGenerationFiberRef);
    if (Option.isNone(generation)) {
      return false;
    }
    const set = yield* Ref.get(sessionMemoryRef);
    return set.has(keyOf(generation.value, sessionId, toolName));
  });

export const rememberToolForSession = (
  sessionId: string | undefined,
  toolName: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const generation = yield* FiberRef.get(CurrentToolGenerationFiberRef);
    if (Option.isSome(generation)) {
      yield* Ref.update(
        sessionMemoryRef,
        (set) => new Set([...set, keyOf(generation.value, sessionId, toolName)]),
      );
    }
  });

export const forgetToolSessionMemoryForGeneration = (generationId: string): Effect.Effect<void> =>
  Ref.update(
    sessionMemoryRef,
    (set) =>
      new Set(
        [...set].filter((key) => {
          const [id] = JSON.parse(key) as [string, string | null, string];
          return id !== generationId;
        }),
      ),
  );

export const clearToolSessionMemory: Effect.Effect<void> = Ref.set(
  sessionMemoryRef,
  new Set<string>(),
);
