import {
  createMemoryJournalBacking,
  JournalMemory,
  type SessionId,
  SessionIdSchema,
} from "@dungle-scrubs/popeye-journal";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, test } from "vitest";

import { Driver, DriverDefault } from "./driver.js";
import { MailboxClosed } from "./errors.js";
import { Mailbox, MailboxLive } from "./mailbox.js";
import { Provider, type ProviderService } from "./provider.js";
import type { CloseFacts, ReflectionProducer, StartRecord } from "./reflection-producer.js";
import {
  type JournalSessions,
  makeSessionLifecycle,
  type SessionLifecycleService,
  type SessionLifecycleTapInput,
} from "./session-lifecycle.js";
import { Sessions, SessionsLive } from "./sessions.js";
import { ToolRegistryLive } from "./tool.js";

// Seam tests for the Session lifecycle report (RFC-03 slice 16, ADR-0002). Every Journal is in
// memory, every Provider is invented, and the reflection producer is a recording fake: nothing
// here spawns a process or writes a file.

const idleProvider: ProviderService = { streamAssistant: () => Stream.empty };

const driverLayer = (lifecycle: SessionLifecycleService) =>
  DriverDefault({ lifecycle }).pipe(
    Layer.provide(
      Layer.mergeAll(
        JournalMemory(createMemoryJournalBacking()),
        Layer.succeed(Provider, idleProvider),
        ToolRegistryLive([]),
      ),
    ),
  );

interface Call {
  readonly event: string;
  readonly facts?: CloseFacts;
  readonly listed?: ReadonlyArray<string>;
  readonly sessionId: string;
}

/** A recording lifecycle that also reads the Journal list at report time. */
const recordingLifecycle = () => {
  const calls: Array<Call> = [];
  const listed = (journalSessions: JournalSessions) =>
    journalSessions.pipe(
      Effect.map((sessions) => sessions.map((session) => String(session.id))),
      Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
    );
  const lifecycle: SessionLifecycleService = {
    closed: (sessionId, drainedWithinGrace) =>
      Effect.sync(() =>
        calls.push({ event: "closed", facts: { drainedWithinGrace, kind: "close" }, sessionId }),
      ),
    created: (sessionId, journalSessions) =>
      listed(journalSessions).pipe(
        Effect.map((ids) => calls.push({ event: "created", listed: ids, sessionId })),
      ),
    headExit: (sessionId) => Effect.sync(() => calls.push({ event: "head-exit", sessionId })),
    headExitAll: () => Effect.sync(() => calls.push({ event: "head-exit-all", sessionId: "" })),
    resumed: (sessionId, journalSessions) =>
      listed(journalSessions).pipe(
        Effect.map((ids) => calls.push({ event: "resumed", listed: ids, sessionId })),
      ),
  };
  return { calls, lifecycle };
};

/** A recording reflection producer: no spawn, no file. */
const fakeProducer = (options: { readonly throws?: boolean } = {}) => {
  const sends: Array<{
    readonly event: string;
    readonly facts?: CloseFacts;
    readonly sessionId: string;
  }> = [];
  let activation = 0;
  const producer: ReflectionProducer = {
    candidates: () => [] as ReadonlyArray<StartRecord>,
    close: (sessionId, _activationId, facts) => {
      if (options.throws === true) throw new Error("invented producer failure");
      sends.push({ event: "closed", facts, sessionId });
    },
    reconcile: () => {},
    start: (event, sessionId) => {
      if (options.throws === true) throw new Error("invented producer failure");
      sends.push({ event, sessionId });
      activation += 1;
      return `activation-${activation}`;
    },
  };
  return { producer, sends };
};

