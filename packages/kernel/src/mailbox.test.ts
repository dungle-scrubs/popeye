import type { JournalService } from "@popeye/journal";
import {
  createMemoryJournalBacking,
  Journal,
  JournalMemory,
  RecordDraftSchema,
  SessionIdSchema,
} from "@popeye/journal";
import { Deferred, Effect, Exit, Fiber, Layer, Scope, Tracer } from "effect";
import { expect, test } from "vitest";

import { Mailbox, MailboxLive } from "./mailbox.js";

const appendRecord = (
  journal: JournalService,
  sessionId: ReturnType<typeof SessionIdSchema.make>,
  kind: string,
) => journal.appendRecord(sessionId, RecordDraftSchema.make({ kind, payload: {} }));

const mailboxLayer = (capacity?: number) => {
  const backing = createMemoryJournalBacking();
  const journalLayer = JournalMemory(backing);
  const mailboxLayer = capacity === undefined ? MailboxLive() : MailboxLive({ capacity });
  return Layer.merge(journalLayer, mailboxLayer.pipe(Layer.provide(journalLayer)));
};

test("all mutating commands for a session execute on one fiber in dequeue order", async () => {
  const observed: Array<{ readonly fiber: string; readonly name: string }> = [];

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const mailbox = yield* Mailbox;
      const session = yield* journal.createSession();
      yield* mailbox.activate(session.id);
      const command = (name: string) => ({
        name,
        run: (revision: number) =>
          Effect.gen(function* () {
            observed.push({ fiber: String(yield* Effect.fiberId), name });
            yield* journal.appendRecord(
              session.id,
              RecordDraftSchema.make({ kind: `command_${name}`, payload: {} }),
            );
            return revision;
          }),
      });
      return yield* Effect.all(
        [
          mailbox.enqueue(session.id, command("first")),
          mailbox.enqueue(session.id, command("second")),
        ],
        { concurrency: "unbounded" },
      );
    }).pipe(Effect.provide(mailboxLayer())),
  );

  expect(observed.map((item) => item.name)).toEqual(["first", "second"]);
  expect(new Set(observed.map((item) => item.fiber))).toHaveLength(1);
  expect(result.map((item) => item.revision)).toEqual([2, 3]);
});

test("revision is measured from acknowledged Journal lines after a command appends two lines", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const mailbox = yield* Mailbox;
      const session = yield* journal.createSession();
      yield* mailbox.activate(session.id);
      const completed = yield* mailbox.enqueue(session.id, {
        name: "append-two",
        run: () =>
          journal
            .appendRecord(session.id, RecordDraftSchema.make({ kind: "first_line", payload: {} }))
            .pipe(
              Effect.zipRight(
                journal.appendRecord(
                  session.id,
                  RecordDraftSchema.make({ kind: "second_line", payload: {} }),
                ),
              ),
              Effect.as("appended"),
            ),
      });
      return { completed, counted: yield* journal.countDurableLines(session.id) };
    }).pipe(Effect.provide(mailboxLayer())),
  );

  expect(result.completed).toEqual({ revision: 3, value: "appended" });
  expect(result.counted).toBe(result.completed.revision);
});

test("a command made stale while queued fails before its body runs", async () => {
  let staleBodyRan = false;
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const mailbox = yield* Mailbox;
      const release = yield* Deferred.make<void>();
      const session = yield* journal.createSession();
      const started = yield* Deferred.make<void>();
      yield* mailbox.activate(session.id);
      const first = yield* Effect.fork(
        mailbox.enqueue(session.id, {
          name: "first",
          run: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.zipRight(Deferred.await(release)),
              Effect.zipRight(appendRecord(journal, session.id, "first")),
              Effect.as("first"),
            ),
        }),
      );
      yield* Deferred.await(started);
      const stale = yield* Effect.fork(
        mailbox.enqueue(session.id, {
          expectedRevision: 1,
          name: "stale",
          run: () =>
            Effect.sync(() => {
              staleBodyRan = true;
              return "incorrect";
            }),
        }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      return yield* Effect.flip(Fiber.join(stale));
    }).pipe(Effect.provide(mailboxLayer())),
  );

  expect(result).toMatchObject({ _tag: "StaleRevision", actual: 2, expected: 1 });
  expect(staleBodyRan).toBe(false);
});

