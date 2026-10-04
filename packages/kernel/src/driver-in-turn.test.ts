/**
 * Pins the Driver contract that Delegation (RFC-04 §6, issue #56) relies on: which Driver
 * operations a Tool may call while its own parent Turn is running.
 *
 * `Driver.fork(parentId, ...)` enqueues on the parent's Mailbox, and the running Turn occupies
 * that Mailbox while it waits for its Tool batch, so a fork from inside the parent's Tool call
 * cannot return before that Turn ends. The first test proves that deadlock and is green while it
 * exists. It is the reason the delegate Tool creates its child with `createSession` instead.
 * The second test pins the operations the delegate Tool uses on the child (`createSession`,
 * `prompt`, `getSnapshot`, `closeSession`): none touches the parent's Mailbox, so all complete
 * while the parent Turn runs, and the child is a real Session in the parent's Journal.
 * The last three tests pin the close contract the delegate Tool's release relies on: a close
 * stops a Turn that is still being admitted, a close past its grace reports it and deactivates
 * the Session, and a close inside an uninterruptible release keeps its deadline.
 */
import {
  createMemoryJournalBacking,
  Journal,
  JournalMemory,
  type JournalService,
  type SessionId,
} from "@dungle-scrubs/popeye-journal";
import { Deferred, Effect, Either, Fiber, Layer, Option, Schedule, Schema, Stream } from "effect";
import { expect, test } from "vitest";

import { Driver, DriverDefault, type DriverService, type DriverSnapshot } from "./driver.js";
import { Provider, type ProviderService } from "./provider.js";
import { defineTool, type Tool, ToolRegistryLive } from "./tool.js";

const PARENT_PROMPT = "Parent prompt.";
const CHILD_PROMPT = "Task: child work";

/** The parent calls the probe Tool once, then ends; the child answers its task. */
const scriptedProvider: ProviderService = {
  streamAssistant: (context) => {
    const lastUser = [...context].reverse().find((item) => item.role === "user")?.content;
    if (lastUser === CHILD_PROMPT) {
      return Stream.make(
        { _tag: "textDelta" as const, text: "child answer" },
        { _tag: "done" as const, stopReason: "done" as const },
      );
    }
    return context.at(-1)?.role === "toolResult"
      ? Stream.make({ _tag: "done" as const, stopReason: "done" as const })
      : Stream.make(
          { _tag: "toolCall" as const, argumentsJson: "{}", id: "call-probe", name: "probe" },
          { _tag: "done" as const, stopReason: "toolCalls" as const },
        );
  },
};

const driverLayer = (probe: Tool.Any) =>
  DriverDefault().pipe(
    Layer.provide(
      Layer.mergeAll(
        JournalMemory(createMemoryJournalBacking()),
        Layer.succeed(Provider, scriptedProvider),
        ToolRegistryLive([probe]),
      ),
    ),
  );

const lastAssistantText = (snapshot: DriverSnapshot): string | undefined => {
  const entry = [...snapshot.entries]
    .reverse()
    .find(
      (candidate) =>
        candidate.kind === "message" &&
        (candidate.payload as { readonly role?: unknown }).role === "assistant",
    );
  return (entry?.payload as { readonly content?: string } | undefined)?.content;
};

test("Driver.fork called by a Tool of the parent's running Turn stays pending until that Turn ends", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const toolEntered = yield* Deferred.make<void>();
      const forkReturned = yield* Deferred.make<DriverSnapshot>();
      let driver: DriverService | undefined;
      let rootEntry: DriverSnapshot["leaf"]["id"] | undefined;
      const probe = defineTool({
        description: "Fork the running parent.",
        execute: (_arguments, context) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(toolEntered, undefined);
            if (driver === undefined || rootEntry === undefined) {
              return { content: "unbound", isError: true };
            }
            const child = yield* driver
              .fork(context.sessionId, rootEntry)
              .pipe(Effect.catchAll(() => Effect.never));
            yield* Deferred.succeed(forkReturned, child);
            return { content: "fork-returned" };
          }),
        name: "probe",
        parameters: Schema.Struct({}),
      });
      return yield* Effect.gen(function* () {
        driver = yield* Driver;
        const parent = yield* driver.createSession();
        rootEntry = parent.leaf.id;
        const turn = yield* Effect.fork(driver.prompt(parent.id, PARENT_PROMPT));
        yield* Deferred.await(toolEntered);
        const whileTurnRuns = yield* Deferred.await(forkReturned).pipe(
          Effect.timeoutOption("300 millis"),
        );
        const turnPending = Option.isNone(yield* Fiber.poll(turn));
        const sessionsWhileTurnRan = (yield* driver.listSessions()).length;
        const abort = yield* driver.abortTurn(parent.id);
        yield* Fiber.await(turn);
        // The aborted Tool no longer awaits the fork, but the queued fork command still runs
        // once the Turn releases the parent's Mailbox (mailbox.ts: an enqueued command runs even
        // when its caller is interrupted).
        const bound = driver;
        const sessionsAfterTurn = yield* bound.listSessions().pipe(
          Effect.map((sessions) => sessions.length),
          Effect.flatMap((count) => (count === 2 ? Effect.succeed(count) : Effect.fail(count))),
          Effect.retry(Schedule.spaced("20 millis")),
          Effect.timeoutOption("2 seconds"),
        );
        return {
          abortSucceeded: abort.aborted,
          forkRanAfterTurnEnded: Option.getOrUndefined(sessionsAfterTurn) === 2,
          forkReturnedWhileTurnRan: Option.isSome(whileTurnRuns),
          sessionsWhileTurnRan,
          turnPendingWhileForkWaited: turnPending,
        };
      }).pipe(Effect.provide(driverLayer(probe)));
    }),
  );

  expect(result).toEqual({
    abortSucceeded: true,
    forkRanAfterTurnEnded: true,
    forkReturnedWhileTurnRan: false,
    sessionsWhileTurnRan: 1,
    turnPendingWhileForkWaited: true,
  });
}, 10_000);

