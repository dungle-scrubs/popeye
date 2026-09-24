/**
 * Owns per-session command linearization through one scoped fiber and one FIFO queue.
 * It exists because D-016 requires one interleaving: dequeue order is the durable command order.
 *
 * Mailbox fibers live until layer teardown. Version 1 deliberately has no idle eviction.
 * Each session accepts at most 256 queued commands by default, with drop-new behavior at capacity.
 * If a caller is interrupted after enqueue, its command still runs; callers re-derive revision from
 * the Journal when they need a result after cancellation.
 */

import { Journal, type JournalFailure, type JournalService, type SessionId } from "@popeye/journal";
import { StaleRevision } from "@popeye/protocol";
import {
  Context,
  Deferred,
  Effect,
  ExecutionStrategy,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Scope,
} from "effect";

import { MailboxClosed, MailboxFull, MailboxSessionNotFound } from "./errors.js";

export const MAILBOX_CAPACITY = 256;

/** Options for the scoped mailbox layer. Capacity must be a positive safe integer. */
export interface MailboxOptions {
  /** Maximum queued commands per session. The default is 256 and excess commands are rejected. */
  readonly capacity?: number;
}

export interface MailboxCommand<TValue, TError = never> {
  readonly expectedRevision?: number;
  readonly name: string;
  readonly onAccepted?: Effect.Effect<void>;
  readonly run: (revision: number) => Effect.Effect<TValue, TError>;
}

export interface MailboxResult<TValue> {
  readonly revision: number;
  readonly value: TValue;
}

export type MailboxFailure =
  | JournalFailure
  | MailboxClosed
  | MailboxFull
  | MailboxSessionNotFound
  | StaleRevision;

export const CLOSE_GRACE_MS = 5_000;

export interface MailboxService {
  readonly activate: (sessionId: SessionId) => Effect.Effect<void, JournalFailure | MailboxClosed>;
  /**
   * RFC-02 P2: drains one session queue. Pending work fails closed;
   * in-flight work gets CLOSE_GRACE_MS before the caller takes over.
   * Returns true when the drain settled within grace.
   */
  readonly closeSession: (sessionId: SessionId) => Effect.Effect<boolean, JournalFailure>;
  readonly enqueue: <TValue, TError>(
    sessionId: SessionId,
    command: MailboxCommand<TValue, TError>,
  ) => Effect.Effect<MailboxResult<TValue>, MailboxFailure | TError>;
}

export class Mailbox extends Context.Tag("@popeye/kernel/Mailbox")<Mailbox, MailboxService>() {}

interface WorkItem {
  readonly close: Effect.Effect<void>;
  readonly run: Effect.Effect<void>;
  readonly settled: Deferred.Deferred<void>;
}

interface MailboxState {
  readonly closed: boolean;
  readonly inFlight: ReadonlySet<WorkItem>;
  readonly pending: ReadonlySet<WorkItem>;
}

interface SessionMailbox {
  readonly consumer: Ref.Ref<Fiber.Fiber<void> | undefined>;
  readonly queue: Queue.Queue<WorkItem>;
  readonly revision: Ref.Ref<number>;
  readonly state: Ref.Ref<MailboxState>;
}

interface MailboxRegistry {
  readonly closed: boolean;
  readonly mailboxes: Map<SessionId, SessionMailbox>;
}

