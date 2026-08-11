/**
 * Owns the long-lived stdio RPC Head that trusts Snapshots and streams Progress.
 * It exists so external processes can drive multiple Sessions over one connection. RPC framing
 * splits on LF only. Do not use Node readline: literal U+2028 and U+2029 are JSON content. See
 * pi's framing lesson: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md
 */

import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import type { SessionId } from "@pop-eye/journal";
import {
  type Command,
  decodeCommand,
  decodeInteractionResponse,
  type InteractionRequest,
  type InteractionResponse,
  InteractionTimeout,
  ProtocolError,
  type WireError,
} from "@pop-eye/protocol";
import {
  Cause,
  Chunk,
  Context,
  Data,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  Option,
  Ref,
  Schema,
  Stream,
} from "effect";

import { Driver, type DriverSnapshot } from "../compose.js";
import {
  HEAD_EXIT_CODES,
  type HeadExitCode,
  HeadWriteError,
  type HeadWriter,
  makeWritableLogfmtLogger,
  runHeadBoundary,
  stderrHeadWriter,
  stdoutHeadWriter,
} from "./shared.js";

export const MAX_RPC_FRAME_BYTES = 1024 * 1024;

export class RpcReadError extends Data.TaggedError("RpcReadError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export interface RpcHeadOptions {
  readonly errorWriter?: HeadWriter;
  readonly input: Readable;
  readonly loggerOutput?: Writable;
  readonly resumeSessionId?: SessionId;
  readonly writer?: HeadWriter;
}

const AttachCommandSchema = Schema.TaggedStruct("attach", {
  id: Schema.optional(Schema.String),
  interactive: Schema.optional(Schema.Boolean),
  sessionId: Schema.NonEmptyString.pipe(Schema.brand("SessionId")),
});

const DetachCommandSchema = Schema.TaggedStruct("detach", {
  id: Schema.optional(Schema.String),
  sessionId: Schema.NonEmptyString.pipe(Schema.brand("SessionId")),
});

type AttachCommand = Schema.Schema.Type<typeof AttachCommandSchema>;
type DetachCommand = Schema.Schema.Type<typeof DetachCommandSchema>;
type RpcInboundCommand = AttachCommand | Command | DetachCommand | InteractionResponse;

export interface RpcInteractionResolution {
  readonly error?: InteractionTimeout;
  readonly response: InteractionResponse;
  readonly source: "fallback" | "head";
}

interface RpcInteractiveHead {
  readonly send: (request: InteractionRequest) => Effect.Effect<void, HeadWriteError>;
}

interface PendingInteraction {
  readonly deferred: Deferred.Deferred<RpcInteractionResolution>;
  readonly request: InteractionRequest;
  readonly sessionId: string;
}

interface RpcInteractionState {
  // One Head per Session is safe for today's single stdio connection. A future multi-connection
  // host must key ownership by connection as well, or one connection could replace another's Head.
  readonly heads: ReadonlyMap<string, RpcInteractiveHead>;
  readonly pending: ReadonlyMap<string, PendingInteraction>;
}

type InteractionAdmission =
  | { readonly _tag: "accepted"; readonly head: RpcInteractiveHead | undefined }
  | { readonly _tag: "duplicate" };

export interface RpcInteractionsService {
  readonly attach: (
    sessionId: string,
    head: RpcInteractiveHead,
  ) => Effect.Effect<ReadonlyArray<InteractionRequest>>;
  readonly detach: (sessionId: string, head: RpcInteractiveHead) => Effect.Effect<void>;
  readonly request: (
    sessionId: string,
    request: InteractionRequest,
  ) => Effect.Effect<RpcInteractionResolution, HeadWriteError | ProtocolError>;
  readonly respond: (response: InteractionResponse) => Effect.Effect<void, ProtocolError>;
}

export class RpcInteractions extends Context.Tag("@pop-eye/cli/RpcInteractions")<
  RpcInteractions,
  RpcInteractionsService