test("a Tool of the parent's running Turn creates, prompts, reads, and closes a child Session in the parent's Journal", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      let driver: DriverService | undefined;
      const childIds: Array<SessionId> = [];
      const probe = defineTool({
        description: "Run a child Session from inside the parent's Turn.",
        execute: () =>
          Effect.gen(function* () {
            if (driver === undefined) {
              return { content: "unbound", isError: true };
            }
            const bound = driver;
            const child = yield* bound.createSession();
            childIds.push(child.id);
            const turn = yield* bound.prompt(child.id, CHILD_PROMPT);
            const snapshot = yield* bound.getSnapshot(child.id);
            yield* bound.closeSession(child.id);
            return {
              content: `${turn.stopReason}:${lastAssistantText(snapshot) ?? ""}`,
            };
          }).pipe(
            Effect.catchAll((error) => Effect.succeed({ content: String(error), isError: true })),
          ),
        name: "probe",
        parameters: Schema.Struct({}),
      });
      return yield* Effect.gen(function* () {
        driver = yield* Driver;
        const parent = yield* driver.createSession();
        const turn = yield* driver
          .prompt(parent.id, PARENT_PROMPT)
          .pipe(Effect.timeoutOption("5 seconds"));
        const parentSnapshot = yield* driver.getSnapshot(parent.id);
        const toolResult = parentSnapshot.entries.find(
          (entry) =>
            entry.kind === "message" &&
            (entry.payload as { readonly role?: unknown }).role === "toolResult",
        )?.payload as { readonly content?: string; readonly isError?: boolean } | undefined;
        const sessions = yield* driver.listSessions();
        const childId = childIds[0];
        const resumed = childId === undefined ? undefined : yield* driver.resumeSession(childId);
        const childSnapshot =
          childId === undefined ? undefined : yield* driver.getSnapshot(childId);
        return {
          childPrompt: childSnapshot?.entries.some(
            (entry) =>
              entry.kind === "message" &&
              (entry.payload as { readonly content?: unknown }).content === CHILD_PROMPT,
          ),
          childResumed: resumed?.id === childId,
          sessionIds: sessions.map((session) => session.id).sort(),
          toolResult,
          turn: Option.getOrUndefined(turn),
          expectedIds: [parent.id, ...childIds].sort(),
        };
      }).pipe(Effect.provide(driverLayer(probe)));
    }),
  );

  expect(result.turn).toEqual({ stopReason: "done" });
  expect(result.toolResult).toMatchObject({ content: "done:child answer" });
  expect(result.toolResult?.isError).not.toBe(true);
  expect(result.sessionIds).toEqual(result.expectedIds);
  expect(result.sessionIds).toHaveLength(2);
  expect(result.childResumed).toBe(true);
  expect(result.childPrompt).toBe(true);
}, 10_000);

// ---------------------------------------------------------------------------
// Close contract (issue #56 revision: findings 1 and 2 of the spec critique)
// ---------------------------------------------------------------------------

const answer = (text: string) =>
  Stream.make(
    { _tag: "textDelta" as const, text },
    { _tag: "done" as const, stopReason: "done" as const },
  );

/**
 * The parent calls the probe Tool once and ends once it has the result; every child request
 * is answered by `child`, which also counts it.
 */
