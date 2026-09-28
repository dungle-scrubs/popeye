/**
 * Owns the Session lifecycle report made at the kernel seams: end of create, end of resume, end of
 * closeSession, and a Head's normal exit (ADR-0002).
 * It exists so each seam makes two failure-isolated calls through one place: the diagnostic
 * `session-lifecycle` Tap broadcast, and the durable reflection send. Neither can fail, delay, or
 * change a Session operation.
 * The kernel receives the Tap emit as a function, so it never imports the Plugin package.
 * One service per process tracks the Sessions this process opened, so a Session gets at most one
 * closed report per activation: an explicit close followed by a Head exit reports once.
 */

import type { SessionId } from "@dungle-scrubs/popeye-journal";
import { Context, Effect } from "effect";

import type { ReflectionProducer } from "./reflection-producer.js";

export interface SessionLifecycleTapInput {
  readonly event: "closed" | "created" | "resumed";
  readonly sessionId: SessionId;
}

/** Emits one `session-lifecycle` Tap input. Its failure is ignored. */
export type SessionLifecycleTap = (input: SessionLifecycleTapInput) => Effect.Effect<void, unknown>;

/** The Journal's current Session list, read only when the sweep has candidates. */
export type JournalSessions = Effect.Effect<ReadonlyArray<{ readonly id: string }>, unknown>;

export interface SessionLifecycleService {
  /** End of closeSession, after the settle and the Snapshot read. */
  readonly closed: (
    sessionId: SessionId,
    drainedWithinGrace: boolean,
    journalSessions: JournalSessions,
  ) => Effect.Effect<void>;
  /** End of create, after the Journal Session exists and the Mailbox is active. */
  readonly created: (sessionId: SessionId, journalSessions: JournalSessions) => Effect.Effect<void>;
  /** A Head's normal exit: a clean close for one Session, without closeSession. */
  readonly headExit: (
    sessionId: SessionId,
    journalSessions: JournalSessions,
  ) => Effect.Effect<void>;
  /** A Head's normal end of input: a clean close for every Session still open here. */
  readonly headExitAll: (journalSessions: JournalSessions) => Effect.Effect<void>;
  /** End of resume, after recovery succeeds. */
  readonly resumed: (sessionId: SessionId, journalSessions: JournalSessions) => Effect.Effect<void>;
}

export class SessionLifecycle extends Context.Tag("@dungle-scrubs/popeye-kernel/SessionLifecycle")<
  SessionLifecycle,
  SessionLifecycleService
>() {}

export interface SessionLifecycleOptions {
  /** The durable reflection send; absent when reflection is off. */
  readonly producer?: ReflectionProducer;
  /** The diagnostic Tap broadcast; absent when no Plugin host is composed. */
  readonly tap?: SessionLifecycleTap;
}

const isolated = (effect: Effect.Effect<void, unknown>): Effect.Effect<void> =>
  effect.pipe(Effect.catchAllCause(() => Effect.void));

export const makeSessionLifecycle = (
  options: SessionLifecycleOptions = {},
): SessionLifecycleService => {
  const { producer, tap } = options;
  /** Sessions opened by this process and not yet reported closed, with their activation. */
  const open = new Map<SessionId, string | undefined>();

  const emitTap = (input: SessionLifecycleTapInput): Effect.Effect<void> =>
    tap === undefined ? Effect.void : isolated(Effect.suspend(() => tap(input)));

  /** The sweep runs before every durable send. The Journal is read only when needed. */
  const sweep = (reflection: ReflectionProducer, journalSessions: JournalSessions) =>
    Effect.gen(function* () {
      const candidates = reflection.candidates();
      if (candidates.length === 0) return;
      const listed = yield* journalSessions.pipe(
        Effect.map((sessions) => new Set(sessions.map((session) => String(session.id)))),
      );
      reflection.reconcile(candidates, listed);
    });

  const start = (
    event: "created" | "resumed",
    sessionId: SessionId,
    journalSessions: JournalSessions,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* emitTap({ event, sessionId });
      if (open.has(sessionId)) return;
      open.set(sessionId, undefined);
      if (producer === undefined) return;
      yield* isolated(sweep(producer, journalSessions));
      const activationId = yield* Effect.sync(() => producer.start(event, sessionId));
      if (open.has(sessionId)) open.set(sessionId, activationId);
    }).pipe(isolated);

  const end = (
    sessionId: SessionId,
    facts:
      | { readonly drainedWithinGrace: boolean; readonly kind: "close" }
      | { readonly kind: "head-exit" },
    journalSessions: JournalSessions,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (!open.has(sessionId)) return;
      const activationId = open.get(sessionId);
      open.delete(sessionId);
      if (facts.kind === "head-exit") yield* emitTap({ event: "closed", sessionId });
      if (producer === undefined || activationId === undefined) return;
      yield* isolated(sweep(producer, journalSessions));
      yield* Effect.sync(() => producer.close(sessionId, activationId, facts));
    }).pipe(isolated);

  return {
    closed: (sessionId, drainedWithinGrace, journalSessions) =>
      emitTap({ event: "closed", sessionId }).pipe(
        Effect.zipRight(end(sessionId, { drainedWithinGrace, kind: "close" }, journalSessions)),
      ),
    created: (sessionId, journalSessions) => start("created", sessionId, journalSessions),
    headExit: (sessionId, journalSessions) =>
      end(sessionId, { kind: "head-exit" }, journalSessions),
    headExitAll: (journalSessions) =>
      Effect.forEach([...open.keys()], (sessionId) =>
        end(sessionId, { kind: "head-exit" }, journalSessions),
      ).pipe(Effect.asVoid),
    resumed: (sessionId, journalSessions) => start("resumed", sessionId, journalSessions),
  };
};
