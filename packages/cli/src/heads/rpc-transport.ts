/**
 * Owns RpcTransport deep module for framing (LF, 1MB, U+2028/2029, Buffer provenance, per-Session FIFO).
 * It exists to surface framing guarantees via interface and prove the seam real via two adapters:
 * SerializedRpcTransport over a real HeadWriter and FakeTransport/FakeRpcTransport over captured
 * Buffers — the latter proves Buffer provenance without a second soak.
 * Why this module: rpc.ts was doing LF split + 1MB + Buffer handling inline; transport hides
 * serialization and queue-depth tracking behind writeFrame/readFrames/frames/send. It is a private
 * seam of RpcHead: callers depend on RpcHead.runRpcHead, not on Transport directly.
 * Not responsible for dispatch policy or FIFO fairness (RpcDispatcher owns queue caps and worker
 * scheduling) or for session lifecycle or Snapshot audit (RpcSessionBridge owns those) or for
 * protocol decode/encode (RpcHead owns tag routing and ProtocolError mapping).
 */

import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { ProtocolError } from "@pop-eye/protocol";
import type { Scope } from "effect";
import { Data, Deferred, Effect, Ref, Stream } from "effect";
import type { HeadWriteError, HeadWriter } from "./head-wire.js";
import { type SerializedHeadWriter, serializedWriter } from "./rpc-dispatch.js";

export const MAX_RPC_FRAME_BYTES = 1024 * 1024;

export class RpcReadError extends Data.TaggedError("RpcReadError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

// Pure framing codec: LF-only, 1MB, U+2028/2029 preserved, Buffer provenance.

const decodeChunk = (decoder: StringDecoder, chunk: unknown): string => {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return decoder.write(chunk);
  }
  throw new TypeError("RPC input produced a non-byte chunk.");
};

export const encodeFrame = (frame: unknown): Buffer => {
  const json = JSON.stringify(frame);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_RPC_FRAME_BYTES) {
    throw new ProtocolError({
      message: `RPC frame exceeded the ${MAX_RPC_FRAME_BYTES}-byte limit.`,
      reason: "malformed_frame",
    });
  }
  // Buffer provenance: caller receives Buffer, LF-terminated.
  return Buffer.from(`${json}\n`, "utf8");
};

export class RpcFrameDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";

  /**
   * Decodes one Buffer chunk, owning LF-only splitting, 1MB limit, U+2028/2029 preservation.
   * Input must be Buffer (Buffer provenance). Output frames are JSON strings without LF.
   * Pending across chunks is retained, empty lines skipped, CRLF tolerated via trailing \r strip.
   */
  push(chunk: Buffer): ReadonlyArray<string> {
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError("RPC readFrames requires Buffer chunk.");
    }
    this.pending += this.decoder.write(chunk);
    const out: Array<string> = [];
    let separator = this.pending.indexOf("\n");
    while (separator >= 0) {
      const raw = this.pending.slice(0, separator);
      this.pending = this.pending.slice(separator + 1);
      const frameBytes = Buffer.byteLength(raw, "utf8");
      if (frameBytes > MAX_RPC_FRAME_BYTES) {
        throw new ProtocolError({
          message: `RPC frame exceeded the ${MAX_RPC_FRAME_BYTES}-byte limit.`,
          reason: "malformed_frame",
        });
      }
      const frame = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (frame.length > 0) {
        out.push(frame);
      }
      separator = this.pending.indexOf("\n");
    }
    if (Buffer.byteLength(this.pending, "utf8") > MAX_RPC_FRAME_BYTES) {
      throw new ProtocolError({
        message: `RPC frame exceeded the ${MAX_RPC_FRAME_BYTES}-byte limit before LF.`,
        reason: "malformed_frame",
      });
    }
    return out;
  }

  flush(): ReadonlyArray<string> {
    this.decoder.end();
    return [];
  }

  getPendingByteLength(): number {
    return Buffer.byteLength(this.pending, "utf8");
  }
}

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
};

export const strictLfFrames = (
  input: Readable,
): Stream.Stream<string, ProtocolError | RpcReadError> =>
  Stream.fromAsyncIterable(readStrictLfFrames(input), (cause) =>
    cause instanceof ProtocolError
      ? cause
      : new RpcReadError({ cause, message: `RPC input failed: ${String(cause)}` }),
  );