const routedProvider = (
  child: () => ReturnType<ProviderService["streamAssistant"]>,
): { readonly childRequests: () => number; readonly provider: ProviderService } => {
  let count = 0;
  return {
    childRequests: () => count,
    provider: {
      streamAssistant: (context) => {
        const lastUser = [...context].reverse().find((item) => item.role === "user")?.content;
        if (lastUser === CHILD_PROMPT) {
          count += 1;
          return child();
        }
        return scriptedProvider.streamAssistant(context, { attempt: 1, turnOrdinal: 1 });
      },
    },
  };
};

/**
 * Holds the first `readBranch` of the Session named by `hold`. For a Session that has just been
 * created, that read is the Driver's option resolution for its first prompt, which runs inside
 * the Turn's Mailbox command before the Turn registers as active: the admission stage.
 */
interface AdmissionGate {
  readonly allow: Deferred.Deferred<void>;
  readonly entered: Deferred.Deferred<void>;
  hold: SessionId | undefined;
}

const makeAdmissionGate = (): Effect.Effect<AdmissionGate> =>
  Effect.gen(function* () {
    return {
      allow: yield* Deferred.make<void>(),
      entered: yield* Deferred.make<void>(),
      hold: undefined,
    };
  });

const gatedDriverLayer = (
  gate: AdmissionGate,
  provider: ProviderService,
  tools: Array<Tool.Any>,
) => {
  let held = false;
  const journal = Layer.effect(
    Journal,
    Effect.map(
      Journal,
      (inner): JournalService => ({
        ...inner,
        readBranch: (sessionId) =>
          gate.hold === sessionId && !held
            ? Effect.gen(function* () {
                held = true;
                yield* Deferred.succeed(gate.entered, undefined);
                yield* Deferred.await(gate.allow);
                return yield* inner.readBranch(sessionId);
              })
            : inner.readBranch(sessionId),
      }),
    ),
  ).pipe(Layer.provide(JournalMemory(createMemoryJournalBacking())));
  return DriverDefault().pipe(
    Layer.provide(
      Layer.mergeAll(journal, Layer.succeed(Provider, provider), ToolRegistryLive(tools)),
    ),
  );
};

test("a child closed by its Tool's release while its Turn is still being admitted never starts that Turn", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* makeAdmissionGate();
      const closeEntered = yield* Deferred.make<void>();
      const childIds: Array<SessionId> = [];
      let driver: DriverService | undefined;
      const { childRequests, provider } = routedProvider(() => answer("late child answer"));
      // The delegate Tool's lifecycle: acquireRelease(createSession, closeSession), then prompt.
      const probe = defineTool({
        description: "Run a child Session with the delegate Tool's lifecycle.",
        execute: () =>
          Effect.gen(function* () {
            if (driver === undefined) {
              return { content: "unbound", isError: true };
            }
            const bound = driver;
            const child = yield* Effect.acquireRelease(bound.createSession(), (created) =>
              Deferred.succeed(closeEntered, undefined).pipe(
                Effect.zipRight(bound.closeSession(created.id)),
                Effect.catchAllCause(() => Effect.void),
              ),
            );
            childIds.push(child.id);
            gate.hold = child.id;
            const turn = yield* bound.prompt(child.id, CHILD_PROMPT);
            return { content: turn.stopReason };
          }).pipe(
            Effect.catchAll((error) => Effect.succeed({ content: String(error), isError: true })),
          ),
        name: "probe",
        parameters: Schema.Struct({}),
      });
      return yield* Effect.gen(function* () {
        driver = yield* Driver;
        const parent = yield* driver.createSession();
        const turn = yield* Effect.fork(driver.prompt(parent.id, PARENT_PROMPT));
        yield* Deferred.await(gate.entered).pipe(Effect.timeout("5 seconds"));
        const abort = yield* Effect.fork(driver.abortTurn(parent.id));
        yield* Deferred.await(closeEntered).pipe(Effect.timeout("5 seconds"));
        // The release is inside the child's close while its admission is still held.
        yield* Effect.sleep("100 millis");
        yield* Deferred.succeed(gate.allow, undefined);
        const aborted = yield* Fiber.join(abort);
        const parentTurn = yield* Fiber.join(turn);
        const childId = childIds[0];
        const child =
          childId === undefined
            ? undefined
            : yield* driver
                .resumeSession(childId)
                .pipe(Effect.zipRight(driver.getSnapshot(childId)));
        return {
          aborted: aborted.aborted,
          childEntryKinds: child?.entries.map((entry) => entry.kind),
          childRequests: childRequests(),
          parentTurn,
        };
      }).pipe(
        Effect.ensuring(Deferred.succeed(gate.allow, undefined)),
        Effect.provide(gatedDriverLayer(gate, provider, [probe])),
      );
    }),
  );

  // The refused Turn journals nothing: the child keeps only its root Entry.
  expect(result).toEqual({
    aborted: true,
    childEntryKinds: ["session_root"],
    childRequests: 0,
    parentTurn: { stopReason: "aborted" },
  });
}, 15_000);

