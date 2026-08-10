/**
 * Owns the in-memory Journal adapter for fast behavior checks and local composition.
 * It exists to prove Journal rules from append-only content without file mechanics.
 */
import { Effect, Layer, Ref, Schema } from "effect";

import {
  availableSession,
  createJournalAdapter,
  type JournalAdapterState,
  type JournalPersistence,
} from "./adapter-core.js";
import { JournalError } from "./errors.js";
import { deriveSession, Journal } from "./journal.js";
import { EntryLineSchema, type JournalLine, JournalLineSchema, type SessionId } from "./shapes.js";

const memoryJournalBacking = Symbol("MemoryJournalBacking");

export interface MemoryJournalBacking {
  readonly [memoryJournalBacking]: Ref.Ref<ReadonlyArray<JournalLine>>;
}

const strict: { readonly onExcessProperty: "error" } = { onExcessProperty: "error" };
const decodeJournalLine = Schema.decodeUnknown(JournalLineSchema, strict);

const sessionLinesFor = (
  lines: ReadonlyArray<JournalLine>,
  sessionId: SessionId,
): ReadonlyArray<JournalLine> => lines.filter((line) => line.sessionId === sessionId);

const deriveState = (
  lines: ReadonlyArray<JournalLine>,
): Effect.Effect<JournalAdapterState, JournalError> =>
  Effect.gen(function* () {
    const sessions = new Map<SessionId, ReturnType<typeof availableSession>>();
    for (const sessionId of new Set(lines.map((line) => line.sessionId))) {
      const session = yield* deriveSession(sessionLinesFor(lines, sessionId));
      if (session !== undefined) {
        sessions.set(sessionId, availableSession(session));
      }
    }
    return { sessions };
  });

const memoryPersistence = (backing: MemoryJournalBacking): JournalPersistence => ({
  initializeSession: (sessionId, rootEntry) =>
    Ref.update(backing[memoryJournalBacking], (lines) => [
      ...lines,
      EntryLineSchema.make({ item: rootEntry, sessionId, type: "entry" }),
    ]),
  loadSession: (sessionId) =>
    Ref.get(backing[memoryJournalBacking]).pipe(
      Effect.flatMap((lines) => deriveSession(sessionLinesFor(lines, sessionId))),
      Effect.flatMap((session) =>
        session === undefined
          ? Effect.fail(
              new JournalError({
                corruptionClass: "invalid_record_sequence",
                message: `Session ${sessionId} has no root entry.`,
              }),
            )
          : Effect.succeed(session),
      ),
    ),
  persistLine: (_sessionId, line) =>
    Effect.gen(function* () {
      const validated = yield* decodeJournalLine(line).pipe(
        Effect.mapError(
          (cause) =>
            new JournalError({
              cause,
              corruptionClass: "schema_mismatch",
              message: `Journal line does not match its schema: ${String(cause)}`,
            }),
        ),
      );
      yield* Ref.update(backing[memoryJournalBacking], (lines) => [...lines, validated]);
    }),
});

export const createMemoryJournalBacking = (): MemoryJournalBacking => ({
  [memoryJournalBacking]: Ref.unsafeMake<ReadonlyArray<JournalLine>>([]),
});

export const JournalMemory = (backing: MemoryJournalBacking): Layer.Layer<Journal, JournalError> =>
  Layer.effect(
    Journal,
    Effect.gen(function* () {
      const lines = yield* Ref.get(backing[memoryJournalBacking]);
      const state = yield* deriveState(lines);
      return yield* createJournalAdapter(state, memoryPersistence(backing));
    }),
  );

export const createMemoryJournalHarness = () => {
  const backing = createMemoryJournalBacking();
  return {
    layer: JournalMemory(backing),
    reopen: () => JournalMemory(backing),
    snapshotLines: (): Effect.Effect<ReadonlyArray<unknown>> =>
      Ref.get(backing[memoryJournalBacking]).pipe(
        Effect.map((lines): ReadonlyArray<unknown> => structuredClone(lines)),
      ),
  };
};