>() {}

const interactionProtocolError = (message: string): ProtocolError =>
  new ProtocolError({ message, reason: "phase_invalid_command" });

const fallbackResponse = (request: InteractionRequest): InteractionResponse => {
  switch (request.kind) {
    case "confirm":
      return {
        _tag: "interaction-response",
        id: request.id,
        kind: "confirm",
        value: request.fallback.value,
      };
    case "input":
      return {
        _tag: "interaction-response",
        id: request.id,
        kind: "input",
        value: request.fallback.value,
      };
    case "select":
      return {
        _tag: "interaction-response",
        id: request.id,
        kind: "select",
        value: request.fallback.value,
      };
  }
};

const fallbackResolution = (request: InteractionRequest): RpcInteractionResolution => ({
  error: new InteractionTimeout({ requestId: request.id, timeoutMs: request.timeoutMs }),
  response: fallbackResponse(request),
  source: "fallback",
});

const reportInteractionFallback = (
  pending: PendingInteraction,
  outcome: "head_detached" | "timeout",
): Effect.Effect<void> =>
  Effect.logWarning("RPC interaction resolved with its fallback.").pipe(
    Effect.annotateLogs({
      diagnostic: "interaction_timeout",
      outcome,
      requestId: pending.request.id,
      sessionId: pending.sessionId,
      timeoutMs: pending.request.timeoutMs,
    }),
  );

export const RpcInteractionsLive: Layer.Layer<RpcInteractions> = Layer.effect(
  RpcInteractions,
  Effect.gen(function* () {
    const state = yield* Ref.make<RpcInteractionState>({ heads: new Map(), pending: new Map() });

    const attach: RpcInteractionsService["attach"] = (sessionId, head) =>
      Ref.modify(state, (current) => {
        const heads = new Map(current.heads);
        heads.set(sessionId, head);
        const pending = [...current.pending.values()]
          .filter((item) => item.sessionId === sessionId)
          .map((item) => item.request);
        return [pending, { ...current, heads }];
      });

    const detach: RpcInteractionsService["detach"] = (sessionId, head) =>
      Effect.gen(function* () {
        const detached = yield* Ref.modify(state, (current) => {
          if (current.heads.get(sessionId) !== head) {
            return [[], current];
          }
          const heads = new Map(current.heads);
          heads.delete(sessionId);
          const pending = new Map(current.pending);
          const removed: Array<PendingInteraction> = [];
          for (const [requestId, item] of pending) {
            if (item.sessionId === sessionId) {
              removed.push(item);
              pending.delete(requestId);
            }
          }
          return [removed, { heads, pending }];
        });
        yield* Effect.forEach(
          detached,
          (pending) =>
            Deferred.succeed(pending.deferred, fallbackResolution(pending.request)).pipe(
              Effect.zipRight(reportInteractionFallback(pending, "head_detached")),
            ),
          { discard: true },
        );
      });

    const request: RpcInteractionsService["request"] = (sessionId, interactionRequest) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<RpcInteractionResolution>();
        const admission = yield* Ref.modify<RpcInteractionState, InteractionAdmission>(
          state,
          (current) => {
            if (current.pending.has(interactionRequest.id)) {
              return [{ _tag: "duplicate" }, current];
            }
            const pending = new Map(current.pending);
            pending.set(interactionRequest.id, {
              deferred,
              request: interactionRequest,
              sessionId,
            });
            return [
              { _tag: "accepted", head: current.heads.get(sessionId) },
              { ...current, pending },
            ];
          },
        );
        if (admission._tag === "duplicate") {
          return yield* interactionProtocolError(
            `Interaction request ${interactionRequest.id} is already pending.`,
          );
        }
        if (admission.head !== undefined) {
          yield* admission.head.send(interactionRequest);
        }
        const timeoutFallback = Effect.sleep(interactionRequest.timeoutMs).pipe(
          Effect.zipRight(
            Ref.modify(state, (current) => {
              const pending = current.pending.get(interactionRequest.id);
              if (pending?.deferred !== deferred) {
                return [false, current];
              }
              const next = new Map(current.pending);
              next.delete(interactionRequest.id);
              return [true, { ...current, pending: next }];
            }),
          ),
          Effect.flatMap((timedOut) => {
            if (!timedOut) {
              return Deferred.await(deferred);
            }
            const pending: PendingInteraction = {
              deferred,
              request: interactionRequest,
              sessionId,
            };
            return reportInteractionFallback(pending, "timeout").pipe(
              Effect.as(fallbackResolution(interactionRequest)),
            );
          }),
        );
        return yield* Effect.raceFirst(Deferred.await(deferred), timeoutFallback);
      });

    const respond: RpcInteractionsService["respond"] = (response) =>
      Effect.gen(function* () {
        const pending = yield* Ref.get(state).pipe(
          Effect.map((current) => current.pending.get(response.id)),
        );
        if (pending === undefined) {
          return yield* interactionProtocolError(
            `Interaction response ${response.id} has no pending request.`,
          );
        }
        if (pending.request.kind !== response.kind) {
          return yield* interactionProtocolError(
            `Interaction response ${response.id} kind does not match its request.`,
          );
        }
        yield* Ref.update(state, (current) => {
          const next = new Map(current.pending);
          next.delete(response.id);
          return { ...current, pending: next };
        });
        yield* Deferred.succeed(pending.deferred, { response, source: "head" });
      });

    return { attach, detach, request, respond } satisfies RpcInteractionsService;
  }),
);

