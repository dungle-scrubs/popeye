/**
 * Owns the in-process Head that writes protocol Progress and Snapshot lines.
 * It exists for structured pipes; it trusts Snapshots, renders Progress, and never folds Progress
 * into state. Prompts run sequentially and stop at the first non-zero exit code. A boundary failure
 * ends the stream with a headError envelope. The v1 Head intentionally has no separate per-turn
 * deadline because the Provider seam owns idle timeout enforcement.
 */

import type { SessionId } from "@pop-eye/journal";
import { ProgressSchema, SnapshotSchema } from "@pop-eye/protocol";
import { Deferred, Effect, Fiber, Schema, Stream } from "effect";

import { Driver } from "../compose.js";
import {
  exitCodeForStopReason,
  type HeadExitCode,
  type HeadWriter,
  runHeadBoundary,
  stdoutHeadWriter,
} from "./shared.js";

export interface JsonHeadOptions {
  readonly prompts: ReadonlyArray<string>;
  readonly sessionId?: SessionId;
  readonly writer?: HeadWriter;
}

const encodeProgressLine = (progress: unknown) =>
  Schema.decodeUnknown(ProgressSchema, { onExcessProperty: "error" })(progress).pipe(
    Effect.flatMap(Schema.encode(ProgressSchema)),
    Effect.map((encoded) => `${JSON.stringify(encoded)}\n`),
  );

const encodeSnapshotLine = (snapshot: {
  readonly entries: ReadonlyArray<unknown>;
  readonly leaf: { readonly id: string };
  readonly model?: string | undefined;
  readonly name?: string | undefined;
  readonly phase: unknown;
  readonly revision: number;
  readonly sessionId: string;
  readonly thinkingLevel?: unknown;
}) =>
  Schema.decodeUnknown(SnapshotSchema, { onExcessProperty: "error" })({
    entries: snapshot.entries,
    leafEntryId: snapshot.leaf.id,
    ...(snapshot.model === undefined ? {} : { model: snapshot.model }),
    ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
    phase: snapshot.phase,
    revision: snapshot.revision,
    sessionId: snapshot.sessionId,
    ...(snapshot.thinkingLevel === undefined ? {} : { thinkingLevel: snapshot.thinkingLevel }),
  }).pipe(
    Effect.flatMap(Schema.encode(SnapshotSchema)),
    Effect.map((encoded) => `${JSON.stringify(encoded)}\n`),
  );

export const runJsonHead = (options: JsonHeadOptions) =>
  runHeadBoundary(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const session = yield* options.sessionId === undefined
        ? driver.createSession()
        : driver.resumeSession(options.sessionId);
      const writer = options.writer ?? stdoutHeadWriter;

      for (const prompt of options.prompts) {
        const stopReason = yield* Effect.scoped(
          Effect.gen(function* () {
            const subscriptionReady = yield* Deferred.make<void>();
            const progressFiber = yield* driver.subscribeProgress(session.id).pipe(
              Stream.takeUntil((progress) => progress._tag === "turnSettled"),
              Stream.runForEach((progress) =>
                Deferred.succeed(subscriptionReady, undefined).pipe(
                  Effect.zipRight(encodeProgressLine(progress)),
                  Effect.flatMap(writer.write),
                ),
              ),
              Effect.forkScoped,
            );

            yield* Deferred.await(subscriptionReady);
            const result = yield* driver.prompt(session.id, prompt);
            yield* Fiber.join(progressFiber);
            const snapshot = yield* driver.getSnapshot(session.id);
            yield* encodeSnapshotLine(snapshot).pipe(Effect.flatMap(writer.write));
            return result.stopReason;
          }),
        );
        const exitCode = exitCodeForStopReason(stopReason);
        if (exitCode !== 0) {
          return exitCode;
        }
      }

      return 0 satisfies HeadExitCode;
    }),
    options.writer ?? stdoutHeadWriter,
  );