interface MailboxDrain {
  readonly inFlight: ReadonlyArray<WorkItem>;
  readonly pending: ReadonlyArray<WorkItem>;
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

const claimWork = (mailbox: SessionMailbox, work: WorkItem): Effect.Effect<boolean> =>
  Ref.modify(mailbox.state, (state) => {
    if (state.closed) {
      return [false, state];
    }
    const inFlight = new Set(state.inFlight);
    const pending = new Set(state.pending);
    inFlight.add(work);
    pending.delete(work);
    return [true, { ...state, inFlight, pending }];
  });

const settleWork = (mailbox: SessionMailbox, work: WorkItem): Effect.Effect<void> =>
  Ref.update(mailbox.state, (state) => {
    const inFlight = new Set(state.inFlight);
    inFlight.delete(work);
    return { ...state, inFlight };
  });

const drainMailbox = (mailbox: SessionMailbox): Effect.Effect<MailboxDrain> =>
  Ref.modify(mailbox.state, (state) => [
    { inFlight: [...state.inFlight], pending: [...state.pending] },
    { ...state, closed: true, pending: new Set<WorkItem>() },
  ]);

const commandWork = <TValue, TError>(
  command: MailboxCommand<TValue, TError>,
  deferred: Deferred.Deferred<MailboxResult<TValue>, MailboxFailure | TError>,
  journal: JournalService,
  revision: Ref.Ref<number>,
  sessionId: SessionId,
): Effect.Effect<WorkItem> =>
  Effect.gen(function* () {
    const settled = yield* Deferred.make<void>();
    const close = Deferred.fail(deferred, new MailboxClosed({ sessionId })).pipe(
      Effect.zipRight(Deferred.succeed(settled, undefined)),
      Effect.asVoid,
    );
    const run = Effect.gen(function* () {
      const revisionBefore = yield* Ref.get(revision);
      const revisionAfter = yield* Ref.make(revisionBefore);
      const commandExit: Exit.Exit<TValue, TError | MailboxFailure> = yield* Effect.exit(
        Effect.gen(function* () {
          const bodyExit = yield* Effect.exit(
            Effect.gen(function* () {
              if (
                command.expectedRevision !== undefined &&
                command.expectedRevision !== revisionBefore
              ) {
                return yield* new StaleRevision({
                  actual: revisionBefore,
                  expected: command.expectedRevision,
                });
              }
              return yield* command.run(revisionBefore);
            }),
          );
          const nextRevision = yield* journal.countDurableLines(sessionId);
          yield* Ref.set(revision, nextRevision);
          yield* Ref.set(revisionAfter, nextRevision);
          return yield* Exit.matchEffect(bodyExit, {
            onFailure: Effect.failCause,
            onSuccess: Effect.succeed,
          });
        }).pipe(
          Effect.onExit(() =>
            Ref.get(revisionAfter).pipe(
              Effect.flatMap((nextRevision) =>
                Effect.annotateCurrentSpan({
                  revisionAfter: nextRevision,
                  revisionBefore,
                }),
              ),
            ),
          ),
          Effect.withSpan("kernel.command", {
            attributes: {
              command: command.name,
              revisionBefore,
              sessionId,
            },
          }),
        ),
      );
      if (Exit.isSuccess(commandExit)) {
        yield* Deferred.succeed(deferred, {
          revision: yield* Ref.get(revisionAfter),
          value: commandExit.value,
        });
      } else {
        yield* Deferred.failCause(deferred, commandExit.cause);
      }
    }).pipe(Effect.ensuring(Deferred.succeed(settled, undefined)), Effect.uninterruptible);
    return { close, run, settled };
  });

const runSessionMailbox = (mailbox: SessionMailbox): Effect.Effect<never> =>
  Effect.forever(
    mailbox.queue.take.pipe(
      Effect.flatMap((work) =>
        claimWork(mailbox, work).pipe(
          Effect.flatMap((claimed) =>
            claimed ? work.run.pipe(Effect.ensuring(settleWork(mailbox, work))) : work.close,
          ),
        ),
      ),
    ),
  );

const makeSessionMailbox = (capacity: number): Effect.Effect<SessionMailbox> =>
  Effect.gen(function* () {
    return {
      consumer: yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined),
      queue: yield* Queue.dropping<WorkItem>(capacity),
      revision: yield* Ref.make(0),
      state: yield* Ref.make<MailboxState>({
        closed: false,
        inFlight: new Set<WorkItem>(),
        pending: new Set<WorkItem>(),
      }),
    };
  });

