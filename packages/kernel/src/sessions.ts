/**
 * Owns Kernel-facing session creation and later lifecycle restoration from the Journal.
 * It exists so Session identity, Leaf position, and revision remain journal-derived at one seam.
 */

import {
  type Entry,
  Journal,
  type JournalFailure,
  type JournalService,
  type SessionId,
} from "@peye/journal";
import { Context, Effect, Layer } from "effect";

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

export interface SessionsService {
  readonly create: () => Effect.Effect<SessionInfo, JournalFailure>;
  readonly list: () => Effect.Effect<ReadonlyArray<SessionSummary>, JournalFailure>;
  readonly resume: (sessionId: SessionId) => Effect.Effect<SessionInfo, JournalFailure>;
}

export class Sessions extends Context.Tag("@peye/kernel/Sessions")<Sessions, SessionsService>() {}

const revisionFor = (
  journal: JournalService,
  sessionId: SessionId,
): Effect.Effect<number, JournalFailure> =>
  Effect.all([journal.readBranch(sessionId), journal.readRecords(sessionId)]).pipe(
    Effect.map(([entries, records]) => entries.length + records.length),
  );

export const SessionsLive: Layer.Layer<Sessions, never, Journal | Mailbox> = Layer.effect(
  Sessions,
  Effect.gen(function* () {
    const journal = yield* Journal;
    const mailbox = yield* Mailbox;

    return {
      create: () =>
        Effect.gen(function* () {
          const created = yield* journal.createSession();
          yield* mailbox.activate(created.id, 1);
          return { id: created.id, leaf: created.rootEntry, revision: 1 };
        }),
      list: () =>
        journal
          .listSessions()
          .pipe(
            Effect.flatMap((sessions) =>
              Effect.forEach(sessions, ({ id }) =>
                revisionFor(journal, id).pipe(Effect.map((revision) => ({ id, revision }))),
              ),
            ),
          ),
      resume: (sessionId: SessionId) =>
        Effect.gen(function* () {
          const leaf = yield* journal.getLeaf(sessionId);
          const revision = yield* revisionFor(journal, sessionId);
          yield* mailbox.activate(sessionId, revision);
          return { id: sessionId, leaf, revision };
        }),
    };
  }),
);
