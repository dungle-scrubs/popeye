/**
 * Owns Kernel-facing session creation and later lifecycle restoration from the Journal.
 * It exists so Session identity, Leaf position, and revision remain journal-derived at one seam.
 */

import { type Entry, Journal, type JournalFailure, type SessionId } from "@peye/journal";
import { Context, Effect, Layer } from "effect";
import type { MailboxClosed } from "./errors.js";
import { Mailbox } from "./mailbox.js";

export interface SessionInfo {
  readonly id: SessionId;
  readonly leaf: Entry;
  readonly revision: number;
}

export interface SessionSummary {
  readonly id: SessionId;
  readonly revision: number;
}

export type SessionsFailure = JournalFailure | MailboxClosed;

export interface SessionsService {
  readonly create: () => Effect.Effect<SessionInfo, SessionsFailure>;
  readonly list: () => Effect.Effect<ReadonlyArray<SessionSummary>, JournalFailure>;
  readonly resume: (sessionId: SessionId) => Effect.Effect<SessionInfo, SessionsFailure>;
}

export class Sessions extends Context.Tag("@peye/kernel/Sessions")<Sessions, SessionsService>() {}

export const SessionsLive: Layer.Layer<Sessions, never, Journal | Mailbox> = Layer.effect(
  Sessions,
  Effect.gen(function* () {
    const journal = yield* Journal;
    const mailbox = yield* Mailbox;

    return {
      create: () =>
        Effect.gen(function* () {
          const created = yield* journal.createSession();
          const revision = yield* journal.countDurableLines(created.id);
          yield* mailbox.activate(created.id);
          return { id: created.id, leaf: created.rootEntry, revision };
        }),
      list: () =>
        journal
          .listSessions()
          .pipe(
            Effect.flatMap((sessions) =>
              Effect.forEach(sessions, ({ id }) =>
                journal.countDurableLines(id).pipe(Effect.map((revision) => ({ id, revision }))),
              ),
            ),
          ),
      resume: (sessionId: SessionId) =>
        Effect.gen(function* () {
          const leaf = yield* journal.getLeaf(sessionId);
          const revision = yield* journal.countDurableLines(sessionId);
          yield* mailbox.activate(sessionId);
          return { id: sessionId, leaf, revision };
        }),
    };
  }),
);