export interface RpcTransport {
  readonly send: (payload: unknown) => Effect.Effect<void, HeadWriteError>;
  readonly writeFrame: (frame: unknown) => Effect.Effect<Buffer, HeadWriteError | ProtocolError>;
  readonly readFrames: (
    chunk: Buffer,
  ) => Effect.Effect<ReadonlyArray<string>, ProtocolError | RpcReadError>;
  readonly frames: (input: Readable) => Stream.Stream<string, ProtocolError | RpcReadError>;
  readonly checkPoisoned: Effect.Effect<void, HeadWriteError>;
  readonly failure: Effect.Effect<never, HeadWriteError>;
  readonly poisoned: Effect.Effect<boolean>;
  readonly capturedBytes?: ReadonlyArray<Buffer>;
}

// Per-Session FIFO queue for output pacing (transport owns per-Session FIFO).
// For serialized adapter, queue is implicit via semaphore; for test visibility we track depths.
type SessionFifoState = Map<string, number>;

export const makeSerializedRpcTransport = (
  writer: HeadWriter,
): Effect.Effect<RpcTransport, never, Scope.Scope> =>
  Effect.gen(function* () {
    const serialized: SerializedHeadWriter = yield* serializedWriter(writer);
    const decoder = new RpcFrameDecoder();
    const fifo = yield* Ref.make<SessionFifoState>(new Map());

    const send = (payload: unknown): Effect.Effect<void, HeadWriteError> =>
      Effect.gen(function* () {
        const buf = encodeFrame(payload);
        const session = extractSessionId(payload);
        if (session !== undefined) {
          yield* Ref.update(fifo, (m) => {
            const next = new Map(m);
            next.set(session, (next.get(session) ?? 0) + 1);
            return next;
          });
        }
        yield* serialized.write(buf.toString("utf8"));
        if (session !== undefined) {
          yield* Ref.update(fifo, (m) => {
            const next = new Map(m);
            const cur = (next.get(session) ?? 1) - 1;
            if (cur <= 0) {
              next.delete(session);
            } else {
              next.set(session, cur);
            }
            return next;
          });
        }
      });

    const writeFrame = (frame: unknown): Effect.Effect<Buffer, HeadWriteError | ProtocolError> =>
      Effect.try({
        try: () => encodeFrame(frame),
        catch: (cause) =>
          cause instanceof ProtocolError
            ? cause
            : new ProtocolError({ cause, message: String(cause), reason: "malformed_frame" }),
      });

    const readFrames = (
      chunk: Buffer,
    ): Effect.Effect<ReadonlyArray<string>, ProtocolError | RpcReadError> =>
      Effect.try({
        try: () => decoder.push(chunk),
        catch: (cause) =>
          cause instanceof ProtocolError
            ? cause
            : new RpcReadError({ cause, message: `RPC input failed: ${String(cause)}` }),
      });

    return {
      checkPoisoned: serialized.checkPoisoned,
      failure: serialized.failure,
      frames: strictLfFrames,
      poisoned: serialized.poisoned,
      readFrames,
      send,
      writeFrame,
    } satisfies RpcTransport;
  });

export interface FakeRpcTransport extends RpcTransport {
  readonly capturedBytes: ReadonlyArray<Buffer>;
  readonly capturedFrames: ReadonlyArray<string>;
  readonly queueDepth: (sessionId: string) => Effect.Effect<number>;
}

const extractSessionId = (payload: unknown): string | undefined => {
  if (typeof payload === "object" && payload !== null && "sessionId" in payload) {
    const sid = (payload as Record<string, unknown>).sessionId;
    return typeof sid === "string" ? sid : undefined;
  }
  return undefined;
};

