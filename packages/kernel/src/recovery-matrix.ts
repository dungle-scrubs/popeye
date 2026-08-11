/**
 * Owns test-only discovery of crash boundaries from recorded JSONL sessions.
 * It exists so the M24 matrix follows durable content instead of fixed line numbers.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type Entry,
  Journal,
  type JournalDiagnostic,
  type JournalError,
  JournalJsonl,
  type Record as JournalRecord,
  type JournalService,
  type SessionId,
} from "@pop-eye/journal";
import { Deferred, Effect, type Exit, Fiber, Layer, Schema, Stream, Tracer } from "effect";

import { Driver, DriverDefault } from "./driver.js";
import { Provider, type ProviderService } from "./provider.js";
import {
  applyRecoveryPlan,
  boundedRecoveryRecords,
  type RecoveryReport,
  recoverSession,
} from "./recovery.js";
import { defineTool, type Tool, ToolRegistryLive } from "./tool.js";

export interface JournalBoundary {
  readonly acknowledgement: number;
  readonly kind: string;
  readonly replay: "never" | "safe" | undefined;
  readonly toolCallId: string | undefined;
}

export type RecoveryScriptName =
  | "compaction"
  | "multi-tool-round-turn"
  | "steering-loop"
  | "tool-free-turn"
  | "tool-turn";

export interface RecordedRecoverySession {
  readonly boundaries: ReadonlyArray<JournalBoundary>;
  readonly directory: string;
  readonly name: RecoveryScriptName;
  readonly sessionId: SessionId;
}

export type RecoveryMatrixAction = "idle" | "interrupted-stream" | "synthesized-results";

export interface RecoveryMatrixCell {
  readonly acceptsNewPrompt: boolean;
  readonly acknowledgement: number;
  readonly actualAction: RecoveryMatrixAction;
  readonly boundaryKind: string;
  readonly completedToolResultsPreserved: boolean;
  readonly crashed: boolean;
  readonly duplicateToolCallIds: ReadonlyArray<string>;
  readonly expectedAction: RecoveryMatrixAction;
  readonly openOperationIds: ReadonlyArray<string>;
  readonly recoveryReportEmitted: boolean;
  readonly recoverySpanEmitted: boolean;
  readonly recoveryTerminalMarked: boolean;
  readonly replay: "never" | "safe" | undefined;
  readonly safeReplayToolCallIds: ReadonlyArray<string>;
  readonly script: RecoveryScriptName;
  readonly terminalStopReason: string | undefined;
  readonly unresolvedToolCallIds: ReadonlyArray<string>;
}

export interface RecoveryBoundaryMatrix {
  readonly boundaryCount: number;
  readonly cells: ReadonlyArray<RecoveryMatrixCell>;
}

export type TornTailBoundary =
  | "generation-swap:directory-sync"
  | "generation-swap:temporary-sync"
  | "generation-swap:temporary-write"
  | "torn-tail-only";

export interface TornTailRecoveryCell {
  readonly acknowledgedPrefixByteExact: boolean;
  readonly boundary: TornTailBoundary;
  readonly openedDiagnosticEmitted: boolean;
  readonly recoveredDiagnosticEmitted: boolean;
  readonly sessionReadable: boolean;
}

export interface CorruptionRejectionCell {
  readonly action: "reject-corrupt";
  readonly corruptionClass: string | undefined;
  readonly fileByteExact: boolean;
  readonly recoveryReportEmitted: boolean;
  readonly recoverySpanFailed: boolean;
}

export interface DoubleRecoveryCell {
  readonly finalReportActionCount: number;
  readonly firstRecoveryCrashed: boolean;
  readonly interruptedAssistantCount: number;
  readonly operationFinishedCount: number;
  readonly originalTurnCrashed: boolean;
  readonly recoveryReportEmitted: boolean;
  readonly recoverySpanEmitted: boolean;
  readonly toolResultIds: ReadonlyArray<string>;
}

export interface OrphanedPromptDoubleRecoveryCell {
  readonly finalReportActionCount: number;
  readonly finalReportEntriesAppendedCount: number;
  readonly firstRecoveryCrashed: boolean;
  readonly interruptedAssistantCount: number;
  readonly operationRecordCount: number;
  readonly originalTurnCrashed: boolean;
  readonly retryActionCount: number;
  readonly retryEntriesAppendedCount: number;
  readonly retryOperationIdFound: string | undefined;
}

interface CapturedSpan {
  readonly attributes: Map<string, unknown>;
  exit: Exit.Exit<unknown, unknown> | undefined;
  readonly name: string;
}

interface FaultState {
  acknowledgements: number;
  readonly failAfter: number;
  killed: boolean;
  sessionId: SessionId | undefined;
}

const crash = new Error("Injected M24 process crash.");

const objectValue = (value: unknown, description: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${description} to be an object.`);
  }
  return value as Record<string, unknown>;
};

const stringValue = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${description} to be a non-empty string.`);
  }
  return value;
};

const durableItem = (
  physicalLine: string,
): { readonly item: Record<string, unknown> | undefined; readonly type: string } => {
  const envelope = objectValue(JSON.parse(physicalLine) as unknown, "journal envelope");
  const payload = objectValue(envelope.payload, "journal payload");
  if (payload.type === "journal_header") {
    return { item: undefined, type: "journal_header" };
  }
  return {
    item: objectValue(payload.item, "durable item"),
    type: stringValue(payload.type, "journal payload type"),
  };
};

const durableKind = (physicalLine: string): string => {
  const durable = durableItem(physicalLine);
  if (durable.type === "journal_header" || durable.item === undefined) {
    return "header";
  }
  const item = durable.item;
  const kind = stringValue(item.kind, "durable item kind");
  if (durable.type !== "entry" || kind !== "message") {
    return kind;
  }
  const entryPayload = objectValue(item.payload, "message Entry payload");
  return `message:${stringValue(entryPayload.role, "message Entry role")}`;
};

const boundaryFromLine = (physicalLine: string, acknowledgement: number): JournalBoundary => {
  const durable = durableItem(physicalLine);
  const payload = durable.item?.payload;
  const recordPayload =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  const replay = recordPayload?.replay;
  const toolCallId = recordPayload?.toolCallId;
  return {
    acknowledgement,
    kind: durableKind(physicalLine),
    replay: replay === "never" || replay === "safe" ? replay : undefined,
    toolCallId: typeof toolCallId === "string" ? toolCallId : undefined,
  };
};

export const enumerateJournalBoundaries = (text: string): ReadonlyArray<JournalBoundary> => {
  const lines = text.trimEnd().split("\n");
  if (lines.length < 2 || durableKind(lines[0] ?? "") !== "header") {
    throw new Error("A recorded journal must contain a header and root Entry.");
  }
  return [
    { acknowledgement: 1, kind: "header", replay: undefined, toolCallId: undefined },
    ...lines.slice(2).map((line, index) => boundaryFromLine(line, index + 2)),
  ];
};

const jsonlLayer = (
  directory: string,
  fault: FaultState | undefined = undefined,
): Layer.Layer<Journal, JournalError> => {
  const base = JournalJsonl(directory, {
    diagnosticSink: () => Effect.void,
    io: {
      observe: (observation) =>
        Effect.sync(() => {
          if (observation.operation !== "ack" || fault === undefined) {
            return;
          }
          fault.acknowledgements += 1;
          if (fault.acknowledgements === fault.failAfter) {
            fault.killed = true;
            fault.sessionId = observation.sessionId;
            throw crash;
          }
        }),
    },
  });
  if (fault === undefined) {
    return base;
  }
  const guard = <TOutput, TError>(
    run: () => Effect.Effect<TOutput, TError>,
  ): Effect.Effect<TOutput, TError> =>
    Effect.suspend(() => (fault.killed ? Effect.die(crash) : run()));
  return Layer.effect(
    Journal,
    Effect.gen(function* () {
      const journal = yield* Journal;
      return {
        ...journal,
        appendCompaction: (sessionId, payload) =>
          guard(() => journal.appendCompaction(sessionId, payload)),
        appendEntry: (sessionId, entry) => guard(() => journal.appendEntry(sessionId, entry)),
        appendRecord: (sessionId, record) => guard(() => journal.appendRecord(sessionId, record)),
        moveLeaf: (sessionId, entryId) => guard(() => journal.moveLeaf(sessionId, entryId)),
      } satisfies JournalService;
    }),
  ).pipe(Layer.provide(base));
};

const driverLayer = (
  directory: string,
  provider: ProviderService,
  tools: ReadonlyArray<Tool.Any>,
  fault: FaultState | undefined = undefined,
) =>
  DriverDefault({ compaction: { retainedTailCount: 1 } }).pipe(
    Layer.provide(
      Layer.mergeAll(
        jsonlLayer(directory, fault),
        Layer.succeed(Provider, provider),
        ToolRegistryLive(tools),
      ),
    ),
  );

const recordedSession = async (
  directory: string,
  name: RecoveryScriptName,
  sessionId: SessionId,
): Promise<RecordedRecoverySession> => {
  const text = await readFile(join(directory, `${sessionId}.jsonl`), "utf8");
  return { boundaries: enumerateJournalBoundaries(text), directory, name, sessionId };
};

const tool = <TParameters>(definition: Tool<TParameters>): Tool.Any => defineTool(definition);

const recordToolFreeTurn = async (
  directory: string,
  fault: FaultState | undefined = undefined,
): Promise<RecordedRecoverySession> => {
  const provider: ProviderService = {
    streamAssistant: () =>
      Stream.fromIterable([
        { _tag: "textDelta", text: "Tool-free response." },
        { _tag: "done", stopReason: "done" },
      ]),
  };
  const sessionId = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      yield* driver.prompt(created.id, "Tool-free prompt.");
      return created.id;
    }).pipe(Effect.provide(driverLayer(directory, provider, [], fault))),
  );
  return recordedSession(directory, "tool-free-turn", sessionId);
};

const recordToolTurn = async (
  directory: string,
  fault: FaultState | undefined = undefined,
): Promise<RecordedRecoverySession> => {
  let request = 0;
  const provider: ProviderService = {
    streamAssistant: () => {
      request += 1;
      return request === 1
        ? Stream.fromIterable([
            { _tag: "toolCall", argumentsJson: "{}", id: "never-call", name: "never-tool" },
            { _tag: "toolCall", argumentsJson: "{}", id: "safe-call", name: "safe-tool" },
            { _tag: "done", stopReason: "toolCalls" },
          ])
        : Stream.fromIterable([
            { _tag: "textDelta", text: "Tool response." },
            { _tag: "done", stopReason: "done" },
          ]);
    },
  };
  const tools = [
    tool({
      description: "A Tool that is never replayed.",
      execute: () => Effect.succeed({ content: "never result" }),
      name: "never-tool",
      parameters: Schema.Struct({}),
      replay: "never" as const,
    }),
    tool({
      description: "A Tool that is safe to replay.",
      execute: () => Effect.succeed({ content: "safe result" }),
      name: "safe-tool",
      parameters: Schema.Struct({}),
      replay: "safe" as const,
    }),
  ];
  const sessionId = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      yield* driver.prompt(created.id, "Use both Tools.", { toolConcurrency: 1 });
      return created.id;
    }).pipe(Effect.provide(driverLayer(directory, provider, tools, fault))),
  );
  return recordedSession(directory, "tool-turn", sessionId);
};

const recordMultiToolRoundTurn = async (
  directory: string,
  fault: FaultState | undefined = undefined,
): Promise<RecordedRecoverySession> => {
  let request = 0;
  const provider: ProviderService = {
    streamAssistant: () => {
      request += 1;
      if (request < 3) {
        return Stream.fromIterable([
          {
            _tag: "toolCall",
            argumentsJson: "{}",
            id: `round-${request}-call`,
            name: "round-tool",
          },
          { _tag: "done", stopReason: "toolCalls" },
        ]);
      }
      return Stream.fromIterable([
        { _tag: "textDelta", text: "Both Tool rounds completed." },
        { _tag: "done", stopReason: "done" },
      ]);
    },
  };
  const tools = [
    tool({
      description: "A deterministic multi-round Tool.",
      execute: () => Effect.succeed({ content: "round result" }),
      name: "round-tool",
      parameters: Schema.Struct({}),
    }),
  ];
  const sessionId = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      yield* driver.prompt(created.id, "Use a Tool in two rounds.", { toolConcurrency: 1 });
      return created.id;
    }).pipe(Effect.provide(driverLayer(directory, provider, tools, fault))),
  );
  return recordedSession(directory, "multi-tool-round-turn", sessionId);
};

const recordSteeringLoop = async (
  directory: string,
  fault: FaultState | undefined = undefined,
): Promise<RecordedRecoverySession> => {
  const started = await Effect.runPromise(Deferred.make<void>());
  const release = await Effect.runPromise(Deferred.make<void>());
  let request = 0;
  const provider: ProviderService = {
    streamAssistant: () => {
      request += 1;
      return request === 1
        ? Stream.fromIterable([
            { _tag: "toolCall", argumentsJson: "{}", id: "steer-call", name: "steer-tool" },
            { _tag: "done", stopReason: "toolCalls" },
          ])
        : Stream.fromIterable([
            { _tag: "textDelta", text: "Steering applied." },
            { _tag: "done", stopReason: "done" },
          ]);
    },
  };
  const tools = [
    tool({
      description: "A Tool that blocks until Steering is queued.",
      execute: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.zipRight(Deferred.await(release)),
          Effect.as({ content: "steering result" }),
        ),
      name: "steer-tool",
      parameters: Schema.Struct({}),
    }),
  ];
  const sessionId = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      const turn = yield* Effect.fork(
        driver.prompt(created.id, "Wait for Steering.", { toolConcurrency: 1 }),
      );
      yield* Effect.raceFirst(Deferred.await(started), Fiber.join(turn).pipe(Effect.asVoid));
      yield* driver.steer(created.id, "Apply this Steering.");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(turn);
      return created.id;
    }).pipe(Effect.provide(driverLayer(directory, provider, tools, fault))),
  );
  return recordedSession(directory, "steering-loop", sessionId);
};

const recordCompaction = async (
  directory: string,
  fault: FaultState | undefined = undefined,
): Promise<RecordedRecoverySession> => {
  let turn = 0;
  const provider: ProviderService = {
    streamAssistant: (_context, options) => {
      if (options.purpose === "compaction") {
        return Stream.fromIterable([
          { _tag: "textDelta", text: "Compacted recovery fixture." },
          { _tag: "done", stopReason: "done" },
        ]);
      }
      turn += 1;
      return Stream.fromIterable([
        { _tag: "textDelta", text: `Response ${turn}.` },
        { _tag: "done", stopReason: "done" },
      ]);
    },
  };
  const sessionId = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const created = yield* driver.createSession();
      yield* driver.prompt(created.id, "First Compaction prompt.");
      const first = yield* driver.getSnapshot(created.id);
      yield* driver.prompt(created.id, "Discarded branch prompt.");
      yield* driver.branch(created.id, first.leaf.id);
      yield* driver.prompt(created.id, "Replacement branch prompt.");
      yield* driver.compactNow(created.id);
      return created.id;
    }).pipe(Effect.provide(driverLayer(directory, provider, [], fault))),
  );
  return recordedSession(directory, "compaction", sessionId);
};

export const recordCanonicalRecoverySessions = async (
  directory: string,
): Promise<ReadonlyArray<RecordedRecoverySession>> => [
  await recordToolFreeTurn(join(directory, "tool-free-turn")),
  await recordToolTurn(join(directory, "tool-turn")),
  await recordMultiToolRoundTurn(join(directory, "multi-tool-round-turn")),
  await recordSteeringLoop(join(directory, "steering-loop")),
  await recordCompaction(join(directory, "compaction")),
];

const executeScript = (
  name: RecoveryScriptName,
  directory: string,
  fault: FaultState,
): Promise<RecordedRecoverySession> => {
  switch (name) {
    case "compaction":
      return recordCompaction(directory, fault);
    case "multi-tool-round-turn":
      return recordMultiToolRoundTurn(directory, fault);
    case "steering-loop":
      return recordSteeringLoop(directory, fault);
    case "tool-free-turn":
      return recordToolFreeTurn(directory, fault);
    case "tool-turn":
      return recordToolTurn(directory, fault);
  }
};

const decodedJournalItems = (
  text: string,
): ReadonlyArray<{
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly type: string;
}> =>
  text
    .trimEnd()
    .split("\n")
    .flatMap((line) => {
      const durable = durableItem(line);
      if (durable.item === undefined) {
        return [];
      }
      const payload = durable.item.payload;
      return [
        {
          kind: stringValue(durable.item.kind, "durable item kind"),
          payload:
            typeof payload === "object" && payload !== null && !Array.isArray(payload)
              ? (payload as Record<string, unknown>)
              : {},
          type: durable.type,
        },
      ];
    });

const toolCallIdsFromPayload = (payload: Record<string, unknown>): ReadonlyArray<string> => {
  if (payload.role !== "assistant" || !Array.isArray(payload.toolCalls)) {
    return [];
  }
  return payload.toolCalls.flatMap((call) => {
    if (typeof call !== "object" || call === null || Array.isArray(call)) {
      return [];
    }
    const id = (call as Record<string, unknown>).id;
    return typeof id === "string" ? [id] : [];
  });
};

const expectedRecoveryAction = (text: string): RecoveryMatrixAction => {
  const items = decodedJournalItems(text);
  const lastFinished = items.findLastIndex(
    ({ kind, type }) => type === "record" && kind === "operation_finished",
  );
  const recoverySlice = items.slice(lastFinished + 1);
  const hasOpenOperation = recoverySlice.some(
    ({ kind, type }) => type === "record" && kind === "operation_started",
  );
  if (hasOpenOperation) {
    const calls = recoverySlice.flatMap(({ payload, type }) =>
      type === "entry" ? toolCallIdsFromPayload(payload) : [],
    );
    const completed = new Set(
      recoverySlice.flatMap(({ payload, type }) =>
        type === "entry" && payload.role === "toolResult" && typeof payload.toolCallId === "string"
          ? [payload.toolCallId]
          : [],
      ),
    );
    return calls.some((id) => !completed.has(id)) ? "synthesized-results" : "interrupted-stream";
  }
  const trailingMessage = recoverySlice.findLast(
    ({ kind, type }) => type === "entry" && kind === "message",
  );
  return trailingMessage?.payload.role === "user" ? "interrupted-stream" : "idle";
};

const actualRecoveryAction = (report: RecoveryReport): RecoveryMatrixAction => {
  const synthesized = report.actions.some(
    (action) =>
      action.action === "safe_replay" ||
      action.action === "synthesized_interrupted" ||
      action.action === "synthesized_missing_tool",
  );
  if (synthesized) {
    return "synthesized-results";
  }
  return report.entriesAppended.length > 0 ? "interrupted-stream" : "idle";
};

const messagePayload = (entry: Entry): Record<string, unknown> | undefined =>
  entry.kind === "message" &&
  typeof entry.payload === "object" &&
  entry.payload !== null &&
  !Array.isArray(entry.payload)
    ? (entry.payload as Record<string, unknown>)
    : undefined;

const isInterruptedAssistantPayload = (payload: Record<string, unknown> | undefined): boolean => {
  const diagnostic = payload?.diagnostic;
  return (
    payload?.role === "assistant" &&
    (payload.stopReason === "aborted" || payload.stopReason === "error") &&
    typeof diagnostic === "object" &&
    diagnostic !== null &&
    !Array.isArray(diagnostic) &&
    (diagnostic as Record<string, unknown>).detail === "interrupted by crash"
  );
};

const resultCallIds = (entries: ReadonlyArray<Entry>): ReadonlyArray<string> =>
  entries.flatMap((entry) => {
    const payload = messagePayload(entry);
    return payload?.role === "toolResult" && typeof payload.toolCallId === "string"
      ? [payload.toolCallId]
      : [];
  });

const duplicateValues = (values: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates].sort();
};

const unresolvedToolCallIds = (entries: ReadonlyArray<Entry>): ReadonlyArray<string> => {
  const called = entries.flatMap((entry) => {
    const payload = messagePayload(entry);
    return payload === undefined ? [] : toolCallIdsFromPayload(payload);
  });
  const completed = new Set(resultCallIds(entries));
  return called.filter((id) => !completed.has(id));
};

const openOperationIds = (records: ReadonlyArray<JournalRecord>): ReadonlyArray<string> => {
  const open = new Set<string>();
  for (const record of records) {
    if (typeof record.payload !== "object" || record.payload === null) {
      continue;
    }
    const operationId = (record.payload as Record<string, unknown>).operationId;
    if (typeof operationId !== "string") {
      continue;
    }
    if (record.kind === "operation_started") {
      open.add(operationId);
    }
    if (record.kind === "operation_finished") {
      open.delete(operationId);
    }
  }
  return [...open].sort();
};

const completedToolResultPayloads = (text: string): ReadonlyArray<string> =>
  decodedJournalItems(text).flatMap(({ payload, type }) =>
    type === "entry" && payload.role === "toolResult" && payload.isError === false
      ? [JSON.stringify(payload)]
      : [],
  );

const tracerLayer = (spans: Array<CapturedSpan>): Layer.Layer<never> => {
  const tracer = Tracer.make({
    context: (evaluate) => evaluate(),
    span: (name, parent, context, links, startTime, kind, options) => {
      const captured: CapturedSpan = {
        attributes: new Map(Object.entries(options?.attributes ?? {})),
        exit: undefined,
        name,
      };
      spans.push(captured);
      return {
        _tag: "Span",
        addLinks: () => undefined,
        attribute: (key, value) => captured.attributes.set(key, value),
        attributes: captured.attributes,
        context,
        end: (_endTime, exit) => {
          captured.exit = exit;
        },
        event: () => undefined,
        kind,
        links,
        name,
        parent,
        sampled: true,
        spanId: `${spans.length}`,
        status: { _tag: "Started", startTime },
        traceId: "recovery-matrix",
      } satisfies Tracer.Span;
    },
  });
  return Layer.merge(Layer.setTracer(tracer), Layer.setTracerEnabled(true));
};

const recoveryTools = (): ReadonlyArray<Tool.Any> =>
  [
    { name: "never-tool", replay: "never" as const },
    { name: "round-tool", replay: "never" as const },
    { name: "safe-tool", replay: "safe" as const },
    { name: "steer-tool", replay: "never" as const },
  ].map(({ name, replay }) =>
    tool({
      description: `Recovery fixture ${name}.`,
      execute: () => Effect.succeed({ content: "post-recovery result" }),
      name,
      parameters: Schema.Struct({}),
      replay,
    }),
  );

const recoverMatrixCell = async (input: {
  readonly boundary: JournalBoundary;
  readonly crashed: boolean;
  readonly directory: string;
  readonly expectedAction: RecoveryMatrixAction;
  readonly script: RecoveryScriptName;
  readonly sessionId: SessionId;
  readonly textBeforeRecovery: string;
}): Promise<RecoveryMatrixCell> => {
  const reports: Array<RecoveryReport> = [];
  const spans: Array<CapturedSpan> = [];
  const provider: ProviderService = {
    streamAssistant: () =>
      Stream.fromIterable([
        { _tag: "textDelta", text: "Post-recovery response." },
        { _tag: "done", stopReason: "done" },
      ]),
  };
  const journalLayer = JournalJsonl(input.directory, { diagnosticSink: () => Effect.void });
  const drivers = DriverDefault({
    sessions: {
      recoveryDiagnosticSink: (report) => Effect.sync(() => reports.push(report)),
    },
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        journalLayer,
        Layer.succeed(Provider, provider),
        ToolRegistryLive(recoveryTools()),
      ),
    ),
  );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const journal = yield* Journal;
      const resumed = yield* driver.resumeSession(input.sessionId);
      const afterRecovery = yield* journal.readBranch(input.sessionId);
      const prompt = yield* driver.prompt(input.sessionId, "Prompt after recovery.");
      const branch = yield* journal.readBranch(input.sessionId);
      const records = yield* journal.readRecords(input.sessionId);
      return { afterRecovery, branch, prompt, records, resumed };
    }).pipe(Effect.provide(Layer.merge(journalLayer, drivers)), Effect.provide(tracerLayer(spans))),
  );
  const report = result.resumed.recovery;
  const recoverySpan = spans.find(({ name }) => name === "kernel.recovery");
  const resultIds = resultCallIds(result.branch);
  const afterPayloads = new Set(
    result.branch.flatMap((entry) => {
      const payload = messagePayload(entry);
      return payload?.role === "toolResult" ? [JSON.stringify(payload)] : [];
    }),
  );
  const lastMessage = result.branch.findLast((entry) => messagePayload(entry) !== undefined);
  const lastPayload = lastMessage === undefined ? undefined : messagePayload(lastMessage);
  const recoveryLastMessage = result.afterRecovery.findLast(
    (entry) => messagePayload(entry) !== undefined,
  );
  const recoveryLastPayload =
    recoveryLastMessage === undefined ? undefined : messagePayload(recoveryLastMessage);
  return {
    acceptsNewPrompt: result.prompt.stopReason === "done",
    acknowledgement: input.boundary.acknowledgement,
    actualAction: actualRecoveryAction(report),
    boundaryKind: input.boundary.kind,
    completedToolResultsPreserved: completedToolResultPayloads(input.textBeforeRecovery).every(
      (payload) => afterPayloads.has(payload),
    ),
    crashed: input.crashed,
    duplicateToolCallIds: duplicateValues(resultIds),
    expectedAction: input.expectedAction,
    openOperationIds: openOperationIds(result.records),
    recoveryReportEmitted:
      reports.length === 1 && JSON.stringify(reports[0]) === JSON.stringify(report),
    recoverySpanEmitted:
      recoverySpan !== undefined &&
      recoverySpan.attributes.get("sessionId") === input.sessionId &&
      recoverySpan.attributes.get("actionCount") === report.actions.length &&
      recoverySpan.attributes.get("entriesAppendedCount") === report.entriesAppended.length &&
      recoverySpan.exit?._tag === "Success",
    recoveryTerminalMarked:
      report.entriesAppended.length === 0 || isInterruptedAssistantPayload(recoveryLastPayload),
    replay: input.boundary.replay,
    safeReplayToolCallIds: report.safeReplay.map(({ toolCallId }) => toolCallId),
    script: input.script,
    terminalStopReason:
      lastPayload?.role === "assistant" && typeof lastPayload.stopReason === "string"
        ? lastPayload.stopReason
        : undefined,
    unresolvedToolCallIds: unresolvedToolCallIds(result.branch),
  };
};

export const runRecoveryBoundaryMatrix = async (
  directory: string,
): Promise<RecoveryBoundaryMatrix> => {
  const recorded = await recordCanonicalRecoverySessions(join(directory, "recorded"));
  const cells: Array<RecoveryMatrixCell> = [];
  for (const session of recorded) {
    for (const boundary of session.boundaries) {
      const cellDirectory = join(directory, "cells", `${session.name}-${boundary.acknowledgement}`);
      const fault: FaultState = {
        acknowledgements: 0,
        failAfter: boundary.acknowledgement,
        killed: false,
        sessionId: undefined,
      };
      const crashed = await executeScript(session.name, cellDirectory, fault).then(
        () => false,
        () => true,
      );
      if (fault.sessionId === undefined) {
        throw new Error(
          `Fault at ${session.name} acknowledgement ${boundary.acknowledgement} did not identify a Session.`,
        );
      }
      const textBeforeRecovery = await readFile(
        join(cellDirectory, `${fault.sessionId}.jsonl`),
        "utf8",
      );
      cells.push(
        await recoverMatrixCell({
          boundary,
          crashed,
          directory: cellDirectory,
          expectedAction: expectedRecoveryAction(textBeforeRecovery),
          script: session.name,
          sessionId: fault.sessionId,
          textBeforeRecovery,
        }),
      );
    }
  }
  return {
    boundaryCount: recorded.reduce((count, session) => count + session.boundaries.length, 0),
    cells,
  };
};

const matchesGenerationSwapBoundary = (
  boundary: Exclude<TornTailBoundary, "torn-tail-only">,
  file: string,
  operation: "ack" | "sync" | "write",
): boolean => {
  if (boundary === "generation-swap:temporary-write") {
    return operation === "write" && file.endsWith(".tmp");
  }
  if (boundary === "generation-swap:temporary-sync") {
    return operation === "sync" && file.endsWith(".tmp");
  }
  return operation === "sync" && !file.endsWith(".tmp") && !file.endsWith(".jsonl");
};

export const runTornTailRecoveryMatrix = async (
  directory: string,
): Promise<ReadonlyArray<TornTailRecoveryCell>> => {
  const baseline = await recordToolFreeTurn(join(directory, "baseline"));
  const acknowledged = await readFile(
    join(baseline.directory, `${baseline.sessionId}.jsonl`),
    "utf8",
  );
  const boundaries: ReadonlyArray<TornTailBoundary> = [
    "torn-tail-only",
    "generation-swap:temporary-write",
    "generation-swap:temporary-sync",
    "generation-swap:directory-sync",
  ];
  const cells: Array<TornTailRecoveryCell> = [];
  for (const boundary of boundaries) {
    const cellDirectory = join(directory, boundary.replaceAll(":", "-"));
    const file = join(cellDirectory, `${baseline.sessionId}.jsonl`);
    await mkdir(cellDirectory, { recursive: true });
    await writeFile(file, `${acknowledged}{"v":1,"payload":`);
    const diagnostics: Array<JournalDiagnostic> = [];
    let firstReadable = false;
    if (boundary === "torn-tail-only") {
      firstReadable = await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const leaf = yield* journal.getLeaf(baseline.sessionId);
          return leaf.kind !== "";
        }).pipe(
          Effect.provide(
            JournalJsonl(cellDirectory, {
              diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
            }),
          ),
        ),
      );
    } else {
      await Effect.runPromiseExit(
        Effect.gen(function* () {
          const journal = yield* Journal;
          yield* journal.getLeaf(baseline.sessionId);
        }).pipe(
          Effect.provide(
            JournalJsonl(cellDirectory, {
              diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
              io: {
                observe: ({ file: observedFile, operation }) =>
                  Effect.sync(() => {
                    if (matchesGenerationSwapBoundary(boundary, observedFile, operation)) {
                      throw crash;
                    }
                  }),
              },
            }),
          ),
        ),
      );
    }
    const sessionReadable =
      firstReadable ||
      (await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* Journal;
          const leaf = yield* journal.getLeaf(baseline.sessionId);
          return leaf.kind !== "";
        }).pipe(
          Effect.provide(
            JournalJsonl(cellDirectory, {
              diagnosticSink: (diagnostic) => Effect.sync(() => diagnostics.push(diagnostic)),
            }),
          ),
        ),
      ));
    cells.push({
      acknowledgedPrefixByteExact: (await readFile(file, "utf8")) === acknowledged,
      boundary,
      openedDiagnosticEmitted: diagnostics.some(({ action }) => action === "opened"),
      recoveredDiagnosticEmitted: diagnostics.some(
        ({ action }) => action === "recovered_torn_tail",
      ),
      sessionReadable,
    });
  }
  return cells;
};

export const runCorruptionRejectionCell = async (
  directory: string,
): Promise<CorruptionRejectionCell> => {
  const recorded = await recordToolTurn(directory);
  const file = join(directory, `${recorded.sessionId}.jsonl`);
  const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
  const toolStartedLine = lines.find((line) => durableKind(line) === "tool_started");
  if (toolStartedLine === undefined) {
    throw new Error("The corruption fixture has no tool_started Record.");
  }
  const envelope = objectValue(JSON.parse(toolStartedLine) as unknown, "journal envelope");
  const payload = objectValue(envelope.payload, "journal payload");
  const item = objectValue(payload.item, "tool_started Record");
  item.id = "impossible-tool-start-record";
  const corrupted = [...lines, JSON.stringify(envelope), ""].join("\n");
  await writeFile(file, corrupted);

  const reports: Array<RecoveryReport> = [];
  const spans: Array<CapturedSpan> = [];
  const provider: ProviderService = {
    streamAssistant: () => Stream.fromIterable([{ _tag: "done", stopReason: "done" }]),
  };
  const journalLayer = JournalJsonl(directory, { diagnosticSink: () => Effect.void });
  const drivers = DriverDefault({
    sessions: {
      recoveryDiagnosticSink: (report) => Effect.sync(() => reports.push(report)),
    },
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        journalLayer,
        Layer.succeed(Provider, provider),
        ToolRegistryLive(recoveryTools()),
      ),
    ),
  );
  const error = await Effect.runPromise(
    Effect.flip(
      Effect.gen(function* () {
        const driver = yield* Driver;
        yield* driver.resumeSession(recorded.sessionId);
      }).pipe(
        Effect.provide(Layer.merge(journalLayer, drivers)),
        Effect.provide(tracerLayer(spans)),
      ),
    ),
  );
  const recoverySpan = spans.find(({ name }) => name === "kernel.recovery");
  return {
    action: "reject-corrupt",
    corruptionClass:
      typeof error === "object" &&
      error !== null &&
      "corruptionClass" in error &&
      typeof error.corruptionClass === "string"
        ? error.corruptionClass
        : undefined,
    fileByteExact: (await readFile(file, "utf8")) === corrupted,
    recoveryReportEmitted: reports.length > 0,
    recoverySpanFailed: recoverySpan?.exit?._tag === "Failure",
  };
};

export const runDoubleRecoveryCell = async (directory: string): Promise<DoubleRecoveryCell> => {
  const recorded = await recordToolTurn(join(directory, "recorded"));
  const safeBoundary = recorded.boundaries.find(
    ({ kind, replay }) => kind === "tool_started" && replay === "safe",
  );
  if (safeBoundary === undefined) {
    throw new Error("The Tool Turn fixture has no replay-safe start boundary.");
  }

  const cellDirectory = join(directory, "cell");
  const originalFault: FaultState = {
    acknowledgements: 0,
    failAfter: safeBoundary.acknowledgement,
    killed: false,
    sessionId: undefined,
  };
  const originalTurnCrashed = await executeScript("tool-turn", cellDirectory, originalFault).then(
    () => false,
    () => true,
  );
  if (originalFault.sessionId === undefined) {
    throw new Error("The original Tool Turn crash did not identify a Session.");
  }

  const provider: ProviderService = {
    streamAssistant: () => Stream.fromIterable([{ _tag: "done", stopReason: "done" }]),
  };
  const recoveryFault: FaultState = {
    acknowledgements: 0,
    failAfter: 2,
    killed: false,
    sessionId: undefined,
  };
  const firstRecoveryLayer = jsonlLayer(cellDirectory, recoveryFault);
  const firstRecoveryDriver = DriverDefault().pipe(
    Layer.provide(
      Layer.mergeAll(
        firstRecoveryLayer,
        Layer.succeed(Provider, provider),
        ToolRegistryLive(recoveryTools()),
      ),
    ),
  );
  const firstRecovery = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const driver = yield* Driver;
      yield* driver.resumeSession(originalFault.sessionId as SessionId);
    }).pipe(Effect.provide(firstRecoveryDriver)),
  );

  const reports: Array<RecoveryReport> = [];
  const spans: Array<CapturedSpan> = [];
  const journalLayer = JournalJsonl(cellDirectory, { diagnosticSink: () => Effect.void });
  const drivers = DriverDefault({
    sessions: {
      recoveryDiagnosticSink: (report) => Effect.sync(() => reports.push(report)),
    },
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        journalLayer,
        Layer.succeed(Provider, provider),
        ToolRegistryLive(recoveryTools()),
      ),
    ),
  );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const driver = yield* Driver;
      const journal = yield* Journal;
      const recovered = yield* driver.resumeSession(originalFault.sessionId as SessionId);
      const branch = yield* journal.readBranch(originalFault.sessionId as SessionId);
      const records = yield* journal.readRecords(originalFault.sessionId as SessionId);
      const final = yield* driver.resumeSession(originalFault.sessionId as SessionId);
      return { branch, final, records, recovered };
    }).pipe(Effect.provide(Layer.merge(journalLayer, drivers)), Effect.provide(tracerLayer(spans))),
  );
  return {
    finalReportActionCount: result.final.recovery.actions.length,
    firstRecoveryCrashed: firstRecovery._tag === "Failure",
    interruptedAssistantCount: result.branch.filter((entry) =>
      isInterruptedAssistantPayload(messagePayload(entry)),
    ).length,
    operationFinishedCount: result.records.filter(({ kind }) => kind === "operation_finished")
      .length,
    originalTurnCrashed,
    recoveryReportEmitted:
      reports.length === 2 &&
      JSON.stringify(reports[0]) === JSON.stringify(result.recovered.recovery),
    recoverySpanEmitted:
      spans.filter(({ name }) => name === "kernel.recovery").length === 2 &&
      spans
        .filter(({ name }) => name === "kernel.recovery")
        .every(({ exit }) => exit?._tag === "Success"),
    toolResultIds: resultCallIds(result.branch),
  };
};

export const runOrphanedPromptDoubleRecoveryCell = async (
  directory: string,
): Promise<OrphanedPromptDoubleRecoveryCell> => {
  const recorded = await recordToolFreeTurn(join(directory, "recorded"));
  const promptBoundary = recorded.boundaries.find(({ kind }) => kind === "message:user");
  if (promptBoundary === undefined) {
    throw new Error("The Tool-free Turn fixture has no user prompt boundary.");
  }

  const cellDirectory = join(directory, "cell");
  const originalFault: FaultState = {
    acknowledgements: 0,
    failAfter: promptBoundary.acknowledgement,
    killed: false,
    sessionId: undefined,
  };
  const originalTurnCrashed = await executeScript(
    "tool-free-turn",
    cellDirectory,
    originalFault,
  ).then(
    () => false,
    () => true,
  );
  if (originalFault.sessionId === undefined) {
    throw new Error("The orphaned-prompt crash did not identify a Session.");
  }
  const sessionId = originalFault.sessionId;

  const plan = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const records = yield* journal.readRecords(sessionId);
      const entries = yield* journal.readBranch(sessionId);
      return yield* recoverSession(boundedRecoveryRecords(records), entries);
    }).pipe(Effect.provide(JournalJsonl(cellDirectory, { diagnosticSink: () => Effect.void }))),
  );
  if (plan.operationId !== undefined) {
    throw new Error("The orphaned-prompt recovery unexpectedly found an operationId.");
  }

  const provider: ProviderService = {
    streamAssistant: () => Stream.fromIterable([{ _tag: "done", stopReason: "done" }]),
  };
  const recoveryFault: FaultState = {
    acknowledgements: 0,
    failAfter: 1,
    killed: false,
    sessionId: undefined,
  };
  const firstRecoveryLayer = jsonlLayer(cellDirectory, recoveryFault);
  const firstRecoveryDriver = DriverDefault().pipe(
    Layer.provide(
      Layer.mergeAll(
        firstRecoveryLayer,
        Layer.succeed(Provider, provider),
        ToolRegistryLive(recoveryTools()),
      ),
    ),
  );
  const firstRecovery = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const driver = yield* Driver;
      yield* driver.resumeSession(sessionId);
    }).pipe(Effect.provide(firstRecoveryDriver)),
  );

  const journalLayer = JournalJsonl(cellDirectory, { diagnosticSink: () => Effect.void });
  const drivers = DriverDefault().pipe(
    Layer.provide(
      Layer.mergeAll(
        journalLayer,
        Layer.succeed(Provider, provider),
        ToolRegistryLive(recoveryTools()),
      ),
    ),
  );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const retry = yield* applyRecoveryPlan(journal, sessionId, plan);
      const resumed = yield* (yield* Driver).resumeSession(sessionId);
      const branch = yield* journal.readBranch(sessionId);
      const records = yield* journal.readRecords(sessionId);
      return { branch, records, resumed, retry };
    }).pipe(Effect.provide(Layer.merge(journalLayer, drivers))),
  );

  return {
    finalReportActionCount: result.resumed.recovery.actions.length,
    finalReportEntriesAppendedCount: result.resumed.recovery.entriesAppended.length,
    firstRecoveryCrashed: firstRecovery._tag === "Failure",
    interruptedAssistantCount: result.branch.filter((entry) =>
      isInterruptedAssistantPayload(messagePayload(entry)),
    ).length,
    operationRecordCount: result.records.length,
    originalTurnCrashed,
    retryActionCount: result.retry.actions.length,
    retryEntriesAppendedCount: result.retry.entriesAppended.length,
    retryOperationIdFound: result.retry.operationIdFound,
  };
};