const decodeChunk = (decoder: StringDecoder, chunk: unknown): string => {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return decoder.write(chunk);
  }
  throw new TypeError("RPC input produced a non-byte chunk.");
};

const readStrictLfFrames = async function* (input: Readable): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let pending = "";

  for await (const chunk of input as AsyncIterable<unknown>) {
    pending += decodeChunk(decoder, chunk);
    let separator = pending.indexOf("\n");
    while (separator >= 0) {
      const raw = pending.slice(0, separator);
      pending = pending.slice(separator + 1);
      const frameBytes = Buffer.byteLength(raw);
      if (frameBytes > MAX_RPC_FRAME_BYTES) {
        throw new ProtocolError({
          message: `RPC frame exceeded the ${MAX_RPC_FRAME_BYTES}-byte limit.`,
          reason: "malformed_frame",
        });
      }
      const frame = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (frame.length > 0) {
        yield frame;
      }
      separator = pending.indexOf("\n");
    }
    if (Buffer.byteLength(pending) > MAX_RPC_FRAME_BYTES) {
      throw new ProtocolError({
        message: `RPC frame exceeded the ${MAX_RPC_FRAME_BYTES}-byte limit before LF.`,
        reason: "malformed_frame",
      });
    }
  }

  decoder.end();
  // A partial trailing line at EOF is not a frame.
};

export const strictLfFrames = (
  input: Readable,
): Stream.Stream<string, ProtocolError | RpcReadError> =>
  Stream.fromAsyncIterable(readStrictLfFrames(input), (cause) =>
    cause instanceof ProtocolError
      ? cause
      : new RpcReadError({ cause, message: `RPC input failed: ${String(cause)}` }),
  );

const parseJsonFrame = (frame: string): Effect.Effect<unknown, ProtocolError> =>
  Effect.try({
    catch: (cause) =>
      new ProtocolError({
        cause,
        message: `Malformed JSON frame: ${String(cause)}`,
        reason: "malformed_frame",
      }),
    try: () => JSON.parse(frame) as unknown,
  });

const frameTag = (frame: unknown): string | undefined =>
  typeof frame === "object" && frame !== null && "_tag" in frame && typeof frame._tag === "string"
    ? frame._tag
    : undefined;