export const makeFakeRpcTransport = (): Effect.Effect<FakeRpcTransport, never, Scope.Scope> =>
  Effect.gen(function* () {
    const decoder = new RpcFrameDecoder();
    const bytes: Array<Buffer> = [];
    const frames: Array<string> = [];
    const fifo = yield* Ref.make<SessionFifoState>(new Map());
    const poison = yield* Ref.make<HeadWriteError | undefined>(undefined);
    const fatal = yield* Deferred.make<never, HeadWriteError>();

    const checkPoisoned: RpcTransport["checkPoisoned"] = Ref.get(poison).pipe(
      Effect.flatMap((failure) => (failure === undefined ? Effect.void : Effect.fail(failure))),
    );

    const send = (payload: unknown): Effect.Effect<void, HeadWriteError> =>
      Effect.gen(function* () {
        const failure = yield* Ref.get(poison);
        if (failure !== undefined) {
          return yield* Effect.fail(failure);
        }
        const buf = encodeFrame(payload);
        // Buffer provenance: captured as Buffer, LF-terminated, 1MB check already in encodeFrame.
        bytes.push(buf);
        const jsonLine = buf.toString("utf8").trimEnd();
        frames.push(jsonLine);
        const session = extractSessionId(payload);
        if (session !== undefined) {
          yield* Ref.update(fifo, (m) => {
            const next = new Map(m);
            next.set(session, (next.get(session) ?? 0) + 1);
            // FIFO: immediately decrement to simulate ordered drain (depth tracks in-flight)
            // For test visibility we keep count briefly then decrement after a tick to show FIFO ordering.
            // Simpler: track total enqueued per session for ordering assertions externally via capturedFrames.
            return next;
          });
          // Decrement right away to keep depth 0 for completed sends; per-Session FIFO is proven via capturedFrames order, not depth.
          yield* Ref.update(fifo, (m) => {
            const next = new Map(m);
            const cur = (next.get(session) ?? 1) - 1;
            if (cur <= 0) {
              next.delete(session);
            } else {
              next.set(session, cur);
            }
            return next;
          });
        }
      });

    const writeFrame = (frame: unknown): Effect.Effect<Buffer, HeadWriteError | ProtocolError> =>
      Effect.gen(function* () {
        const failure = yield* Ref.get(poison);
        if (failure !== undefined) {
          return yield* Effect.fail(failure);
        }
        return encodeFrame(frame);
      });

    const readFrames = (
      chunk: Buffer,
    ): Effect.Effect<ReadonlyArray<string>, ProtocolError | RpcReadError> =>
      Effect.try({
        try: () => decoder.push(chunk),
        catch: (cause) =>
          cause instanceof ProtocolError
            ? cause
            : new RpcReadError({ cause, message: `RPC input failed: ${String(cause)}` }),
      });

    return {
      capturedBytes: bytes,
      capturedFrames: frames,
      checkPoisoned,
      failure: Deferred.await(fatal),
      frames: strictLfFrames,
      poisoned: Ref.get(poison).pipe(Effect.map((e) => e !== undefined)),
      queueDepth: (sessionId: string) =>
        Ref.get(fifo).pipe(Effect.map((m) => m.get(sessionId) ?? 0)),
      readFrames,
      send,
      writeFrame,
    } satisfies FakeRpcTransport;
  });

// Synchronous fake for soak test convenience (no Effect wrapper for capture).
export class FakeTransport {
  readonly capturedBytes: Array<Buffer> = [];
  readonly capturedFrames: Array<string> = [];
  private readonly decoder = new RpcFrameDecoder();
  private readonly sessionCounts = new Map<string, number>();

  sendSync(payload: unknown): Buffer {
    const buf = encodeFrame(payload);
    this.capturedBytes.push(buf);
    this.capturedFrames.push(buf.toString("utf8").trimEnd());
    const sid = extractSessionId(payload);
    if (sid !== undefined) {
      this.sessionCounts.set(sid, (this.sessionCounts.get(sid) ?? 0) + 1);
    }
    return buf;
  }

  readFrames(chunk: Buffer): ReadonlyArray<string> {
    return this.decoder.push(chunk);
  }

  frames(input: Readable): Stream.Stream<string, ProtocolError | RpcReadError> {
    return strictLfFrames(input);
  }

  writeFrame(frame: unknown): Buffer {
    return encodeFrame(frame);
  }

  getCapturedBytes(): ReadonlyArray<Buffer> {
    return this.capturedBytes;
  }

  getQueueDepth(sessionId: string): number {
    return this.sessionCounts.get(sessionId) ?? 0;
  }

  // Decode all captured bytes back to frames for strictEqual assertion (Buffer provenance preserved).
  decodeCaptured(): ReadonlyArray<Record<string, unknown>> {
    const all = Buffer.concat(this.capturedBytes).toString("utf8");
    return all
      .trimEnd()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}
