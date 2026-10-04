/**
 * Owns RpcSessionBridge deep module for Driver-facing session lifecycle.
 * It exists so per-Session Driver sequencing, attach/detach
 * lifecycle, PluginInteractions wiring, Snapshot audit, and
 * Progress subscription management hide behind one deep interface
 * handle(command: BridgeCommand).
 *
 * Why this module: rpc.ts was 1,168 lines, owning decode/routing
 * plus Driver effects plus interaction clock plus Plugin
 * Interactions wiring. Transport (367) and dispatch (344) were
 * extracted, but the Head itself remained a God-module. This
 * module owns the Driver-facing session handling, leaving RpcHead
 * as the deep module that composes Transport + Dispatcher + Bridge
 * behind runRpcHead(input, writer). It is the Head's private seam
 * for session concerns, not a standalone public dependency.
 * Not responsible for byte framing or JSON serialization
 * (RpcTransport owns LF/1MB/U+2028/Buffer provenance) or for dispatch
 * policy/fairness (RpcDispatcher owns FIFO caps) or for wire error
 * mapping and decode routing (RpcHead owns those).
 * It also binds an rpc Agent Session (RFC-04 §4, §7): the Tool filter in SessionToolGrants
 * and the persona and model every prompt frame for that Session carries; create and fork
 * bind through the Driver's bind option before the Session can run, resume binds before
 * recovery, fork copies the binding, and close drops it.
 */

import type { EntryId, SessionId } from "@dungle-scrubs/popeye-journal";
import { JournalError, JournalNotFound } from "@dungle-scrubs/popeye-journal";
import type { InteractionRequest, InteractionResponse } from "@dungle-scrubs/popeye-protocol";
import { snapshotView } from "@dungle-scrubs/popeye-protocol";
import { Effect, Exit, Fiber, Option, Predicate, Ref, Stream } from "effect";
import {
  AgentSessionError,
  type AgentSessionPlan,
  type AgentSessionResolver,
  type AgentTurnOptions,
} from "../agents/session-agent.js";
import { type Driver, SessionLifecycle } from "../compose.js";
import type { ToolGrantFilter } from "../tools/grants.js";
import { SessionToolGrants, type SessionToolGrantsService } from "../tools/session-grants.js";
import type { HeadWriteError } from "./head-wire.js";
import { protocolSnapshot, type SnapshotAuditFields } from "./head-wire.js";
import type { RpcInteractionsService } from "./rpc.js";
import { RPC_NO_TURN_ADMISSION, type RpcTurnAdmission } from "./rpc-dispatch.js";

// ---------------------------------------------------------------------------
// Types shared with router (imported by rpc.ts for dispatch routing)
// ---------------------------------------------------------------------------

export type RpcInboundTag =
  | "attach"
  | "detach"
  | "interaction-response"
  | "abort"
  | "branch"
  | "close"
  | "create"
  | "fork"
  | "get-snapshot"
  | "invoke-command"
  | "list"
  | "prompt"
  | "resume"
  | "resume-goal"
  | "set-model"
  | "set-thinking"
  | "steer"
  | "subscribe-progress";

// Minimal command shape sufficient for bridge dispatch.
// The router decodes the full tagged struct and hands the unknown
// payload through; the bridge pattern-matches on _tag.
export type BridgeCommand = {
  readonly _tag: string;
  readonly agent?: string;
  readonly id?: string;
  readonly sessionId?: string;
  readonly interactive?: boolean;
  readonly toEntryId?: string;
  readonly fromEntryId?: string;
  readonly expectedRevision?: number;
  readonly content?: string;
  readonly deliveryMode?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly name?: string;
  readonly args?: unknown;
  // InteractionResponse carries id/kind/value
  readonly kind?: string;
  readonly value?: unknown;
};

export interface RpcInteractiveHead {
  readonly send: (request: InteractionRequest) => Effect.Effect<void, HeadWriteError>;
}