const frameStringField = (frame: string, field: "_tag" | "id"): string | undefined => {
  // Best-effort correlation for malformed JSON only. Decoded frames use their Schema-owned id.
  const match = new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`, "u").exec(frame);
  return match?.[1];
};

const localCommandError = (cause: unknown): ProtocolError =>
  new ProtocolError({
    cause,
    message: `Malformed RPC Head command: ${String(cause)}`,
    reason: "malformed_frame",
  });

const decodeAttachCommand = (input: unknown): Effect.Effect<AttachCommand, ProtocolError> =>
  Schema.decodeUnknown(AttachCommandSchema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(localCommandError),
  );

const decodeDetachCommand = (input: unknown): Effect.Effect<DetachCommand, ProtocolError> =>
  Schema.decodeUnknown(DetachCommandSchema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(localCommandError),
  );

const decodeRpcInboundCommand = (frame: string): Effect.Effect<RpcInboundCommand, ProtocolError> =>
  parseJsonFrame(frame).pipe(
    Effect.flatMap((input): Effect.Effect<RpcInboundCommand, ProtocolError> => {
      const tag = frameTag(input);
      if (tag === "attach") {
        return decodeAttachCommand(input);
      }
      if (tag === "detach") {
        return decodeDetachCommand(input);
      }
      if (tag === "interaction-response") {
        return decodeInteractionResponse(input);
      }
      return decodeCommand(input);
    }),
  );

const connectionSnapshot = (snapshot: DriverSnapshot, attached: boolean) => ({
  _tag: "snapshot" as const,
  attached,
  entries: snapshot.entries,
  leafEntryId: snapshot.leaf.id,
  ...(snapshot.model === undefined ? {} : { model: snapshot.model }),
  ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
  phase: snapshot.phase,
  revision: snapshot.revision,
  sessionId: snapshot.sessionId,
  ...(snapshot.thinkingLevel === undefined ? {} : { thinkingLevel: snapshot.thinkingLevel }),
});

const writeResponse = (
  writer: HeadWriter,
  id: string | undefined,
  result: unknown,
): Effect.Effect<void, HeadWriteError> =>
  writer.write(`${JSON.stringify({ ...(id === undefined ? {} : { id }), result })}\n`);

const writeSnapshotResponse = (
  writer: HeadWriter,
  id: string | undefined,
  snapshot: DriverSnapshot,
  attached: boolean,
): Effect.Effect<void, HeadWriteError> =>
  writeResponse(writer, id, connectionSnapshot(snapshot, attached));

const writeProtocolError = (
  writer: HeadWriter,
  id: string | undefined,
  error: ProtocolError,
): Effect.Effect<void, HeadWriteError> =>
  writer.write(
    `${JSON.stringify({
      error: {
        code: "protocol_error",
        details: { reason: error.reason, tag: error._tag },
        message: error.message,
      },
      ...(id === undefined ? {} : { id }),
    })}\n`,
  );

const unknownRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : {};

const taggedErrorName = (value: unknown, fallback: string): string => {
  const record = unknownRecord(value);
  if (typeof record._tag === "string") {
    return record._tag;
  }
  return value instanceof Error ? value.name : fallback;
};

const taggedErrorMessage = (value: unknown): string => {
  const record = unknownRecord(value);
  return typeof record.message === "string" ? record.message : String(value);
};

const numberField = (
  record: Readonly<Record<string, unknown>>,
  field: string,
): number | undefined => (typeof record[field] === "number" ? record[field] : undefined);

const stringField = (
  record: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined => (typeof record[field] === "string" ? record[field] : undefined);

const wireErrorFromFailure = (
  failure: unknown,
  kind: "defect" | "failure" = "failure",
): WireError => {
  const record = unknownRecord(failure);
  const tag = taggedErrorName(failure, kind === "defect" ? "Defect" : "Failure");
  const message = taggedErrorMessage(failure);

  switch (tag) {
    case "BudgetExceeded":
      return {
        code: "budget_exceeded",
        details: {
          budget: numberField(record, "budget"),
          compactionApplied: stringField(record, "compactionApplied"),
          optionsDiagnostic: stringField(record, "optionsDiagnostic"),
          required: numberField(record, "required"),
          tag,
        },
        message,
      };
    case "CompactionDisabled":
      return {
        code: "compaction_disabled",
        details: { sessionId: stringField(record, "sessionId"), tag },
        message,
      };
    case "GateRejected":
      return {
        code: "gate_rejected",
        details: {
          plugin: stringField(record, "plugin"),
          reason: stringField(record, "reason"),
          tag,
        },
        message,
      };
    case "InteractionTimeout":
      return {
        code: "interaction_timeout",
        details: {
          requestId: stringField(record, "requestId"),
          tag,
          timeoutMs: numberField(record, "timeoutMs"),
        },
        message,
      };
    case "InvokeCommandError":
      return {
        code: "invoke_command_error",
        details: {
          commandName: stringField(record, "commandName"),
          reason: stringField(record, "reason"),
          tag,
        },
        message,
      };
    case "JournalDraftRejected":
      return {
        code: "journal_error",
        details: {
          kind: stringField(record, "kind"),
          reason: stringField(record, "reason"),
          tag,
        },
        message,
      };
    case "JournalError":
      return {
        code: "journal_error",
        details: {
          corruptionClass: stringField(record, "corruptionClass"),
          file: stringField(record, "file"),
          tag,
        },
        message,
      };
    case "JournalNotFound": {
      const what = stringField(record, "what");
      return {
        code: what === "session" ? "session_not_found" : "journal_error",
        details: { id: stringField(record, "id"), tag, what },
        message,
      };
    }
    case "MailboxClosed":
      return {
        code: "mailbox_closed",
        details: { sessionId: stringField(record, "sessionId"), tag },
        message,
      };
    case "MailboxFull":
      return {
        code: "mailbox_full",
        details: {
          capacity: numberField(record, "capacity"),
          sessionId: stringField(record, "sessionId"),
          tag,
        },
        message,
      };
    case "MailboxSessionNotFound":
      return {
        code: "session_not_found",
        details: { sessionId: stringField(record, "sessionId"), tag },
        message: `Session ${stringField(record, "sessionId") ?? "unknown"} was not found.`,
      };
    case "NothingToCompact":
      return {
        code: "nothing_to_compact",
        details: { sessionId: stringField(record, "sessionId"), tag },
        message,
      };
    case "ProtocolError":
      return {
        code: "protocol_error",
        details: { reason: stringField(record, "reason"), tag },
        message,
      };
    case "ProviderError":
      return {
        code: "provider_error",
        details: {
          status: numberField(record, "status"),
          tag,
          transient: record.transient,
        },
        message,
      };
    case "StaleRevision": {
      const actual = numberField(record, "actual");
      const expected = numberField(record, "expected");
      return {
        code: "stale_revision",
        details: { actual, expected, tag },
        message: `Expected revision ${expected ?? "unknown"}, current revision is ${actual ?? "unknown"}.`,
      };
    }
    case "ToolError":
      return {
        code: "tool_error",
        details: {
          tag,
          toolCallId: stringField(record, "toolCallId"),
          toolName: stringField(record, "toolName"),
        },
        message,
      };
    case "TurnQueueFull":
      return {
        code: "turn_queue_full",
        details: {
          capacity: numberField(record, "capacity"),
          queue: stringField(record, "queue"),
          sessionId: stringField(record, "sessionId"),
          tag,
        },
        message,
      };
    default:
      return {
        code: "protocol_error",
        details: { kind, tag },
        message,
      };
  }
};

const writeWireError = (
  writer: HeadWriter,
  id: string | undefined,
  error: WireError,
): Effect.Effect<void, HeadWriteError> =>
  writer.write(`${JSON.stringify({ error, ...(id === undefined ? {} : { id }) })}\n`);

const firstCauseError = <TFailure>(
  cause: Cause.Cause<TFailure>,
): { readonly kind: "defect" | "failure"; readonly value: unknown } | undefined => {
  const failure = Option.getOrUndefined(Cause.failureOption(cause));
  if (failure !== undefined) {
    return { kind: "failure", value: failure };
  }
  const defect = Option.getOrUndefined(Chunk.head(Cause.defects(cause)));
  return defect === undefined ? undefined : { kind: "defect", value: defect };
};

const handleFrameCause = <TFailure>(
  writer: HeadWriter,
  id: string | undefined,
  commandName: string,
  cause: Cause.Cause<TFailure>,
): Effect.Effect<void, unknown> => {
  const selected = firstCauseError(cause);
  if (
    Cause.isInterruptedOnly(cause) ||
    (selected?.kind === "failure" && selected.value instanceof HeadWriteError)
  ) {
    return Effect.failCause(cause);
  }
  if (selected === undefined) {
    return Effect.failCause(cause);
  }

  const error = wireErrorFromFailure(selected.value, selected.kind);
  const report =
    error.code === "protocol_error" && taggedErrorName(selected.value, "") === "ProtocolError"
      ? Effect.logWarning("RPC protocol frame rejected.").pipe(
          Effect.annotateLogs({
            command: commandName,
            diagnostic: "protocol_error",
            reason: stringField(unknownRecord(selected.value), "reason"),
          }),
        )
      : Effect.logError("RPC command failed.").pipe(
          Effect.annotateLogs({
            command: commandName,
            diagnostic: "command_error",
            errorCode: error.code,
            errorTag: taggedErrorName(selected.value, selected.kind),
          }),
        );

  return Effect.annotateCurrentSpan({ outcome: error.code }).pipe(
    Effect.zipRight(report),
    Effect.zipRight(writeWireError(writer, id, error)),
  );
};

const writeProgress = (
  writer: HeadWriter,
  sessionId: string,
  progress: object,
): Effect.Effect<void, HeadWriteError> =>
  writer.write(`${JSON.stringify({ ...progress, sessionId })}\n`);

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

export const runRpcHead = (options: RpcHeadOptions) => {
  const writer = options.writer ?? stdoutHeadWriter;
  return runHeadBoundary(
    Effect.gen(function* () {
      const attached = new Set<string>();
      const driver = yield* Driver;
      const interactions = yield* RpcInteractions;
      const interactiveHeads = new Map<string, RpcInteractiveHead>();
      const progressSubscriptions = new Map<string, Fiber.RuntimeFiber<void, HeadWriteError>>();

      if (options.resumeSessionId !== undefined) {
        yield* driver.resumeSession(options.resumeSessionId);
      }

      const run = strictLfFrames(options.input).pipe(
        Stream.runForEach((frame) => {
          const commandName = frameStringField(frame, "_tag") ?? "malformed";
          let correlationId = frameStringField(frame, "id");
          return decodeRpcInboundCommand(frame).pipe(
            Effect.tap((command) =>
              Effect.sync(() => {
                correlationId = command.id;
              }),
            ),
            Effect.flatMap((command): Effect.Effect<void, unknown> => {
              if (command._tag === "attach") {
                return driver.getSnapshot(command.sessionId).pipe(
                  Effect.tap(() => Effect.sync(() => attached.add(command.sessionId))),
                  Effect.flatMap((snapshot) =>
                    writeSnapshotResponse(writer, command.id, snapshot, true),
                  ),
                  Effect.flatMap(() => {
                    if (command.interactive === false) {
                      return Effect.void;
                    }
                    const head: RpcInteractiveHead = {
                      send: (request) => writer.write(`${JSON.stringify(request)}\n`),
                    };
                    interactiveHeads.set(command.sessionId, head);
                    return interactions
                      .attach(command.sessionId, head)
                      .pipe(
                        Effect.flatMap((pending) =>
                          Effect.forEach(pending, head.send, { discard: true }),
                        ),
                      );
                  }),
                );
              }
              if (command._tag === "detach") {
                return driver.getSnapshot(command.sessionId).pipe(
                  Effect.tap(() => Effect.sync(() => attached.delete(command.sessionId))),
                  Effect.flatMap((snapshot) =>
                    writeSnapshotResponse(writer, command.id, snapshot, false),
                  ),
                  Effect.flatMap(() => {
                    const subscription = progressSubscriptions.get(command.sessionId);
                    if (subscription !== undefined) {
                      progressSubscriptions.delete(command.sessionId);
                    }
                    const head = interactiveHeads.get(command.sessionId);
                    return Effect.all(
                      [
                        ...(subscription === undefined ? [] : [Fiber.interrupt(subscription)]),
                        ...(head === undefined
                          ? []
                          : [
                              Effect.sync(() => interactiveHeads.delete(command.sessionId)).pipe(
                                Effect.zipRight(interactions.detach(command.sessionId, head)),
                              ),
                            ]),
                      ],
                      { discard: true },
                    );
                  }),
                );
              }
              if (command._tag === "interaction-response") {
                return interactions.respond(command);
              }
              if (command._tag === "abort") {
                return driver
                  .abortTurn(command.sessionId)
                  .pipe(
                    Effect.flatMap((result) =>
                      writeResponse(writer, command.id, abortResult(result)),
                    ),
                  );
              }
              if (command._tag === "branch") {
                return driver
                  .branch(command.sessionId, command.toEntryId, command.expectedRevision)
                  .pipe(
                    Effect.flatMap((snapshot) =>
                      writeSnapshotResponse(
                        writer,
                        command.id,
                        snapshot,
                        attached.has(command.sessionId),
                      ),
                    ),
                  );
              }
              if (command._tag === "create") {
                return driver.createSession().pipe(
                  Effect.flatMap((session) => driver.getSnapshot(session.id)),
                  Effect.flatMap((snapshot) =>
                    writeSnapshotResponse(writer, command.id, snapshot, false),
                  ),
                );
              }
              if (command._tag === "fork") {
                return driver
                  .fork(command.sessionId, command.fromEntryId, command.expectedRevision)
                  .pipe(
                    Effect.flatMap((snapshot) =>
                      writeSnapshotResponse(writer, command.id, snapshot, false),
                    ),
                  );
              }
              if (command._tag === "get-snapshot") {
                return driver
                  .getSnapshot(command.sessionId)
                  .pipe(
                    Effect.flatMap((snapshot) =>
                      writeSnapshotResponse(
                        writer,
                        command.id,
                        snapshot,
                        attached.has(command.sessionId),
                      ),
                    ),
                  );
              }
              if (command._tag === "invoke-command") {
                return driver
                  .invokeCommand(
                    command.sessionId,
                    command.name,
                    command.args,
                    command.expectedRevision,
                  )
                  .pipe(
                    Effect.flatMap((value) =>
                      writeResponse(writer, command.id, {
                        _tag: "commandInvoked",
                        commandName: command.name,
                        value: value ?? null,
                      }),
                    ),
                  );
              }
              if (command._tag === "list") {
                return driver
                  .listSessions()
                  .pipe(
                    Effect.flatMap((sessions) =>
                      writeResponse(writer, command.id, { _tag: "sessionList", sessions }),
                    ),
                  );
              }
              if (command._tag === "prompt") {
                return driver
                  .prompt(command.sessionId, command.content, {
                    ...(command.deliveryMode === undefined
                      ? {}
                      : { deliveryMode: command.deliveryMode }),
                    ...(command.expectedRevision === undefined
                      ? {}
                      : { expectedRevision: command.expectedRevision }),
                  })
                  .pipe(
                    Effect.zipRight(driver.getSnapshot(command.sessionId)),
                    Effect.flatMap((snapshot) =>
                      writeSnapshotResponse(
                        writer,
                        command.id,
                        snapshot,
                        attached.has(command.sessionId),
                      ),
                    ),
                  );
              }
              if (command._tag === "resume") {
                return driver.resumeSession(command.sessionId).pipe(
                  Effect.zipRight(driver.getSnapshot(command.sessionId)),
                  Effect.flatMap((snapshot) =>
                    writeSnapshotResponse(
                      writer,
                      command.id,
                      snapshot,
                      attached.has(command.sessionId),
                    ),
                  ),
                );
              }
              if (command._tag === "set-model") {
                return driver
                  .setModel(command.sessionId, command.model, command.expectedRevision)
                  .pipe(
                    Effect.zipRight(driver.getSnapshot(command.sessionId)),
                    Effect.flatMap((snapshot) =>
                      writeSnapshotResponse(
                        writer,
                        command.id,
                        snapshot,
                        attached.has(command.sessionId),
                      ),
                    ),
                  );
              }
              if (command._tag === "set-thinking") {
                return driver
                  .setThinkingLevel(
                    command.sessionId,
                    command.thinkingLevel,
                    command.expectedRevision,
                  )
                  .pipe(
                    Effect.zipRight(driver.getSnapshot(command.sessionId)),
                    Effect.flatMap((snapshot) =>
                      writeSnapshotResponse(
                        writer,
                        command.id,
                        snapshot,
                        attached.has(command.sessionId),
                      ),
                    ),
                  );
              }
              if (command._tag === "steer") {
                return driver
                  .steer(command.sessionId, command.content)
                  .pipe(Effect.zipRight(writeResponse(writer, command.id, { _tag: "ack" })));
              }
              if (command._tag === "subscribe-progress") {
                return writeResponse(writer, command.id, {
                  _tag: "progressSubscribed",
                  sessionId: command.sessionId,
                  subscribed: true,
                }).pipe(
                  Effect.zipRight(
                    Effect.gen(function* () {
                      const existing = progressSubscriptions.get(command.sessionId);
                      if (existing !== undefined) {
                        yield* Fiber.interrupt(existing);
                      }
                      const subscription = yield* driver.subscribeProgress(command.sessionId).pipe(
                        Stream.runForEach((progress) =>
                          writeProgress(writer, command.sessionId, progress),
                        ),
                        Effect.fork,
                      );
                      progressSubscriptions.set(command.sessionId, subscription);
                    }),
                  ),
                );
              }
              return Effect.die("RPC command routing is incomplete.");
            }),
            Effect.tap(() => Effect.annotateCurrentSpan({ outcome: "ok" })),
            Effect.catchAllCause((cause) =>
              handleFrameCause(writer, correlationId, commandName, cause),
            ),
            Effect.withSpan("rpc.frame", { attributes: { command: commandName } }),
          );
        }),
      );

      yield* run.pipe(
        Effect.catchIf(
          (error): error is ProtocolError => error instanceof ProtocolError,
          (error) =>
            Effect.logWarning("RPC input closed after an oversized frame.").pipe(
              Effect.annotateLogs({
                diagnostic: "protocol_error",
                reason: error.reason,
              }),
              Effect.zipRight(writeProtocolError(writer, undefined, error)),
            ),
        ),
        Effect.ensuring(
          Effect.all(
            [
              Effect.forEach(
                interactiveHeads,
                ([sessionId, head]) => interactions.detach(sessionId, head),
                { discard: true },
              ),
              Effect.forEach(progressSubscriptions.values(), Fiber.interrupt, { discard: true }),
            ],
            { discard: true },
          ),
        ),
      );

      return HEAD_EXIT_CODES.done satisfies HeadExitCode;
    }),
    options.errorWriter ?? stderrHeadWriter,
  ).pipe(
    Effect.provide(
      Logger.replace(
        Logger.defaultLogger,
        makeWritableLogfmtLogger(options.loggerOutput ?? process.stderr),
      ),
    ),
  );
};
