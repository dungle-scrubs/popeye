/**
 * Owns the HCN head that streams native HarnessEvents.
 * It exists so HCN callers get identity-first events, token/message per the
 * render-one rule, ordered failure taxonomy, compaction states, and the hcn
 * exit matrix without parsing json head output. Thin adapter over Head Session
 * Loop: it only decides how to render Progress (token deltas, compaction,
 * E001 info errors) and each settled turn (message from the Snapshot plus
 * failure taxonomy), while the loop owns Session lifecycle, prompt sequencing,
 * entry counts, and stop-at-first-nonzero. Abort settles to killed with exit 1
 * in this mode only; the in-tree json mapping (abort to 2) is unchanged.
 */

import type { SessionId } from "@dungle-scrubs/popeye-journal";
import { Cause, Effect, Option, Schema } from "effect";
import type { AssistantDiagnostic, DriverSnapshot, Progress, TurnOptions } from "../compose.js";
import { AssistantDiagnosticSchema, type Driver as DriverTag } from "../compose.js";
import {
  compactionAppliedEvent,
  compactionStartedEvent,
  HCN_EXIT_CODES,
  type HcnEvent,
  identityEvent,
  type SettledFailureInput,
  terminalEventsForTurn,
} from "./hcn-events.js";
import {
  errorTag,
  type HeadExitCode,
  type HeadWriter,
  lastAssistantEntries,
  type SnapshotAuditFields,
  stdoutHeadWriter,
} from "./head-wire.js";
import { runSessionLoop, type SettledTurn } from "./session-loop.js";

export interface HcnHeadOptions {
  readonly prompts: ReadonlyArray<string>;
  readonly sessionId?: SessionId;
  readonly snapshotAudit?: SnapshotAuditFields;
  readonly turnOptions?: TurnOptions;
  readonly writer?: HeadWriter;
}

interface CollectedTurn {
  compactionEvents: Array<HcnEvent>;
  infoErrors: Array<Extract<HcnEvent, { readonly kind: "error" }>>;
  text: string;
}

/**
 * Reads one backward pass over this turn's assistant entries (positions at
 * or after entryCountBefore): the newest text plus the newest diagnostic.
 * Scoping to this turn keeps a resumed session from inheriting a previous
 * turn's diagnostic.
 */
const settledAssistantOf = (
  snapshot: DriverSnapshot,
  entryCountBefore: number,
): Effect.Effect<
  { readonly diagnostic: AssistantDiagnostic | undefined; readonly text: string },
  never
> =>
  Effect.gen(function* () {
    let text = "";
    for (const entry of lastAssistantEntries(snapshot, entryCountBefore)) {
      const payload = entry.payload as {
        readonly content?: unknown;
        readonly diagnostic?: unknown;
      };
      if (text === "" && typeof payload.content === "string") {
        text = payload.content;
      }
      if (payload.diagnostic !== undefined) {
        const diagnostic = Option.getOrUndefined(
          yield* Schema.decodeUnknown(AssistantDiagnosticSchema)(payload.diagnostic).pipe(
            Effect.option,
          ),
        );
        if (diagnostic !== undefined) {
          return { diagnostic, text };
        }
      }
    }
    return { diagnostic: undefined, text };
  });

const failureInputOf = (diagnostic: AssistantDiagnostic): SettledFailureInput => {
  if (diagnostic.reason === "provider_error") {
    return {
      detail: diagnostic.detail,
      reason: "provider_error",
      ...(diagnostic.status === undefined ? {} : { status: diagnostic.status }),
      ...(diagnostic.transient === undefined ? {} : { transient: diagnostic.transient }),
    };
  }
  return { detail: diagnostic.detail, reason: diagnostic.reason };
};

const writeEvents = (writer: HeadWriter, events: ReadonlyArray<HcnEvent>) =>
  events.length === 0
    ? Effect.void
    : writer.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

/**
 * RFC Error Handling E001: Progress tags the mapper intentionally ignores
 * (phase hints, tool lifecycle, retries) are dropped silently; any other
 * tag is a future or unforeseen frame, surfaced as an informational error
 * without ending the turn.
 */
