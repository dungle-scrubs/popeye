/**
 * Owns RPC session lifecycle against Driver and RpcInteractions.
 * It exists so per-Session Driver sequencing, attach/detach
 * lifecycle, PluginInteractions wiring, Snapshot audit, and
 * Progress subscription management hide behind one deep interface.
 *
 * Why this module: rpc.ts was 1,168 lines, owning decode/routing
 * plus Driver effects plus interaction clock plus Plugin
 * Interactions wiring. Transport (367) and dispatch (344) were
 * extracted, but the Head itself remained a God-module. This
 * module owns the Driver-facing session handling, leaving rpc.ts
 * as thin router over RpcTransport + RpcDispatcher.
 * Not responsible for byte framing or JSON serialization
 * (rpc-transport owns that) or for dispatch policy/fairness
 * (rpc-dispatch owns that) or for wire error mapping
 * (rpc.ts router owns that).
 */

import type { SessionId } from "@pop-eye/journal";
import type { InteractionRequest, InteractionResponse } from "@pop-eye/protocol";
import { Effect, Fiber, Stream } from "effect";

import type { Driver } from "../compose.js";
import type { RpcInteractionsService } from "./rpc.js";
import type { HeadWriteError } from "./shared.js";
import { protocolSnapshot, type SnapshotAuditFields } from "./shared.js";

// ---------------------------------------------------------------------------
// Types shared with router (imported by rpc.ts for dispatch routing)
// ---------------------------------------------------------------------------

export type RpcInboundTag =
  | "attach"
  | "detach"
  | "interaction-response"
  | "abort"
  | "branch"
  | "create"
  | "fork"
  | "get-snapshot"
  | "invoke-command"
  | "list"
  | "prompt"
  | "resume"
  | "set-model"
  | "set-thinking"
  | "steer"
  | "subscribe-progress";

// Minimal command shape sufficient for bridge dispatch.
// The router decodes the full tagged struct and hands the unknown
// payload through; the bridge pattern-matches on _tag.
export type BridgeCommand = {
  readonly _tag: string;
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
  readonly handle: (command: BridgeCommand) => Effect.Effect<void, unknown>;
  readonly cleanup: Effect.Effect<void>;
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
  readonly driver: Driver["Type"];
  readonly interactions: RpcInteractionsService;
  readonly snapshotAudit?: SnapshotAuditFields;
  readonly transport: { readonly send: (payload: unknown) => Effect.Effect<void, HeadWriteError> };
}): RpcSessionBridge => {
  const { driver, interactions, snapshotAudit, transport } = options;

  // Invariant: mutated only in session-serialized handlers; it must become a Ref
  // if attach/detach becomes non-session-serialized.
  const attached = new Set<string>();
  const interactiveHeads = new Map<string, RpcInteractiveHead>();
  const progressSubscriptions = new Map<string, Fiber.RuntimeFiber<void, HeadWriteError>>();

  const writeSnapshot = (
    id: string | undefined,
    snapshot: import("../compose.js").DriverSnapshot,
    isAttached: boolean,
  ): Effect.Effect<void, HeadWriteError> =>
    writeSnapshotResponse(transport, id, snapshot, isAttached, snapshotAudit);

  const handle: RpcSessionBridge["handle"] = (command) =>
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
            command.toEntryId as unknown as import("@pop-eye/journal").EntryId,
            command.expectedRevision,
          )
          .pipe(
            Effect.flatMap((snapshot) =>
              writeSnapshot(command.id, snapshot, attached.has(command.sessionId as string)),
            ),
          );
      }
      if (command._tag === "create") {
        return driver.createSession().pipe(
          Effect.flatMap((session) => driver.getSnapshot(session.id)),
          Effect.flatMap((snapshot) => writeSnapshot(command.id, snapshot, false)),
        );
      }
      if (command._tag === "fork") {
        return driver
          .fork(
            command.sessionId as unknown as SessionId,
            command.fromEntryId as unknown as import("@pop-eye/journal").EntryId,
            command.expectedRevision,
          )
          .pipe(Effect.flatMap((snapshot) => writeSnapshot(command.id, snapshot, false)));
      }
      if (command._tag === "get-snapshot") {
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
        return driver
          .prompt(command.sessionId as unknown as SessionId, command.content as string, {
            ...(command.deliveryMode === undefined
              ? {}
              : { deliveryMode: command.deliveryMode as "steer" | "followUp" }),
            ...(command.expectedRevision === undefined
              ? {}
              : { expectedRevision: command.expectedRevision }),
          })
          .pipe(
            Effect.zipRight(driver.getSnapshot(command.sessionId as unknown as SessionId)),
            Effect.flatMap((snapshot) =>
              writeSnapshot(command.id, snapshot, attached.has(command.sessionId as string)),
            ),
          );
      }
      if (command._tag === "resume") {
        return driver.resumeSession(command.sessionId as unknown as SessionId).pipe(
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

  return { cleanup, handle };
};