describe("AC1: the kernel seams report create, resume, and close", () => {
  test("create reports the new Session once it is in the Journal", async () => {
    const { calls, lifecycle } = recordingLifecycle();
    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        return yield* driver.createSession();
      }).pipe(Effect.provide(driverLayer(lifecycle))),
    );
    expect(calls).toEqual([{ event: "created", listed: [created.id], sessionId: created.id }]);
  });

  test("resume reports the same Session after recovery; an unknown Session reports nothing", async () => {
    const { calls, lifecycle } = recordingLifecycle();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const created = yield* driver.createSession();
        yield* driver.resumeSession(created.id);
        const unknown = yield* driver
          .resumeSession(SessionIdSchema.make("sess-invented-unknown"))
          .pipe(Effect.either);
        return { created, unknown };
      }).pipe(Effect.provide(driverLayer(lifecycle))),
    );
    expect(result.unknown._tag).toBe("Left");
    expect(calls.map((c) => [c.event, c.sessionId])).toEqual([
      ["created", result.created.id],
      ["resumed", result.created.id],
    ]);
  });

  test("closeSession reports closed with its drain fact, once the close returns its result", async () => {
    const { calls, lifecycle } = recordingLifecycle();
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const created = yield* driver.createSession();
        const before = calls.length;
        const result = yield* driver.closeSession(created.id);
        return { before, created, result };
      }).pipe(Effect.provide(driverLayer(lifecycle))),
    );
    expect(outcome.before).toBe(1);
    expect(calls[1]).toEqual({
      event: "closed",
      facts: { drainedWithinGrace: outcome.result.drainedWithinGrace, kind: "close" },
      sessionId: outcome.created.id,
    });
    expect(outcome.result.drainedWithinGrace).toBe(true);
  });

  test("fork reports the child Session as created; branch reports nothing", async () => {
    const { calls, lifecycle } = recordingLifecycle();
    const ids = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const created = yield* driver.createSession();
        yield* driver.branch(created.id, created.leaf.id);
        const forked = yield* driver.fork(created.id, created.leaf.id);
        return { forked: forked.sessionId, source: created.id };
      }).pipe(Effect.provide(driverLayer(lifecycle))),
    );
    expect(calls.map((c) => [c.event, c.sessionId])).toEqual([
      ["created", ids.source],
      ["created", ids.forked],
    ]);
  });

  test("a create whose Mailbox activation fails reports nothing", async () => {
    const { calls, lifecycle } = recordingLifecycle();
    const failingMailbox = Layer.effect(
      Mailbox,
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        return {
          ...mailbox,
          activate: (sessionId: SessionId) =>
            Effect.fail(new MailboxClosed({ sessionId })) as never,
        };
      }),
    ).pipe(Layer.provide(MailboxLive()));
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        return yield* sessions.create();
      }).pipe(
        Effect.provide(
          SessionsLive({ lifecycle }).pipe(
            Layer.provide(ToolRegistryLive([])),
            Layer.provide(failingMailbox),
            Layer.provide(JournalMemory(createMemoryJournalBacking())),
          ),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect(calls).toEqual([]);
  });
});

describe("the Tap broadcast and the durable send", () => {
  test("both carry the same Session ID; a second close of one activation sends nothing", async () => {
    const taps: Array<SessionLifecycleTapInput> = [];
    const { producer, sends } = fakeProducer();
    const lifecycle = makeSessionLifecycle({
      producer,
      tap: (input) => Effect.sync(() => void taps.push(input)),
    });
    const id = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const created = yield* driver.createSession();
        yield* driver.resumeSession(created.id);
        yield* driver.closeSession(created.id);
        yield* driver.closeSession(created.id);
        yield* lifecycle.headExitAll(driver.listSessions());
        return created.id;
      }).pipe(Effect.provide(driverLayer(lifecycle))),
    );
    expect(taps).toEqual([
      { event: "created", sessionId: id },
      { event: "resumed", sessionId: id },
      { event: "closed", sessionId: id },
      { event: "closed", sessionId: id },
    ]);
    expect(sends).toEqual([
      { event: "created", sessionId: id },
      { event: "closed", facts: { drainedWithinGrace: true, kind: "close" }, sessionId: id },
    ]);
  });

  test("a head exit reports a clean close once, and an explicit close before it wins", async () => {
    const { producer, sends } = fakeProducer();
    const lifecycle = makeSessionLifecycle({ producer });
    const ids = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const a = yield* driver.createSession();
        const b = yield* driver.createSession();
        yield* driver.closeSession(a.id);
        yield* lifecycle.headExitAll(driver.listSessions());
        yield* lifecycle.headExit(b.id, driver.listSessions());
        return { a: a.id, b: b.id };
      }).pipe(Effect.provide(driverLayer(lifecycle))),
    );
    expect(sends.filter((s) => s.event === "closed")).toEqual([
      { event: "closed", facts: { drainedWithinGrace: true, kind: "close" }, sessionId: ids.a },
      { event: "closed", facts: { kind: "head-exit" }, sessionId: ids.b },
    ]);
  });

  test("a failing Tap and a throwing producer change no Session result", async () => {
    const { producer } = fakeProducer({ throws: true });
    const failing = makeSessionLifecycle({
      producer,
      tap: () => Effect.die(new Error("invented tap defect")),
    });
    const quiet = makeSessionLifecycle();
    const run = (lifecycle: SessionLifecycleService) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const driver = yield* Driver;
          const created = yield* driver.createSession();
          const resumed = yield* driver.resumeSession(created.id);
          const closed = yield* driver.closeSession(created.id);
          return {
            closed: closed.drainedWithinGrace,
            createdRevision: created.revision,
            resumedRevision: resumed.revision,
          };
        }).pipe(Effect.provide(driverLayer(lifecycle))),
      );
    expect(await run(failing)).toEqual(await run(quiet));
  });
});