export interface RpcSessionBridge {
  readonly handle: (
    command: BridgeCommand,
    admission?: RpcTurnAdmission,
  ) => Effect.Effect<void, unknown>;
  readonly cleanup: Effect.Effect<void>;
  /**
   * Normal end of input only: a clean close report for every Session this process opened and
   * has not closed (ADR-0002). It never calls closeSession, and an explicit close already
   * reported is not reported again.
   */
  readonly reportEndOfInput: Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// Helpers (mirrored from rpc.ts — retained here for locality; router
// owns wireError mapping, bridge owns Snapshot formatting)
// ---------------------------------------------------------------------------

const connectionSnapshot = (
  snapshot: import("../compose.js").DriverSnapshot,
  attached: boolean,
  snapshotAudit: SnapshotAuditFields | undefined,
) => ({
  _tag: "snapshot" as const,
  attached,
  ...protocolSnapshot(snapshot, snapshotAudit),
});

const writeResponse = (
  transport: { readonly send: (payload: unknown) => Effect.Effect<void, HeadWriteError> },
  id: string | undefined,
  result: unknown,
): Effect.Effect<void, HeadWriteError> =>
  transport.send({ ...(id === undefined ? {} : { id }), result });

/** RFC-04 §5: a closed Session drops its own Tool grant filters, when the host keeps any. */
const releaseSessionToolGrants = (sessionId: string): Effect.Effect<void> =>
  Effect.serviceOption(SessionToolGrants).pipe(
    Effect.flatMap((grants) =>
      Option.isSome(grants) ? grants.value.release(sessionId as unknown as SessionId) : Effect.void,
    ),
  );

const writeSnapshotResponse = (
  transport: { readonly send: (payload: unknown) => Effect.Effect<void, HeadWriteError> },
  id: string | undefined,
  snapshot: import("../compose.js").DriverSnapshot,
  attached: boolean,
  snapshotAudit: SnapshotAuditFields | undefined,
): Effect.Effect<void, HeadWriteError> =>
  writeResponse(transport, id, connectionSnapshot(snapshot, attached, snapshotAudit));

const writeProgress = (
  transport: { readonly send: (payload: unknown) => Effect.Effect<void, HeadWriteError> },
  sessionId: string,
  progress: object,
): Effect.Effect<void, HeadWriteError> => transport.send({ ...progress, sessionId });

const abortResult = (result: {
  readonly aborted: boolean;
  readonly note?: "loop-prevented";
  readonly reason?: "none" | "settling";
  readonly turnOrdinal: number | undefined;
}) => {
  if (!result.aborted) {
    return {
      _tag: "abortTurnNotAborted" as const,
      aborted: false as const,
      reason: result.reason ?? "none",
      turnOrdinal: result.turnOrdinal,
    };
  }
  if (result.note === "loop-prevented") {
    return {
      _tag: "abortTurnLoopPrevented" as const,
      aborted: true as const,
      note: result.note,
      turnOrdinal: result.turnOrdinal,
    };
  }
  return {
    _tag: "abortTurnAborted" as const,
    aborted: true as const,
    turnOrdinal: result.turnOrdinal,
  };
};

// ---------------------------------------------------------------------------
// Factory — one bridge per RPC connection
// ---------------------------------------------------------------------------

export const makeRpcSessionBridge = (options: {
  readonly agents?: AgentSessionResolver;
  readonly driver: Driver["Type"];
  readonly interactions: RpcInteractionsService;
  readonly snapshotAudit?: SnapshotAuditFields;
  readonly transport: { readonly send: (payload: unknown) => Effect.Effect<void, HeadWriteError> };
}): RpcSessionBridge => {
  const { agents, driver, interactions, snapshotAudit, transport } = options;

  // Invariant: mutated only in session-serialized handlers; it must become a Ref
  // if attach/detach becomes non-session-serialized.
  const attached = new Set<string>();
  const interactiveHeads = new Map<string, RpcInteractiveHead>();
  const progressSubscriptions = new Map<string, Fiber.RuntimeFiber<void, HeadWriteError>>();

  // RFC-04 §4: the persona and model each Agent Session's prompt frames carry. A Ref, not a
  // plain Map like `attached`: close is a control frame and runs outside the Session queue.
  const agentTurnOptions = Ref.unsafeMake<ReadonlyMap<string, AgentTurnOptions>>(new Map());

  const bindTurnOptions = (sessionId: string, options: AgentTurnOptions): Effect.Effect<void> =>
    Object.keys(options).length === 0
      ? Effect.void
      : Ref.update(agentTurnOptions, (current) => new Map(current).set(sessionId, options));

  /** Installs an Agent binding; uninterruptible, so no Session holds half of one. */
  const bindAgentSession = (
    sessionId: SessionId,
    grants: Option.Option<SessionToolGrantsService>,
    toolFilters: ReadonlyArray<ToolGrantFilter>,
    turnOptions: AgentTurnOptions | undefined,
  ): Effect.Effect<void> =>
    Effect.uninterruptible(
      Effect.all(
        [
          Option.isSome(grants)
            ? Effect.forEach(toolFilters, (filter) => grants.value.narrow(sessionId, filter), {
                discard: true,
              })
            : Effect.void,
          turnOptions === undefined ? Effect.void : bindTurnOptions(sessionId, turnOptions),
        ],
        { discard: true },
      ),
    );

  const releaseAgentSession = (sessionId: string): Effect.Effect<void> =>
    releaseSessionToolGrants(sessionId).pipe(
      Effect.zipRight(
        Ref.update(agentTurnOptions, (current) => {
          if (!current.has(sessionId)) {
            return current;
          }
          const next = new Map(current);
          next.delete(sessionId);
          return next;
        }),
      ),
    );

  /** Decisions 3 and 11: resolve and check the host before any Session side effect. */
  const planAgentSession = (
    agent: string,
    command: "create" | "resume",
  ): Effect.Effect<
    { readonly grants: Option.Option<SessionToolGrantsService>; readonly plan: AgentSessionPlan },
    AgentSessionError
  > =>
    Effect.gen(function* () {
      if (agents === undefined) {
        return yield* new AgentSessionError({
          agent,
          message: `Agent ${JSON.stringify(agent)} cannot be resolved: this rpc host resolves no Agent definitions. The ${command} fails closed.`,
          reason: "agents_unavailable",
        });
      }
      const plan = yield* agents.resolve(agent);
      const grants = yield* Effect.serviceOption(SessionToolGrants);
      if (plan.toolFilter !== undefined && Option.isNone(grants)) {
        return yield* new AgentSessionError({
          agent,
          message: `Agent ${plan.name} (${plan.filePath}) lists tools, but this rpc host keeps no per-Session Tool grants. The ${command} fails closed.`,
          reason: "agents_unavailable",
        });
      }
      return { grants, plan };
    });

  const logUngrantedTools = (plan: AgentSessionPlan, sessionId: string): Effect.Effect<void> =>
    plan.ungrantedTools.length === 0
      ? Effect.void
      : Effect.logWarning(
          `Agent ${plan.name} (${plan.filePath}) names tools this session does not grant: ${plan.ungrantedTools.join(", ")}. The session runs with the granted subset: ${plan.grantedTools.join(", ")}.`,
        ).pipe(
          Effect.annotateLogs({
            agent: plan.name,
            diagnostic: "agent_tools_ungranted",
            sessionId,
          }),
        );

  const createAgentSession = (
    id: string | undefined,
    agent: string,
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      const { grants, plan } = yield* planAgentSession(agent, "create");
      // RFC-04 §5 (#54 Decision 5): the Kernel runs bind before the Session activates (Decision 10).
      const session = yield* driver.createSession({
        bind: (sessionId) =>
          bindAgentSession(
            sessionId,
            grants,
            plan.toolFilter === undefined ? [] : [plan.toolFilter],
            plan.turnOptions,
          ),
      });
      yield* logUngrantedTools(plan, session.id);
      const snapshot = yield* driver.getSnapshot(session.id);
      yield* writeSnapshot(id, snapshot, false);
    });

