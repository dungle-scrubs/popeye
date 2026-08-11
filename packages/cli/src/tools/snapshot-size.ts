/**
 * Measures the full-transcript Snapshot cost through the same Driver and wire Schema used by Heads.
 * It exists because turn count alone cannot decide when D-017 entry-id pagination must activate.
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createMemoryJournalBacking, JournalMemory } from "@peye/journal";
import { SnapshotSchema } from "@peye/protocol";
import { Cause, Data, Effect, Exit, Layer, Schema, Stream } from "effect";

import {
  Driver,
  type DriverSnapshot,
  defineTool,
  FirstPartyDriverDefault,
  Provider,
  type ProviderService,
  type Tool,
  ToolRegistryLive,
} from "../compose.js";

export const SNAPSHOT_SIZE_SCENARIOS = [1, 10, 50, 200, 500, 1_000] as const;
export const SNAPSHOT_SIZE_SOFT_WARNING_BYTES = 256 * 1_024;
export const SNAPSHOT_SIZE_HARD_CONCERN_BYTES = 1_024 * 1_024;

const ASSISTANT_CONTENT_BYTES = 640;
const COMPACTION_SUMMARY_BYTES = 640;
const CONTEXT_BUDGET = 4_000_000;
const TOOL_INTERVAL = 10;
const TOOL_RESULT_BYTES = 320;
const USER_CONTENT_BYTES = 160;

const strict: { readonly onExcessProperty: "error" } = { onExcessProperty: "error" };

export interface SnapshotSizeMeasurement {
  readonly compacted: boolean;
  readonly entries: number;
  readonly snapshotBytes: number;
  readonly snapshotBytesPerEntry: number;
  readonly toolTurns: number;
  readonly turns: number;
}

export class SnapshotSizeReportWriteError extends Data.TaggedError("SnapshotSizeReportWriteError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

const fixedContent = (label: string, byteLength: number): string => {
  if (label.length > byteLength) {
    throw new RangeError(`Label exceeds fixed content size: ${label}`);
  }
  return label.padEnd(byteLength, ".");
};

const turnLabel = (turn: number): string => String(turn).padStart(4, "0");

const userContent = (turn: number): string =>
  fixedContent(`Recorded user request for turn ${turnLabel(turn)}.`, USER_CONTENT_BYTES);

const assistantContent = (turn: number): string =>
  fixedContent(`Recorded assistant response for turn ${turnLabel(turn)}.`, ASSISTANT_CONTENT_BYTES);

const toolResultContent = (turn: number): string =>
  fixedContent(`Recorded tool result for turn ${turnLabel(turn)}.`, TOOL_RESULT_BYTES);

const compactionSummary = (): string =>
  fixedContent("Recorded deterministic compaction summary.", COMPACTION_SUMMARY_BYTES);

const parseTurn = (content: string | undefined): number | undefined => {
  const match = content?.match(/^Recorded user request for turn (\d{4})\./u);
  if (match === undefined || match === null) {
    return undefined;
  }
  const encoded = match[1];
  return encoded === undefined ? undefined : Number.parseInt(encoded, 10);
};

const provider: ProviderService = {
  streamAssistant: (context, options) => {
    if (options.purpose === "compaction") {
      return Stream.fromIterable([
        { _tag: "textDelta", text: compactionSummary() },
        { _tag: "done", stopReason: "done" },
      ]);
    }

    const lastUserIndex = context.findLastIndex((item) => item.role === "user");
    const lastUser = context[lastUserIndex];
    const turn = parseTurn(lastUser?.content);
    if (turn === undefined) {
      return Stream.die(new Error("Snapshot measurement Provider could not identify the turn."));
    }

    const callId = `measure-tool-${turnLabel(turn)}`;
    const toolFinished = context
      .slice(lastUserIndex + 1)
      .some((item) => item.role === "toolResult" && item.toolCallId === callId);
    if (turn % TOOL_INTERVAL === 0 && !toolFinished) {
      return Stream.fromIterable([
        {
          _tag: "toolCall",
          argumentsJson: JSON.stringify({ turn }),
          id: callId,
          name: "measure-payload",
        },
        { _tag: "done", stopReason: "toolCalls" },
      ]);
    }

    return Stream.fromIterable([
      { _tag: "textDelta", text: assistantContent(turn) },
      { _tag: "done", stopReason: "done" },
    ]);
  },
};

const measurementTool: Tool<{ readonly turn: number }> = {
  description: "Returns a deterministic payload for snapshot measurement.",
  execute: ({ turn }) => Effect.succeed({ content: toolResultContent(turn) }),
  name: "measure-payload",
  parameters: Schema.Struct({ turn: Schema.Number.pipe(Schema.int(), Schema.positive()) }),
};

const normalizedEntryId = (index: number): string => `entry-${String(index).padStart(10, "0")}`;

const normalizeCompactionPayload = (
  payload: unknown,
  ids: ReadonlyMap<string, string>,
): unknown => {
  if (typeof payload !== "object" || payload === null) {
    return payload;
  }
  const candidate = payload as {
    readonly firstSummarizedId?: unknown;
    readonly lastSummarizedId?: unknown;
    readonly retainedTailIds?: unknown;
    readonly summary?: unknown;
  };
  if (
    typeof candidate.firstSummarizedId !== "string" ||
    typeof candidate.lastSummarizedId !== "string" ||
    !Array.isArray(candidate.retainedTailIds)
  ) {
    return payload;
  }
  return {
    firstSummarizedId: ids.get(candidate.firstSummarizedId) ?? candidate.firstSummarizedId,
    lastSummarizedId: ids.get(candidate.lastSummarizedId) ?? candidate.lastSummarizedId,
    retainedTailIds: candidate.retainedTailIds.map((id) =>
      typeof id === "string" ? (ids.get(id) ?? id) : id,
    ),
    summary: candidate.summary,
  };
};

const toNormalizedWireSnapshot = (snapshot: DriverSnapshot): unknown => {
  const ids = new Map(
    snapshot.entries.map((entry, index) => [entry.id, normalizedEntryId(index + 1)]),
  );
  const entries = snapshot.entries.map((entry) => ({
    id: ids.get(entry.id) ?? entry.id,
    kind: entry.kind,
    parentId: entry.parentId === null ? null : (ids.get(entry.parentId) ?? entry.parentId),
    payload:
      entry.kind === "compaction" ? normalizeCompactionPayload(entry.payload, ids) : entry.payload,
  }));
  return {
    entries,
    leafEntryId: ids.get(snapshot.leaf.id) ?? snapshot.leaf.id,
    ...(snapshot.model === undefined ? {} : { model: snapshot.model }),
    ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
    phase: snapshot.phase,
    revision: snapshot.revision,
    sessionId: "session-00000000",
    ...(snapshot.thinkingLevel === undefined ? {} : { thinkingLevel: snapshot.thinkingLevel }),
  };
};

const encodedSnapshotBytes = (snapshot: DriverSnapshot): Effect.Effect<number, unknown> =>
  Schema.decodeUnknown(
    SnapshotSchema,
    strict,
  )(toNormalizedWireSnapshot(snapshot)).pipe(
    Effect.flatMap(Schema.encode(SnapshotSchema)),
    Effect.map((encoded) => Buffer.byteLength(JSON.stringify(encoded), "utf8")),
  );

const measureScenario = (turns: number): Effect.Effect<SnapshotSizeMeasurement, unknown> => {
  const compacted = turns >= 50;
  const compactAfterTurn = Math.floor(turns / 2);
  const dependencies = Layer.mergeAll(
    JournalMemory(createMemoryJournalBacking()),
    Layer.succeed(Provider, provider),
    ToolRegistryLive([defineTool(measurementTool)]),
  );
  const driver = FirstPartyDriverDefault({
    compaction: { retainedTailCount: 1, sliceBudget: CONTEXT_BUDGET },
  }).pipe(Layer.provide(dependencies));

  return Effect.gen(function* () {
    const service = yield* Driver;
    const session = yield* service.createSession();
    for (let turn = 1; turn <= turns; turn += 1) {
      yield* service.prompt(session.id, userContent(turn), { contextBudget: CONTEXT_BUDGET });
      if (compacted && turn === compactAfterTurn) {
        yield* service.compactNow(session.id);
      }
    }
    const snapshot = yield* service.getSnapshot(session.id);
    const snapshotBytes = yield* encodedSnapshotBytes(snapshot);
    return {
      compacted,
      entries: snapshot.entries.length,
      snapshotBytes,
      snapshotBytesPerEntry: snapshotBytes / snapshot.entries.length,
      toolTurns: Math.floor(turns / TOOL_INTERVAL),
      turns,
    };
  }).pipe(Effect.provide(driver));
};

export const measureSnapshotSizes: Effect.Effect<
  ReadonlyArray<SnapshotSizeMeasurement>,
  unknown
> = Effect.forEach(SNAPSHOT_SIZE_SCENARIOS, measureScenario);

const kib = (bytes: number): string => (bytes / 1_024).toFixed(1);

const thresholdStatus = (bytes: number): string => {
  if (bytes >= SNAPSHOT_SIZE_HARD_CONCERN_BYTES) {
    return "hard concern";
  }
  if (bytes >= SNAPSHOT_SIZE_SOFT_WARNING_BYTES) {
    return "soft warning";
  }
  return "below warning";
};

export const renderSnapshotSizeReport = (
  measurements: ReadonlyArray<SnapshotSizeMeasurement>,
): string => {
  const hardCrossing = measurements.find(
    ({ snapshotBytes }) => snapshotBytes >= SNAPSHOT_SIZE_HARD_CONCERN_BYTES,
  );
  const longest = measurements.at(-1);
  if (longest === undefined) {
    throw new RangeError("Snapshot-size report requires at least one measurement.");
  }
  const decision =
    hardCrossing === undefined
      ? "NO-GO - retain full-transcript snapshots for the measured range."
      : "GO - activate reserved entry-id pagination before snapshots reach the hard threshold.";
  const evidence =
    hardCrossing === undefined
      ? `The longest session is ${kib(longest.snapshotBytes)} KiB, which is ${(
          (longest.snapshotBytes / SNAPSHOT_SIZE_HARD_CONCERN_BYTES) * 100
        ).toFixed(1)}% of the hard threshold.`
      : `The first recorded crossing is ${hardCrossing.turns.toLocaleString("en-US")} turns, ${hardCrossing.entries.toLocaleString("en-US")} entries, and ${kib(hardCrossing.snapshotBytes)} KiB.`;
  const rows = measurements
    .map(
      (measurement) =>
        `| ${measurement.turns.toLocaleString("en-US")} | ${measurement.toolTurns.toLocaleString("en-US")} | ${measurement.compacted ? "yes" : "no"} | ${measurement.entries.toLocaleString("en-US")} | ${measurement.snapshotBytes.toLocaleString("en-US")} | ${measurement.snapshotBytesPerEntry.toFixed(1)} | ${thresholdStatus(measurement.snapshotBytes)} |`,
    )
    .join("\n");

  return `# Snapshot-size measurement report

This report measures full-transcript Snapshot payloads for D-017. The harness drives the in-process Driver. It encodes each final Snapshot with \`SnapshotSchema\`. The byte count is the UTF-8 size of \`JSON.stringify\` on the encoded Snapshot.

## Recorded workload

- Turn counts: ${SNAPSHOT_SIZE_SCENARIOS.map((turns) => turns.toLocaleString("en-US")).join(", ")}.
- Fixed ASCII content: ${USER_CONTENT_BYTES} bytes per user message, ${ASSISTANT_CONTENT_BYTES} bytes per final assistant message, and ${TOOL_RESULT_BYTES} bytes per tool result.
- Tool rounds: every ${TOOL_INTERVAL}th turn calls \`measure-payload\` before the final assistant message.
- Compaction: sessions with at least 50 turns compact once at the midpoint. The summary is ${COMPACTION_SUMMARY_BYTES} bytes. Full-transcript Snapshots retain all Entries.
- Normalization: Entry IDs and the Session ID keep their production 16-byte length but use deterministic values. The workload has no timestamps.

## Thresholds

- Soft warning: ${SNAPSHOT_SIZE_SOFT_WARNING_BYTES.toLocaleString("en-US")} bytes (256 KiB). This marks the point where repeated authoritative Snapshot delivery needs monitoring.
- Hard concern: ${SNAPSHOT_SIZE_HARD_CONCERN_BYTES.toLocaleString("en-US")} bytes (1 MiB). At this size, every update serializes and transfers a material full-transcript payload. Pagination must bound repeated delivery.
- These are engineering policy thresholds. They are not protocol or transport limits.

## Measurements

| Turns | Tool turns | Compacted | Entries | Encoded bytes | Bytes/entry | Threshold |
| ---: | ---: | :---: | ---: | ---: | ---: | :--- |
${rows}

The curve grows monotonically for this recorded workload. Bytes per Entry remain close across the range, so Entry count is a useful early estimate. Content length still controls the final encoded size.

## Pagination go/no-go

**Decision: ${decision}**

${evidence}

Activation threshold: ${SNAPSHOT_SIZE_HARD_CONCERN_BYTES.toLocaleString("en-US")} encoded bytes (1 MiB) for one Snapshot. The 256 KiB threshold remains a warning. It does not activate pagination by itself.

The reserved \`EntryRange\` addressing is sufficient for the next protocol step. Activation must return a bounded Entry window while preserving \`leafEntryId\`, revision, and full-Snapshot authority for that window.

## Limits

This measurement uses fixed content sizes. Production transcripts with larger assistant messages or tool results reach the byte thresholds at fewer turns. Re-run this harness when the Entry envelope or Snapshot schema changes.
`;
};

export const snapshotSizeReportUrl = new URL(
  "../../test-fixtures/snapshot-size-report.md",
  import.meta.url,
);

export const writeSnapshotSizeReport: Effect.Effect<void, unknown> = Effect.gen(function* () {
  const measurements = yield* measureSnapshotSizes;
  const report = renderSnapshotSizeReport(measurements);
  yield* Effect.tryPromise({
    catch: (cause) =>
      new SnapshotSizeReportWriteError({
        cause,
        message: "Could not write the snapshot-size report.",
      }),
    try: () => writeFile(snapshotSizeReportUrl, report, "utf8"),
  });
});

const run = async (program: Effect.Effect<void, unknown>): Promise<void> => {
  const exit = await Effect.runPromiseExit(program);
  if (Exit.isSuccess(exit)) {
    return;
  }
  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
};

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  await run(writeSnapshotSizeReport);
}
