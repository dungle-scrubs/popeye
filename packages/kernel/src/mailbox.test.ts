import { SessionIdSchema } from "@peye/journal";
import { Deferred, Effect, Fiber } from "effect";
import { expect, test } from "vitest";

import { Mailbox, MailboxLive } from "./mailbox.js";

test("all mutating commands for a session execute on one fiber in dequeue order", async () => {
  const observed: Array<{ readonly fiber: string; readonly name: string }> = [];

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const sessionId = SessionIdSchema.make("session-a");
      yield* mailbox.activate(sessionId, 0);

      const command = (name: string) => ({
        name,
        run: (revision: number) =>
          Effect.gen(function* () {
            const fiber = yield* Effect.fiberId;
            observed.push({ fiber: String(fiber), name });
            return { durableLines: 1, value: revision };
          }),
      });

      return yield* Effect.all(
        [
          mailbox.enqueue(sessionId, command("first")),
          mailbox.enqueue(sessionId, command("second")),
          mailbox.enqueue(sessionId, command("third")),
        ],
        { concurrency: "unbounded" },
      );
    }).pipe(Effect.provide(MailboxLive)),
  );

  expect(observed.map((item) => item.name)).toEqual(["first", "second", "third"]);
  expect(new Set(observed.map((item) => item.fiber))).toHaveLength(1);
  expect(result.map((item) => item.revision)).toEqual([1, 2, 3]);
});

test("concurrent callers serialize 128 commands without overlap", async () => {
  const observed: Array<number> = [];
  let executing = false;
  let overlapped = false;

  const completed = await Effect.runPromise(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const sessionId = SessionIdSchema.make("session-stress");
      yield* mailbox.activate(sessionId, 0);

      return yield* Effect.all(
        Array.from({ length: 128 }, (_, index) =>
          mailbox.enqueue(sessionId, {
            name: `command-${index}`,
            run: () =>
              Effect.gen(function* () {
                overlapped ||= executing;
                executing = true;
                yield* Effect.yieldNow();
                observed.push(index);
                executing = false;
                return { durableLines: 1, value: index };
              }),
          }),
        ),
        { concurrency: "unbounded" },
      );
    }).pipe(Effect.provide(MailboxLive)),
  );

  expect(overlapped).toBe(false);
  expect(observed).toEqual(completed.map((item) => item.value));
  expect(completed.map((item) => item.revision)).toEqual(
    Array.from({ length: 128 }, (_, index) => index + 1),
  );
});

test("an expectedRevision mismatch fails with StaleRevision before it joins a blocked mailbox", async () => {
  let staleBodyRan = false;

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const release = yield* Deferred.make<void>();
      const sessionId = SessionIdSchema.make("session-stale");
      const started = yield* Deferred.make<void>();
      yield* mailbox.activate(sessionId, 1);

      const running = yield* Effect.fork(
        mailbox.enqueue(sessionId, {
          name: "blocked",
          run: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.zipRight(Deferred.await(release)),
              Effect.as({ durableLines: 1, value: "released" }),
            ),
        }),
      );
      yield* Deferred.await(started);

      const error = yield* Effect.flip(
        mailbox.enqueue(sessionId, {
          expectedRevision: 0,
          name: "stale",
          run: () =>
            Effect.sync(() => {
              staleBodyRan = true;
              return { durableLines: 1, value: "incorrect" };
            }),
        }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(running);
      return error;
    }).pipe(Effect.provide(MailboxLive)),
  );

  expect(result).toMatchObject({ _tag: "StaleRevision", actual: 1, expected: 0 });
  expect(staleBodyRan).toBe(false);
});

test("a command made stale while queued fails before its body runs", async () => {
  let staleBodyRan = false;

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const release = yield* Deferred.make<void>();
      const sessionId = SessionIdSchema.make("session-queued-stale");
      const started = yield* Deferred.make<void>();
      yield* mailbox.activate(sessionId, 0);

      const first = yield* Effect.fork(
        mailbox.enqueue(sessionId, {
          name: "first",
          run: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.zipRight(Deferred.await(release)),
              Effect.as({ durableLines: 1, value: "first" }),
            ),
        }),
      );
      yield* Deferred.await(started);
      const stale = yield* Effect.fork(
        mailbox.enqueue(sessionId, {
          expectedRevision: 0,
          name: "stale-after-enqueue",
          run: () =>
            Effect.sync(() => {
              staleBodyRan = true;
              return { durableLines: 1, value: "incorrect" };
            }),
        }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      return yield* Effect.flip(Fiber.join(stale));
    }).pipe(Effect.provide(MailboxLive)),
  );

  expect(result).toMatchObject({ _tag: "StaleRevision", actual: 1, expected: 0 });
  expect(staleBodyRan).toBe(false);
});

test("matching and omitted expectedRevision values both proceed", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const sessionId = SessionIdSchema.make("session-current");
      yield* mailbox.activate(sessionId, 0);
      const matching = yield* mailbox.enqueue(sessionId, {
        expectedRevision: 0,
        name: "matching",
        run: () => Effect.succeed({ durableLines: 1, value: "matching" }),
      });
      const omitted = yield* mailbox.enqueue(sessionId, {
        name: "omitted",
        run: () => Effect.succeed({ durableLines: 1, value: "omitted" }),
      });
      return { matching, omitted };
    }).pipe(Effect.provide(MailboxLive)),
  );

  expect(result).toEqual({
    matching: { revision: 1, value: "matching" },
    omitted: { revision: 2, value: "omitted" },
  });
});

test("command spans include the session and revisions", async () => {
  let span:
    | { readonly attributes: ReadonlyMap<string, unknown>; readonly name: string }
    | undefined;

  await Effect.runPromise(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const sessionId = SessionIdSchema.make("session-traced");
      yield* mailbox.activate(sessionId, 3);
      yield* mailbox.enqueue(sessionId, {
        name: "traced",
        run: () =>
          Effect.currentSpan.pipe(
            Effect.tap((current) =>
              Effect.sync(() => {
                span = current;
              }),
            ),
            Effect.as({ durableLines: 2, value: undefined }),
          ),
      });
    }).pipe(Effect.provide(MailboxLive)),
  );

  expect(span?.name).toBe("kernel.command");
  expect(span?.attributes.get("command")).toBe("traced");
  expect(span?.attributes.get("revisionAfter")).toBe(5);
  expect(span?.attributes.get("revisionBefore")).toBe(3);
  expect(span?.attributes.get("sessionId")).toBe("session-traced");
});