export const MailboxLive = (options: MailboxOptions = {}): Layer.Layer<Mailbox, never, Journal> => {
  const capacity = options.capacity ?? MAILBOX_CAPACITY;
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError("Mailbox capacity must be a positive safe integer.");
  }
  return Layer.scoped(
    Mailbox,
    Effect.gen(function* () {
      const journal = yield* Journal;
      const registry = yield* Ref.make<MailboxRegistry>({ closed: false, mailboxes: new Map() });
      const scope = yield* Effect.scope;
      const consumerScope = yield* Scope.fork(scope, ExecutionStrategy.sequential);

      const closeAll = Effect.gen(function* () {
        const mailboxes = yield* Ref.modify(registry, (current) => [
          [...current.mailboxes.values()],
          { ...current, closed: true },
        ]);
        const drains = yield* Effect.forEach(mailboxes, drainMailbox);
        yield* Effect.forEach(
          drains.flatMap((drain) => drain.pending),
          (work) => work.close,
        );
        yield* Effect.forEach(
          drains.flatMap((drain) => drain.inFlight),
          (work) => Deferred.await(work.settled),
        );
        yield* Effect.forEach(mailboxes, (mailbox) => Queue.shutdown(mailbox.queue));
        const consumers = yield* Effect.forEach(mailboxes, (mailbox) => Ref.get(mailbox.consumer));
        yield* Effect.forEach(consumers, (consumer) =>
          consumer === undefined ? Effect.void : Fiber.interrupt(consumer),
        );
      }).pipe(Effect.uninterruptible);

      yield* Effect.addFinalizer(() => closeAll);

      const activate = (
        sessionId: SessionId,
      ): Effect.Effect<void, JournalFailure | MailboxClosed> =>
        Effect.gen(function* () {
          const initialRevision = yield* journal.countDurableLines(sessionId);
          const candidate = yield* makeSessionMailbox(capacity);
          yield* Ref.set(candidate.revision, initialRevision);
          const activation = yield* Ref.modify(registry, (current) => {
            if (current.closed) {
              return ["closed" as const, current];
            }
            if (current.mailboxes.has(sessionId)) {
              return ["already-active" as const, current];
            }
            current.mailboxes.set(sessionId, candidate);
            return ["activated" as const, current];
          });
          if (activation === "closed") {
            return yield* new MailboxClosed({ sessionId });
          }
          if (activation === "activated") {
            const consumer = yield* Effect.forkIn(runSessionMailbox(candidate), consumerScope);
            yield* Ref.set(candidate.consumer, consumer);
          }
        });

      const closeSession = (sessionId: SessionId): Effect.Effect<boolean, JournalFailure> =>
        Effect.gen(function* () {
          const mailbox = yield* Ref.modify(registry, (current) => {
            const found = current.mailboxes.get(sessionId);
            if (found === undefined) {
              return [undefined, current];
            }
            const next = new Map(current.mailboxes);
            next.delete(sessionId);
            return [found, { ...current, mailboxes: next }];
          });
          if (mailbox === undefined) {
            return true;
          }
          const drain = yield* drainMailbox(mailbox);
          yield* Effect.forEach(drain.pending, (work) => work.close, { discard: true });
          const settled = yield* Effect.forEach(
            drain.inFlight,
            (work) => Deferred.await(work.settled),
            { discard: true },
          ).pipe(Effect.timeoutOption(`${CLOSE_GRACE_MS} millis`));
          yield* Queue.shutdown(mailbox.queue);
          const consumer = yield* Ref.get(mailbox.consumer);
          if (consumer !== undefined) {
            yield* Fiber.interrupt(consumer);
          }
          return Option.isSome(settled);
        }).pipe(Effect.uninterruptible);

      return {
        activate,
        closeSession,
        enqueue: <TValue, TError>(sessionId: SessionId, command: MailboxCommand<TValue, TError>) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(registry);
            if (current.closed) {
              return yield* new MailboxClosed({ sessionId });
            }
            const mailbox = current.mailboxes.get(sessionId);
            if (mailbox === undefined) {
              return yield* new MailboxSessionNotFound({ sessionId });
            }

            const revision = yield* Ref.get(mailbox.revision);
            if (command.expectedRevision !== undefined && command.expectedRevision !== revision) {
              return yield* staleRevision(command, sessionId, revision);
            }

            const deferred = yield* Deferred.make<MailboxResult<TValue>, MailboxFailure | TError>();
            const work = yield* commandWork(
              command,
              deferred,
              journal,
              mailbox.revision,
              sessionId,
            );
            const accepted = yield* Ref.modify(mailbox.state, (state) => {
              if (state.closed) {
                return [false, state];
              }
              if (!mailbox.queue.unsafeOffer(work)) {
                return [false, state];
              }
              const pending = new Set(state.pending);
              pending.add(work);
              return [true, { ...state, pending }];
            });
            if (!accepted) {
              const closed = yield* Ref.get(mailbox.state).pipe(
                Effect.map((state) => state.closed),
              );
              return yield* closed
                ? new MailboxClosed({ sessionId })
                : new MailboxFull({ capacity, sessionId });
            }
            if (command.onAccepted !== undefined) {
              yield* command.onAccepted;
            }
            return yield* Deferred.await(deferred);
          }),
      } satisfies MailboxService;
    }),
  );
};