test("failing, defective, and stale command spans preserve annotations and end unsuccessfully", async () => {
  const spans: Array<{
    readonly attributes: Map<string, unknown>;
    readonly name: string;
    exit: Exit.Exit<unknown, unknown> | undefined;
  }> = [];
  const tracer = Tracer.make({
    context: (evaluate) => evaluate(),
    span: (name, parent, context, links, startTime, kind, options) => {
      const captured = {
        attributes: new Map(Object.entries(options?.attributes ?? {})),
        exit: undefined,
        name,
      } as {
        readonly attributes: Map<string, unknown>;
        readonly name: string;
        exit: Exit.Exit<unknown, unknown> | undefined;
      };
      spans.push(captured);
      return {
        _tag: "Span",
        addLinks: () => undefined,
        attribute: (key, value) => captured.attributes.set(key, value),
        attributes: captured.attributes,
        context,
        end: (_endTime, exit) => {
          captured.exit = exit;
        },
        event: () => undefined,
        kind,
        links,
        name,
        parent,
        sampled: true,
        spanId: `${spans.length}`,
        status: { _tag: "Started", startTime },
        traceId: "captured",
      } satisfies Tracer.Span;
    },
  });
  const traceLayer = Layer.merge(Layer.setTracer(tracer), Layer.setTracerEnabled(true));
  const tracedMailboxLayer = mailboxLayer().pipe(Layer.provide(traceLayer));

  await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const mailbox = yield* Mailbox;
      const session = yield* journal.createSession();
      yield* mailbox.activate(session.id);
      yield* Effect.exit(
        mailbox.enqueue(session.id, { name: "failure", run: () => Effect.fail("no") }),
      );
      yield* Effect.exit(
        mailbox.enqueue(session.id, { name: "defect", run: () => Effect.die("no") }),
      );
      yield* Effect.exit(
        mailbox.enqueue(session.id, {
          expectedRevision: 0,
          name: "stale",
          run: () => Effect.void,
        }),
      );
    }).pipe(Effect.provide(tracedMailboxLayer)),
  );

  const commandSpans = spans.filter((span) => span.name === "kernel.command");
  expect(commandSpans).toHaveLength(3);
  for (const span of commandSpans) {
    expect(span.exit === undefined ? false : Exit.isFailure(span.exit)).toBe(true);
    expect(span.attributes.get("revisionAfter")).toBe(1);
    expect(span.attributes.get("revisionBefore")).toBe(1);
    expect(span.attributes.get("sessionId")).toEqual(expect.any(String));
  }
});

test("command failure and defect both complete their caller and leave the consumer usable", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const mailbox = yield* Mailbox;
      const session = yield* journal.createSession();
      yield* mailbox.activate(session.id);
      const failure = yield* Effect.flip(
        mailbox.enqueue(session.id, { name: "failure", run: () => Effect.fail("failed") }),
      );
      const defect = yield* Effect.exit(
        mailbox.enqueue(session.id, { name: "defect", run: () => Effect.die("defective") }),
      );
      const afterFailure = yield* mailbox.enqueue(session.id, {
        name: "after-failure",
        run: () =>
          appendRecord(journal, session.id, "after_failure").pipe(Effect.as("after-failure")),
      });
      const afterDefect = yield* mailbox.enqueue(session.id, {
        name: "after-defect",
        run: () =>
          appendRecord(journal, session.id, "after_defect").pipe(Effect.as("after-defect")),
      });
      return { afterDefect, afterFailure, defect, failure };
    }).pipe(Effect.provide(mailboxLayer())),
  );

  expect(result.failure).toBe("failed");
  expect(Exit.isFailure(result.defect)).toBe(true);
  expect(result.afterFailure.revision).toBe(2);
  expect(result.afterDefect.revision).toBe(3);
});

test("interrupting a caller does not interrupt its already-enqueued command", async () => {
  const completed = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const mailbox = yield* Mailbox;
      const release = yield* Deferred.make<void>();
      const session = yield* journal.createSession();
      const started = yield* Deferred.make<void>();
      const commandFinished = yield* Deferred.make<void>();
      yield* mailbox.activate(session.id);
      const caller = yield* Effect.fork(
        mailbox.enqueue(session.id, {
          name: "interrupted-caller",
          run: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.zipRight(Deferred.await(release)),
              Effect.zipRight(appendRecord(journal, session.id, "caller_interrupted")),
              Effect.zipRight(Deferred.succeed(commandFinished, undefined)),
              Effect.as("done"),
            ),
        }),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(caller);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(commandFinished);
      return yield* journal.countDurableLines(session.id);
    }).pipe(Effect.provide(mailboxLayer())),
  );

  expect(completed).toBe(2);
});