  const resumeAgentSession = (
    id: string | undefined,
    sessionIdText: string,
    agent: string,
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      const sessionId = sessionIdText as unknown as SessionId;
      const { grants, plan } = yield* planAgentSession(agent, "resume");
      const held = Option.isSome(grants) ? yield* grants.value.filtersFor(sessionId) : [];
      if (held.length > 0 || (yield* Ref.get(agentTurnOptions)).has(sessionIdText)) {
        return yield* new AgentSessionError({
          agent,
          message: `Session ${sessionIdText} already holds an Agent binding in this process: close it, then resume it with agent ${JSON.stringify(agent)}.`,
          reason: "agent_session_bound",
        });
      }
      // Decision 16: bind before the Driver activates the Session, so recovery reads the Agent view.
      yield* bindAgentSession(
        sessionId,
        grants,
        plan.toolFilter === undefined ? [] : [plan.toolFilter],
        plan.turnOptions,
      );
      yield* driver.resumeSession(sessionId).pipe(
        // Only a Session the Journal does not hold is known to have no mailbox; every other
        // failure may leave it active, so it keeps the binding (fail closed).
        Effect.tapError((failure) =>
          Predicate.isTagged(failure, "JournalNotFound") &&
          failure.what === "session" &&
          failure.id === sessionIdText
            ? releaseAgentSession(sessionIdText)
            : Effect.void,
        ),
      );
      const filtersNow = Option.isSome(grants) ? yield* grants.value.filtersFor(sessionId) : [];
      const turnOptionsNow = (yield* Ref.get(agentTurnOptions)).get(sessionIdText);
      const intact =
        (plan.toolFilter === undefined || filtersNow.includes(plan.toolFilter)) &&
        (Object.keys(plan.turnOptions).length === 0 || turnOptionsNow === plan.turnOptions);
      if (!intact) {
        // Restore the binding before closing: a failed close must leave the Session restricted.
        yield* bindAgentSession(
          sessionId,
          grants,
          plan.toolFilter === undefined ? [] : [plan.toolFilter],
          plan.turnOptions,
        );
        yield* driver.closeSession(sessionId).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) ? releaseAgentSession(sessionIdText) : Effect.void,
          ),
          Effect.mapError(
            () =>
              new AgentSessionError({
                agent,
                message: `Session ${sessionIdText} was closed while it resumed as agent ${JSON.stringify(agent)}, and closing it again failed: it stays active with the Agent binding.`,
                reason: "agent_binding_lost",
              }),
          ),
        );
        return yield* new AgentSessionError({
          agent,
          message: `Session ${sessionIdText} was closed while it resumed as agent ${JSON.stringify(agent)}: it is closed again and holds no binding.`,
          reason: "agent_binding_lost",
        });
      }
      yield* logUngrantedTools(plan, sessionIdText);
      const snapshot = yield* driver.getSnapshot(sessionId);
      yield* writeSnapshot(id, snapshot, attached.has(sessionIdText));
    });

  const writeSnapshot = (
    id: string | undefined,
    snapshot: import("../compose.js").DriverSnapshot,
    isAttached: boolean,
  ): Effect.Effect<void, HeadWriteError> =>
    writeSnapshotResponse(transport, id, snapshot, isAttached, snapshotAudit);

  const handle: RpcSessionBridge["handle"] = (command, admission = RPC_NO_TURN_ADMISSION) =>
    Effect.suspend((): Effect.Effect<void, unknown> => {
      if (command._tag === "attach") {
        const sessionId = command.sessionId as string;
        return driver.getSnapshot(sessionId as unknown as SessionId).pipe(
          Effect.tap(() => Effect.sync(() => attached.add(sessionId))),
          Effect.flatMap((snapshot) => {
            if (command.interactive === false) {
              return writeSnapshot(command.id, snapshot, true);
            }
            const head: RpcInteractiveHead = {
              send: (request) => transport.send(request),
            };
            return Effect.sync(() => interactiveHeads.set(sessionId, head)).pipe(
              Effect.zipRight(interactions.attach(sessionId, head)),
              Effect.flatMap((pending) =>
                writeSnapshot(command.id, snapshot, true).pipe(
                  Effect.zipRight(Effect.forEach(pending, head.send, { discard: true })),
                ),
              ),
            );
          }),
        );
      }
      if (command._tag === "detach") {
        const sessionId = command.sessionId as string;
        return driver.getSnapshot(sessionId as unknown as SessionId).pipe(
          Effect.tap(() => Effect.sync(() => attached.delete(sessionId))),
          Effect.flatMap((snapshot) => {
            const subscription = progressSubscriptions.get(sessionId);
            if (subscription !== undefined) {
              progressSubscriptions.delete(sessionId);
            }
            const head = interactiveHeads.get(sessionId);
            if (head !== undefined) {
              interactiveHeads.delete(sessionId);
            }
            return Effect.all(
              [
                ...(subscription === undefined ? [] : [Fiber.interrupt(subscription)]),
                ...(head === undefined ? [] : [interactions.detach(sessionId, head)]),
              ],
              { discard: true },
            ).pipe(Effect.zipRight(writeSnapshot(command.id, snapshot, false)));
          }),
        );
      }
      if (command._tag === "interaction-response") {
        return interactions.respond(command as unknown as InteractionResponse);
      }
      if (command._tag === "abort") {
        return driver
          .abortTurn(command.sessionId as unknown as SessionId)
          .pipe(
            Effect.flatMap((result) => writeResponse(transport, command.id, abortResult(result))),
          );
      }
      if (command._tag === "branch") {
        return driver
          .branch(
            command.sessionId as unknown as SessionId,
            command.toEntryId as unknown as import("@dungle-scrubs/popeye-journal").EntryId,
            command.expectedRevision,
          )
          .pipe(
            Effect.flatMap((snapshot) =>
              writeSnapshot(command.id, snapshot, attached.has(command.sessionId as string)),
            ),
          );
      }
      if (command._tag === "close") {
        const sessionId = command.sessionId as string;
        return driver.closeSession(sessionId as unknown as SessionId).pipe(
          // RFC-04 §4 and §5: release the filters and turn options once the Driver close succeeds,
          // before the response, so a failed or interrupted delivery cannot skip it;
          // a failed close keeps the filters.
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) ? releaseAgentSession(sessionId) : Effect.void,
          ),
          Effect.flatMap((result) =>
            writeResponse(transport, command.id, {
              _tag: "closed" as const,
              cause: result.drainedWithinGrace ? ("clean" as const) : ("failed" as const),
              drainedWithinGrace: result.drainedWithinGrace,
              exitCode: result.drainedWithinGrace ? 0 : 1,
              sessionId,
            }),
          ),
          Effect.tap(() =>
            Effect.gen(function* () {
              const head = interactiveHeads.get(sessionId);
              if (head !== undefined) {
                yield* interactions.detach(sessionId, head);
              }
              const subscription = progressSubscriptions.get(sessionId);
              if (subscription !== undefined) {
                yield* Fiber.interrupt(subscription);
              }
              attached.delete(sessionId);
              interactiveHeads.delete(sessionId);
              progressSubscriptions.delete(sessionId);
            }),
          ),
        );
      }
      if (command._tag === "create") {
        if (command.agent !== undefined) {
          return createAgentSession(command.id, command.agent);
        }
        return driver.createSession().pipe(
          Effect.flatMap((session) => driver.getSnapshot(session.id)),
          Effect.flatMap((snapshot) => writeSnapshot(command.id, snapshot, false)),
        );
      }

      if (command._tag === "fork") {
        const parentIdText = command.sessionId as string;
        const parentId = parentIdText as unknown as SessionId;
        const fromEntryId = command.fromEntryId as unknown as EntryId;
        return Effect.gen(function* () {
          // RFC-04 §5: no input widens a Session's grant, so the child inherits the parent's
          // filters; it also inherits the persona and model (RFC-04 §4). Read before the fork, so
          // a racing close can only leave the child narrower.
          const grants = yield* Effect.serviceOption(SessionToolGrants);
          const parentFilters = Option.isSome(grants)
            ? yield* grants.value.filtersFor(parentId)
            : [];
          const parentTurnOptions = (yield* Ref.get(agentTurnOptions)).get(parentIdText);
          const snapshot =
            parentFilters.length === 0 && parentTurnOptions === undefined
              ? yield* driver.fork(parentId, fromEntryId, command.expectedRevision)
              : yield* driver.fork(parentId, fromEntryId, command.expectedRevision, {
                  // Bound before the copy (Decision 10): a failed copy leaves a restricted child.
                  bind: (childId) =>
                    bindAgentSession(childId, grants, parentFilters, parentTurnOptions),
                });
          yield* writeSnapshot(command.id, snapshot, false);
        });
      }

      if (command._tag === "get-snapshot") {
        const afterId = (command as { afterEntryId?: string }).afterEntryId as EntryId | undefined;
        const beforeId = (command as { beforeEntryId?: string }).beforeEntryId as
          | EntryId
          | undefined;
        const hasRange = afterId !== undefined || beforeId !== undefined;
        if (hasRange) {
          return Effect.gen(function* () {
            const snapshot = yield* driver.getSnapshot(command.sessionId as unknown as SessionId);
            const protocolInput = {
              entries: snapshot.entries,
              ...(snapshot.goal === undefined ? {} : { goal: snapshot.goal }),
              leafEntryId: snapshot.leaf.id,
              phase: snapshot.phase,
              revision: snapshot.revision,
              sessionId: snapshot.sessionId,
              ...(snapshot.model === undefined ? {} : { model: snapshot.model }),
              ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
              ...(snapshot.thinkingLevel === undefined
                ? {}
                : { thinkingLevel: snapshot.thinkingLevel }),
            };
            const sliced = snapshotView.sliceSnapshotByRange(
              protocolInput,
              (afterId ?? null) as EntryId | null,
              (beforeId ?? null) as EntryId | null,
            );
            if (!sliced.isValid) {
              const msg = sliced.error ?? "invalid range";
              if (msg.includes("not on branch") || msg.includes("not found")) {
                return yield* Effect.fail(
                  new JournalNotFound({
                    id: (afterId ?? beforeId ?? (command.sessionId as string)) as string,
                    what: "entry",
                  }),
                );
              }
              return yield* Effect.fail(
                new JournalError({ corruptionClass: "invalid_record_sequence", message: msg }),
              );
            }
            const isAttached = attached.has(command.sessionId as string);
            const payload = {
              _tag: "snapshot" as const,
              attached: isAttached,
              ...sliced.snapshot,
            };
            yield* transport.send({
              ...(command.id === undefined ? {} : { id: command.id }),
              result: payload,
            });
          });
        }
        return driver
          .getSnapshot(command.sessionId as unknown as SessionId)
          .pipe(
            Effect.flatMap((snapshot) =>
              writeSnapshot(command.id, snapshot, attached.has(command.sessionId as string)),
            ),
          );
      }
      if (command._tag === "invoke-command") {
        return driver
          .invokeCommand(
            command.sessionId as unknown as SessionId,
            command.name as string,
            command.args,
            command.expectedRevision,
          )
          .pipe(
            Effect.flatMap((value) =>
              writeResponse(transport, command.id, {
                _tag: "commandInvoked",
                commandName: command.name,
                value: value ?? null,
              }),
            ),
          );
      }
      if (command._tag === "list") {
        return driver.listSessions().pipe(
          Effect.flatMap((sessions) =>
            writeResponse(transport, command.id, {
              _tag: "sessionList",
              sessions,
            }),
          ),
        );
      }
      if (command._tag === "prompt") {
        return Ref.get(agentTurnOptions).pipe(
          Effect.flatMap((bound) =>
            driver.prompt(
              command.sessionId as unknown as SessionId,
              command.content as string,
              {
                // RFC-04 §4: an Agent Session's persona and model ride every prompt frame.
                ...bound.get(command.sessionId as string),
                ...(command.deliveryMode === undefined
                  ? {}
                  : { deliveryMode: command.deliveryMode as "steer" | "followUp" }),
                ...(command.expectedRevision === undefined
                  ? {}
                  : { expectedRevision: command.expectedRevision }),
              },
              admission.admitted,
            ),
          ),
          Effect.ensuring(admission.released),
          Effect.zipRight(driver.getSnapshot(command.sessionId as unknown as SessionId)),
          Effect.flatMap((snapshot) =>
            writeSnapshot(command.id, snapshot, attached.has(command.sessionId as string)),
          ),
        );
      }

      if (command._tag === "resume") {
        if (command.agent !== undefined) {
          return resumeAgentSession(command.id, command.sessionId as string, command.agent);
        }
        return driver.resumeSession(command.sessionId as unknown as SessionId).pipe(
          Effect.zipRight(driver.getSnapshot(command.sessionId as unknown as SessionId)),
          Effect.flatMap((snapshot) =>
            writeSnapshot(command.id, snapshot, attached.has(command.sessionId as string)),
          ),
        );
      }
      if (command._tag === "resume-goal") {
        return driver.resumeGoal(command.sessionId as unknown as SessionId).pipe(
          Effect.zipRight(driver.getSnapshot(command.sessionId as unknown as SessionId)),
          Effect.flatMap((snapshot) =>
            writeSnapshot(command.id, snapshot, attached.has(command.sessionId as string)),
          ),
        );
      }
      if (command._tag === "set-model") {
        return driver
          .setModel(
            command.sessionId as unknown as SessionId,
            command.model as string,
            command.expectedRevision,
          )
          .pipe(
            Effect.zipRight(driver.getSnapshot(command.sessionId as unknown as SessionId)),
            Effect.flatMap((snapshot) =>
              writeSnapshot(command.id, snapshot, attached.has(command.sessionId as string)),
            ),
          );
      }
      if (command._tag === "set-thinking") {
        return (
          driver.setThinkingLevel as unknown as (
            a: SessionId,
            b: string,
            c?: number,
          ) => Effect.Effect<unknown, unknown>
        )(
          command.sessionId as unknown as SessionId,
          command.thinkingLevel as string,
          command.expectedRevision,
        ).pipe(
          Effect.zipRight(driver.getSnapshot(command.sessionId as unknown as SessionId)),
          Effect.flatMap((snapshot) =>
            writeSnapshot(command.id, snapshot, attached.has(command.sessionId as string)),
          ),
        );
      }
      if (command._tag === "steer") {
        return driver
          .steer(command.sessionId as unknown as SessionId, command.content as string)
          .pipe(Effect.zipRight(writeResponse(transport, command.id, { _tag: "ack" })));
      }
      if (command._tag === "subscribe-progress") {
        return Effect.gen(function* () {
          const sessionId = command.sessionId as string;
          const existing = progressSubscriptions.get(sessionId);
          if (existing !== undefined) {
            yield* Fiber.interrupt(existing);
          }
          const subscription = yield* driver
            .subscribeProgress(sessionId as unknown as SessionId)
            .pipe(
              Stream.runForEach((progress) =>
                writeProgress(transport, sessionId, progress as object),
              ),
              Effect.fork,
            );
          progressSubscriptions.set(sessionId, subscription);
          yield* writeResponse(transport, command.id, {
            _tag: "progressSubscribed",
            sessionId,
            subscribed: true,
          });
        });
      }
      return Effect.die("RPC command routing is incomplete.");
    });

  const reportEndOfInput: RpcSessionBridge["reportEndOfInput"] = Effect.serviceOption(
    SessionLifecycle,
  ).pipe(
    Effect.flatMap((lifecycle) =>
      Option.isSome(lifecycle) ? lifecycle.value.headExitAll(driver.listSessions()) : Effect.void,
    ),
  );

  const cleanup: RpcSessionBridge["cleanup"] = Effect.all(
    [
      Effect.forEach(
        interactiveHeads,
        ([sessionId, head]) => interactions.detach(sessionId, head),
        { discard: true },
      ),
      Effect.forEach(progressSubscriptions.values(), Fiber.interrupt, { discard: true }),
    ],
    { discard: true },
  ).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        interactiveHeads.clear();
        progressSubscriptions.clear();
      }),
    ),
  );

  return { cleanup, handle, reportEndOfInput };
};
