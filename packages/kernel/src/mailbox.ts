/**
 * Owns per-session command linearization through one scoped fiber and one FIFO queue.
 * It exists because D-016 requires one interleaving: dequeue order is the durable command order.
 */

import type { SessionId } from "@peye/journal";
import { StaleRevision } from "@peye/protocol";
import { Context, Data, Deferred, Effect, Layer, Queue, Ref } from "effect";

import { MailboxFull, MailboxSessionNotFound } from "./errors.js";

export const MAILBOX_CAPACITY = 256;

export class InvalidDurableLineCount extends Data.TaggedError("InvalidDurableLineCount")<{
  readonly durableLines: number;
}> {}

export interface MailboxCommandOutput<TValue> {
  readonly durableLines: number;
  readonly value: TValue;
}

export interface MailboxCommand<TValue, TError = never> {
  readonly expectedRevision?: number;
  readonly name: string;
  readonly run: (revision: number) => Effect.Effect<MailboxCommandOutput<TValue>, TError>;
}

export interface MailboxResult<TValue> {
  readonly revision: number;
  readonly value: TValue;
}

export type MailboxFailure =
  | InvalidDurableLineCount
  | MailboxFull
  | MailboxSessionNotFound
  | StaleRevision;

export interface MailboxService {
  readonly activate: (sessionId: SessionId, revision: number) => Effect.Effect<void>;
  readonly enqueue: <TValue, TError>(
    sessionId: SessionId,
    command: MailboxCommand<TValue, TError>,
  ) => Effect.Effect<MailboxResult<TValue>, MailboxFailure | TError>;
}

export class Mailbox extends Context.Tag("@peye/kernel/Mailbox")<Mailbox, MailboxService>() {}

interface WorkItem {
  readonly run: (revision: number) => Effect.Effect<void>;
}

interface SessionMailbox {
  readonly queue: Queue.Queue<WorkItem>;
  readonly revision: Ref.Ref<number>;
}

const staleRevision = (
  command: Pick<MailboxCommand<unknown>, "expectedRevision" | "name">,
  sessionId: SessionId,
  actual: number,
): Effect.Effect<never, StaleRevision> =>
  Effect.fail(new StaleRevision({ actual, expected: command.expectedRevision ?? actual })).pipe(
    Effect.withSpan("kernel.command", {
      attributes: {
        actual,
        command: command.name,
        expected: command.expectedRevision,
        revisionAfter: actual,
        revisionBefore: actual,
        sessionId,
      },
    }),
  );

const commandWork = <TValue, TError>(
  command: MailboxCommand<TValue, TError>,
  deferred: Deferred.Deferred<MailboxResult<TValue>, MailboxFailure | TError>,
  revision: Ref.Ref<number>,
  sessionId: SessionId,
): WorkItem => ({
  run: (revisionBefore) =>
    Effect.gen(function* () {
      if (command.expectedRevision !== undefined && command.expectedRevision !== revisionBefore) {
        return yield* new StaleRevision({
          actual: revisionBefore,
          expected: command.expectedRevision,
        });
      }
      const output = yield* command.run(revisionBefore);
      if (!Number.isSafeInteger(output.durableLines) || output.durableLines < 0) {
        return yield* new InvalidDurableLineCount({ durableLines: output.durableLines });
      }
      const revisionAfter = yield* Ref.updateAndGet(
        revision,
        (current) => current + output.durableLines,
      );
      return { revision: revisionAfter, value: output.value };
    }).pipe(
      Effect.tapBoth({
        onFailure: (error) =>
          Ref.get(revision).pipe(
            Effect.flatMap((revisionAfter) =>
              Effect.annotateCurrentSpan({
                ...(error instanceof StaleRevision
                  ? { actual: error.actual, expected: error.expected }
                  : {}),
                revisionAfter,
                revisionBefore,
              }),
            ),
          ),
        onSuccess: (result) =>
          Effect.annotateCurrentSpan({ revisionAfter: result.revision, revisionBefore }),
      }),
      Effect.exit,
      Effect.flatMap((exit) => Deferred.done(deferred, exit)),
      Effect.asVoid,
      Effect.withSpan("kernel.command", {
        attributes: {
          command: command.name,
          revisionBefore,
          sessionId,
        },
      }),
    ),
});

const runSessionMailbox = (mailbox: SessionMailbox): Effect.Effect<never> =>
  Effect.forever(
    Effect.gen(function* () {
      const work = yield* mailbox.queue.take;
      const revision = yield* Ref.get(mailbox.revision);
      yield* work.run(revision);
    }),
  );

export const MailboxLive: Layer.Layer<Mailbox> = Layer.scoped(
  Mailbox,
  Effect.gen(function* () {
    const mailboxes = yield* Ref.make(new Map<SessionId, SessionMailbox>());
    const scope = yield* Effect.scope;

    const activate = (sessionId: SessionId, revision: number): Effect.Effect<void> =>
      Ref.get(mailboxes).pipe(
        Effect.flatMap((current) => {
          if (current.has(sessionId)) {
            return Effect.void;
          }
          return Effect.gen(function* () {
            const queue = yield* Queue.dropping<WorkItem>(MAILBOX_CAPACITY);
            const sessionMailbox = { queue, revision: yield* Ref.make(revision) };
            yield* Effect.forkIn(runSessionMailbox(sessionMailbox), scope);
            yield* Ref.update(mailboxes, (existing) =>
              new Map(existing).set(sessionId, sessionMailbox),
            );
          });
        }),
      );

    return {
      activate,
      enqueue: <TValue, TError>(sessionId: SessionId, command: MailboxCommand<TValue, TError>) =>
        Effect.gen(function* () {
          const mailbox = (yield* Ref.get(mailboxes)).get(sessionId);
          if (mailbox === undefined) {
            return yield* new MailboxSessionNotFound({ sessionId });
          }

          const revision = yield* Ref.get(mailbox.revision);
          if (command.expectedRevision !== undefined && command.expectedRevision !== revision) {
            return yield* staleRevision(command, sessionId, revision);
          }

          const deferred = yield* Deferred.make<MailboxResult<TValue>, MailboxFailure | TError>();
          const accepted = mailbox.queue.unsafeOffer(
            commandWork(command, deferred, mailbox.revision, sessionId),
          );
          if (!accepted) {
            return yield* new MailboxFull({ capacity: MAILBOX_CAPACITY, sessionId });
          }
          return yield* Deferred.await(deferred);
        }),
    };
  }),
);