test("MailboxFull uses the actual capacity while one command blocks the consumer", async () => {
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const mailbox = yield* Mailbox;
      const release = yield* Deferred.make<void>();
      const session = yield* journal.createSession();
      const started = yield* Deferred.make<void>();
      yield* mailbox.activate(session.id);
      const blocker = yield* Effect.fork(
        mailbox.enqueue(session.id, {
          name: "blocker",
          run: () =>
            Deferred.succeed(started, undefined).pipe(Effect.zipRight(Deferred.await(release))),
        }),
      );
      yield* Deferred.await(started);
      const queued = [];
      for (const index of Array.from({ length: 256 }, (_, current) => current)) {
        const enqueuing = yield* Deferred.make<void>();
        queued.push(
          yield* Effect.fork(
            Deferred.succeed(enqueuing, undefined).pipe(
              Effect.zipRight(
                mailbox.enqueue(session.id, { name: `queued-${index}`, run: () => Effect.void }),
              ),
            ),
          ),
        );
        yield* Deferred.await(enqueuing);
        yield* Effect.yieldNow();
      }
      const overflow = yield* Effect.fork(
        mailbox.enqueue(session.id, { name: "one-too-many", run: () => Effect.void }),
      );
      yield* Effect.yieldNow();
      const full = yield* Effect.flip(Fiber.join(overflow));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(blocker);
      yield* Effect.forEach(queued, Fiber.join);
      return full;
    }).pipe(Effect.provide(mailboxLayer())),
  );

  expect(error).toMatchObject({ _tag: "MailboxFull", capacity: 256 });
});

test("an unknown session is rejected with MailboxSessionNotFound", async () => {
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      return yield* Effect.flip(
        mailbox.enqueue(SessionIdSchema.make("missing"), {
          name: "missing",
          run: () => Effect.void,
        }),
      );
    }).pipe(Effect.provide(mailboxLayer())),
  );

  expect(error).toMatchObject({ _tag: "MailboxSessionNotFound", sessionId: "missing" });
});

test("teardown drains the in-flight command, rejects queued callers, and closes future enqueues", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const services = yield* Layer.build(mailboxLayer()).pipe(Scope.extend(scope));
      return yield* Effect.gen(function* () {
        const journal = yield* Journal;
        const mailbox = yield* Mailbox;
        const release = yield* Deferred.make<void>();
        const session = yield* journal.createSession();
        const idleSession = yield* journal.createSession();
        const started = yield* Deferred.make<void>();
        yield* mailbox.activate(session.id);
        yield* mailbox.activate(idleSession.id);
        const running = yield* Effect.fork(
          mailbox.enqueue(session.id, {
            name: "running",
            run: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.zipRight(Deferred.await(release)),
                Effect.zipRight(appendRecord(journal, session.id, "drained")),
                Effect.as("running"),
              ),
          }),
        );
        yield* Deferred.await(started);
        const queued = yield* Effect.fork(
          mailbox.enqueue(session.id, { name: "queued", run: () => Effect.succeed("queued") }),
        );
        const closing = yield* Effect.fork(Scope.close(scope, Exit.void));
        yield* mailbox
          .enqueue(SessionIdSchema.make("closure-probe"), {
            name: "wait-for-drain",
            run: () => Effect.void,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("MailboxClosed", () => Effect.succeed(true)),
            Effect.catchTag("MailboxSessionNotFound", () => Effect.succeed(false)),
            Effect.flatMap((closed) =>
              closed
                ? Effect.void
                : Effect.yieldNow().pipe(
                    Effect.zipRight(Effect.fail(new Error("Mailbox is not closed yet."))),
                  ),
            ),
            Effect.eventually,
          );
        yield* Deferred.succeed(release, undefined);
        const runningResult = yield* Fiber.join(running);
        const queuedResult = yield* Effect.flip(Fiber.join(queued));
        yield* Fiber.join(closing);
        const closed = yield* Effect.flip(
          mailbox.enqueue(session.id, { name: "after-close", run: () => Effect.void }),
        );
        return { closed, queuedResult, runningResult };
      }).pipe(Effect.provide(services));
    }),
  );

  expect(result.runningResult).toEqual({ revision: 2, value: "running" });
  expect(result.queuedResult).toMatchObject({ _tag: "MailboxClosed" });
  expect(result.closed).toMatchObject({ _tag: "MailboxClosed" });
});

test("teardown of an idle mailbox is prompt", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const services = yield* Layer.build(mailboxLayer()).pipe(Scope.extend(scope));
      yield* Effect.gen(function* () {
        const journal = yield* Journal;
        const mailbox = yield* Mailbox;
        const session = yield* journal.createSession();
        yield* mailbox.activate(session.id);
        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.provide(services));
    }).pipe(Effect.timeout("1 second")),
  );
});