test("a close whose in-flight admission outlasts the close grace reports it, deactivates the Session, and never starts the Turn", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* makeAdmissionGate();
      const { childRequests, provider } = routedProvider(() => answer("late child answer"));
      return yield* Effect.gen(function* () {
        const driver = yield* Driver;
        const child = yield* driver.createSession();
        gate.hold = child.id;
        const turn = yield* Effect.fork(driver.prompt(child.id, CHILD_PROMPT));
        yield* Deferred.await(gate.entered).pipe(Effect.timeout("5 seconds"));
        // Joined from a daemon so a close that ignores its own deadline fails the test instead
        // of hanging it.
        const close = yield* Effect.forkDaemon(driver.closeSession(child.id));
        const closed = yield* Fiber.join(close).pipe(Effect.timeoutOption("8 seconds"));
        const promptAfterClose = yield* Effect.either(driver.prompt(child.id, "After close."));
        yield* Deferred.succeed(gate.allow, undefined);
        const admitted = yield* Fiber.join(turn).pipe(Effect.timeout("5 seconds"));
        yield* Fiber.await(close).pipe(Effect.timeout("5 seconds"));
        return {
          admitted,
          childRequests: childRequests(),
          closeReturnedWithinBound: Option.isSome(closed),
          drainedWithinGrace: Option.getOrUndefined(closed)?.drainedWithinGrace,
          promptAfterClose: Either.isLeft(promptAfterClose)
            ? (promptAfterClose.left as { readonly _tag?: string })._tag
            : "accepted",
        };
      }).pipe(
        Effect.ensuring(Deferred.succeed(gate.allow, undefined)),
        Effect.provide(gatedDriverLayer(gate, provider, [])),
      );
    }),
  );

  expect(result).toEqual({
    admitted: { stopReason: "aborted" },
    childRequests: 0,
    closeReturnedWithinBound: true,
    drainedWithinGrace: false,
    promptAfterClose: "MailboxSessionNotFound",
  });
}, 20_000);

test("a close inside an uninterruptible release keeps the Turn's abort grace while the Turn resists interruption", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* makeAdmissionGate();
      const streaming = yield* Deferred.make<void>();
      const resistEnded = yield* Deferred.make<void>();
      const { provider } = routedProvider(() =>
        Stream.concat(
          Stream.make({ _tag: "textDelta" as const, text: "partial" }),
          Stream.fromEffect(
            Deferred.succeed(streaming, undefined).pipe(
              Effect.zipRight(Effect.sleep("1500 millis")),
              Effect.ensuring(Deferred.succeed(resistEnded, undefined)),
              Effect.uninterruptible,
              Effect.as({ _tag: "textDelta" as const, text: "late" }),
            ),
          ),
        ),
      );
      return yield* Effect.gen(function* () {
        const driver = yield* Driver;
        const child = yield* driver.createSession();
        const turn = yield* Effect.fork(
          driver.prompt(child.id, CHILD_PROMPT, { abortGraceMs: 100 }),
        );
        yield* Deferred.await(streaming).pipe(Effect.timeout("5 seconds"));
        const started = performance.now();
        let drainedWithinGrace: boolean | undefined;
        // acquireRelease runs its release uninterruptibly, as the delegate Tool's release does.
        yield* Effect.scoped(
          Effect.acquireRelease(Effect.void, () =>
            driver.closeSession(child.id).pipe(
              Effect.tap((closed) =>
                Effect.sync(() => {
                  drainedWithinGrace = closed.drainedWithinGrace;
                }),
              ),
              Effect.catchAllCause(() => Effect.void),
            ),
          ),
        );
        const closeMillis = performance.now() - started;
        const snapshotAfterClose = yield* Effect.either(driver.getSnapshot(child.id));
        const turnResult = yield* Fiber.join(turn).pipe(Effect.timeout("5 seconds"));
        // Let the resisting fiber finish before the layer closes.
        yield* Deferred.await(resistEnded).pipe(Effect.timeout("5 seconds"));
        return {
          closedWithinBound: closeMillis < 1_000,
          drainedWithinGrace,
          snapshotAfterClose: Either.isLeft(snapshotAfterClose)
            ? (snapshotAfterClose.left as { readonly _tag?: string })._tag
            : "readable",
          turnResult,
        };
      }).pipe(Effect.provide(gatedDriverLayer(gate, provider, [])));
    }),
  );

  expect(result).toEqual({
    closedWithinBound: true,
    drainedWithinGrace: true,
    snapshotAfterClose: "MailboxSessionNotFound",
    turnResult: { stopReason: "aborted" },
  });
}, 20_000);