const IGNORED_PROGRESS_TAGS: ReadonlySet<Progress["_tag"]> = new Set([
  "assistantThinking",
  "followUpQueued",
  "phaseChanged",
  "progressDropped",
  "providerRetryScheduled",
  "steeringApplied",
  "steeringQueued",
  "toolCompleted",
  "toolStarted",
  "turnQueued",
  "turnSettled",
]);

const collectProgress = (collected: CollectedTurn, progress: Progress): void => {
  if (progress._tag === "assistantText") {
    collected.text += progress.text;
  } else if (progress._tag === "compactionStarted") {
    collected.compactionEvents.push(
      compactionStartedEvent({
        entriesCovered: progress.entriesCovered,
        sliceCount: progress.sliceCount,
      }),
    );
  } else if (progress._tag === "compactionApplied") {
    collected.compactionEvents.push(
      compactionAppliedEvent({
        entriesCovered: progress.entriesCovered,
        sliceCount: progress.sliceCount,
      }),
    );
  } else if (!IGNORED_PROGRESS_TAGS.has(progress._tag)) {
    collected.infoErrors.push({
      kind: "error",
      message: `Unmappable Popeye event: ${progress._tag}`,
    });
  }
};

const renderSettledTurn = (
  writer: HeadWriter,
  collected: CollectedTurn,
  turn: SettledTurn,
): Effect.Effect<HeadExitCode, unknown> =>
  Effect.gen(function* () {
    // Head rule: message text comes from the authoritative Snapshot,
    // never from Progress (which can drop deltas under burst).
    // Progress deltas feed token events only.
    const { diagnostic, text: messageText } = yield* settledAssistantOf(
      turn.snapshot,
      turn.entryCountBefore,
    );
    const tokenEvents: ReadonlyArray<HcnEvent> =
      collected.text.length === 0 ? [] : [{ kind: "token", text: collected.text }];
    const outcome = terminalEventsForTurn({
      stopReason: turn.stopReason,
      text: messageText,
      ...(diagnostic === undefined ? {} : { failure: failureInputOf(diagnostic) }),
    });
    yield* writeEvents(writer, [
      ...tokenEvents,
      ...collected.compactionEvents,
      ...collected.infoErrors,
      ...outcome.events,
    ]);
    collected.compactionEvents = [];
    collected.infoErrors = [];
    collected.text = "";
    return outcome.exitCode;
  });

/**
 * HCN-local boundary: any failure before or between turns (stale resume
 * id, snapshot read failure, writer failure) ends the stream with a task
 * failure plus done-failed and exit 1, per the hcn matrix. The shared
 * runHeadBoundary (exit 4, headError envelope) MUST NOT reach HCN callers.
 */
const runHcnBoundary = (
  program: Effect.Effect<HeadExitCode, unknown, DriverTag>,
  writer: HeadWriter,
): Effect.Effect<HeadExitCode, never, DriverTag> =>
  Effect.exit(program).pipe(
    Effect.flatMap((exit) => {
      if (exit._tag === "Success") {
        return Effect.succeed(exit.value);
      }
      const message = Cause.pretty(exit.cause);
      const outcome = terminalEventsForTurn({
        defect: { message, tag: errorTag(Cause.failureOption(exit.cause), "Defect") },
        stopReason: "error",
        text: "",
      });
      return writeEvents(writer, outcome.events).pipe(
        Effect.as(HCN_EXIT_CODES.turnFailure),
        Effect.orElseSucceed(() => HCN_EXIT_CODES.turnFailure),
      );
    }),
  );

export const runHcnHead = (options: HcnHeadOptions) => {
  const writer = options.writer ?? stdoutHeadWriter;
  return runHcnBoundary(
    Effect.gen(function* () {
      const collected: CollectedTurn = { compactionEvents: [], infoErrors: [], text: "" };
      return yield* runSessionLoop({
        onProgress: (progress) =>
          Effect.sync(() => collectProgress(collected, progress)).pipe(Effect.asVoid),
        onSession: (sessionId) =>
          writer.write(
            `${JSON.stringify(identityEvent(sessionId, options.snapshotAudit?.capabilityGrants ?? []))}\n`,
          ),
        onTurnSettled: (turn) => renderSettledTurn(writer, collected, turn),
        prompts: options.prompts,
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.turnOptions === undefined ? {} : { turnOptions: options.turnOptions }),
      });
    }),
    writer,
  );
};
