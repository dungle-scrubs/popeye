/**
 * Owns crash recovery planning and resume-time application for one Session.
 * D-033 requires every recovery path to close its open operation. This preserves Context
 * well-formedness and ensures that a second crash cannot make the next resume fail.
 * Recovery remains a pure function of a bounded Record slice, so every durable action is
 * inspectable and repeatable without hidden Journal reads.
 */

import {
  type Entry,
  type EntryDraft,
  EntryDraftSchema,
  type EntryId,
  JournalError,
  type JournalFailure,
  type JournalService,
  type Record,
  type SessionId,
} from "@peye/journal";
import { Effect, Schema } from "effect";

import {
  type AssistantDiagnostic,
  type MessageEntryPayload,
  MessageEntryPayloadSchema,
  type MessageToolCall,
} from "./entry-payloads.js";
import type {
  OperationFinishedPayload,
  OperationId,
  OperationStartedPayload,
  ToolReplay,
  ToolStartedPayload,
} from "./records.js";
import {
  appendOperationFinished,
  OperationFinishedPayloadSchema,
  OperationStartedPayloadSchema,
  ToolStartedPayloadSchema,
} from "./records.js";

export interface ToolRecoveryAction {
  readonly action:
    | "already_resolved"
    | "safe_replay"
    | "synthesized_interrupted"
    | "synthesized_missing_tool";
  readonly replay: ToolReplay;
  readonly toolCallId: string;
  readonly toolName: string;
}

export type RecoveryAction =
  | ToolRecoveryAction
  | {
      readonly action: "orphaned_prompt_closed";
      readonly promptEntryId: EntryId;
    }
  | {
      readonly action: "unrecoverable-on-this-branch";
      readonly operationId: OperationId;
      readonly promptEntryId: EntryId;
    };

export interface SafeReplayCall {
  readonly argumentsJson: string;
  readonly name: string;
  readonly operationId: OperationId;
  readonly toolCallId: string;
}

export interface RecoveryPlan {
  readonly actions: ReadonlyArray<RecoveryAction>;
  readonly assistantEntry: EntryDraft | undefined;
  readonly finish: OperationFinishedPayload | undefined;
  readonly operationId: OperationId | undefined;
  readonly promptEntryId: EntryId | undefined;
  readonly safeReplay: ReadonlyArray<SafeReplayCall>;
  readonly toolResults: ReadonlyArray<EntryDraft>;
}

export interface RecoveryReport {
  readonly actions: ReadonlyArray<RecoveryAction>;
  readonly entriesAppended: ReadonlyArray<EntryId>;
  readonly operationIdFound: OperationId | undefined;
  readonly safeReplay: ReadonlyArray<SafeReplayCall>;
}

export interface RecoveryApplicationOptions {
  readonly availableToolNames?: ReadonlySet<string>;
  readonly snapshot?: {
    readonly entries: ReadonlyArray<Entry>;
    readonly records: ReadonlyArray<Record>;
  };
}

const idlePlan: RecoveryPlan = {
  actions: [],
  assistantEntry: undefined,
  finish: undefined,
  operationId: undefined,
  promptEntryId: undefined,
  safeReplay: [],
  toolResults: [],
};

const strict: { readonly onExcessProperty: "error" } = { onExcessProperty: "error" };
const decodeOperationFinished = Schema.decodeUnknown(OperationFinishedPayloadSchema, strict);
const decodeOperationStarted = Schema.decodeUnknown(OperationStartedPayloadSchema, strict);
const decodeToolStarted = Schema.decodeUnknown(ToolStartedPayloadSchema, strict);
const decodeMessageEntryPayload = Schema.decodeUnknown(MessageEntryPayloadSchema, strict);

const schemaMismatch = (record: Record, cause: unknown): JournalError =>
  new JournalError({
    cause,
    corruptionClass: "schema_mismatch",
    message: `Record ${record.id} payload does not match ${record.kind}: ${String(cause)}`,
  });

const interruptedDiagnostic = {
  detail: "interrupted by crash",
  reason: "turn_failure",
} satisfies AssistantDiagnostic;

const interruptedAssistant = (): EntryDraft =>
  EntryDraftSchema.make({
    kind: "message",
    payload: {
      content: "Turn interrupted by crash.",
      diagnostic: interruptedDiagnostic,
      role: "assistant",
      stopReason: "error",
    },
  });

const interruptedToolResult = (toolCallId: string, toolName: string): EntryDraft =>
  EntryDraftSchema.make({
    kind: "message",
    payload: {
      content: "Tool execution interrupted by crash.",
      isError: true,
      role: "toolResult",
      toolCallId,
      toolName,
    },
  });

const entrySchemaMismatch = (entry: Entry, cause: unknown): JournalError =>
  new JournalError({
    cause,
    corruptionClass: "schema_mismatch",
    message: `Entry ${entry.id} payload does not match ${entry.kind}: ${String(cause)}`,
  });

interface DecodedMessageEntry {
  readonly entry: Entry;
  readonly payload: MessageEntryPayload;
}

const decodeMessageEntries = (
  entries: ReadonlyArray<Entry>,
): Effect.Effect<ReadonlyArray<DecodedMessageEntry>, JournalError> =>
  Effect.gen(function* () {
    const decoded: Array<DecodedMessageEntry> = [];
    for (const entry of entries) {
      if (entry.kind !== "message") {
        continue;
      }
      const payload = yield* decodeMessageEntryPayload(entry.payload).pipe(
        Effect.mapError((cause) => entrySchemaMismatch(entry, cause)),
      );
      decoded.push({ entry, payload });
    }
    return decoded;
  });

const completedToolCallIds = (entries: ReadonlyArray<DecodedMessageEntry>): ReadonlySet<string> => {
  const completed = new Set<string>();
  for (const { payload } of entries) {
    if (payload.role === "toolResult") {
      completed.add(payload.toolCallId);
    }
  }
  return completed;
};

const entriesForOperation = (
  entries: ReadonlyArray<Entry>,
  promptEntryId: EntryId,
): ReadonlyArray<Entry> | undefined => {
  const promptIndex = entries.findIndex((entry) => entry.id === promptEntryId);
  return promptIndex < 0 ? undefined : entries.slice(promptIndex);
};

const assistantToolCallsById = (
  entries: ReadonlyArray<DecodedMessageEntry>,
): ReadonlyMap<string, MessageToolCall> => {
  const indexed = new Map<string, MessageToolCall>();
  for (const { payload } of entries) {
    if (payload.role !== "assistant") {
      continue;
    }
    for (const call of payload.toolCalls ?? []) {
      if (!indexed.has(call.id)) {
        indexed.set(call.id, call);
      }
    }
  }
  return indexed;
};

const invalidSequence = (message: string): JournalError =>
  new JournalError({ corruptionClass: "invalid_record_sequence", message });

const hasInterruptedAssistant = (entries: ReadonlyArray<DecodedMessageEntry>): boolean =>
  entries.some(
    ({ payload }) =>
      payload.role === "assistant" &&
      payload.stopReason === "error" &&
      payload.diagnostic?.reason === "turn_failure" &&
      payload.diagnostic.detail === interruptedDiagnostic.detail,
  );

const isLatestOperationFinished = (
  records: ReadonlyArray<Record>,
  operationId: OperationId,
): Effect.Effect<boolean, JournalError> =>
  Effect.gen(function* () {
    const startedIndex = records.findLastIndex(
      (candidate) => candidate.kind === "operation_started",
    );
    const startedRecord = records[startedIndex];
    if (startedRecord === undefined) {
      return false;
    }
    const started = yield* decodeOperationStarted(startedRecord.payload).pipe(
      Effect.mapError((cause) => schemaMismatch(startedRecord, cause)),
    );
    if (started.operationId !== operationId) {
      return false;
    }
    const finishedRecord = records
      .slice(startedIndex + 1)
      .find((candidate) => candidate.kind === "operation_finished");
    if (finishedRecord === undefined) {
      return false;
    }
    const finished = yield* decodeOperationFinished(finishedRecord.payload).pipe(
      Effect.mapError((cause) => schemaMismatch(finishedRecord, cause)),
    );
    return finished.operationId === operationId;
  });

interface OpenOperation {
  readonly started: OperationStartedPayload;
  readonly tools: ReadonlyArray<ToolStartedPayload>;
}

const parseOpenOperation = (
  records: ReadonlyArray<Record>,
): Effect.Effect<OpenOperation | undefined, JournalError> =>
  Effect.gen(function* () {
    let started: OperationStartedPayload | undefined;
    let tools: Array<ToolStartedPayload> = [];
    let toolCallIds = new Set<string>();
    for (const record of records) {
      if (record.kind === "operation_started") {
        const next = yield* decodeOperationStarted(record.payload).pipe(
          Effect.mapError((cause) => schemaMismatch(record, cause)),
        );
        if (started !== undefined) {
          return yield* invalidSequence(
            `operation_started ${next.operationId} follows open operation ${started.operationId}.`,
          );
        }
        started = next;
        tools = [];
        toolCallIds = new Set();
        continue;
      }
      if (record.kind === "tool_started") {
        const tool = yield* decodeToolStarted(record.payload).pipe(
          Effect.mapError((cause) => schemaMismatch(record, cause)),
        );
        if (started === undefined) {
          return yield* invalidSequence(
            `tool_started ${tool.toolCallId} has no open operation_started Record.`,
          );
        }
        if (tool.operationId !== started.operationId) {
          return yield* invalidSequence(
            `tool_started ${tool.toolCallId} names operation ${tool.operationId}, not ${started.operationId}.`,
          );
        }
        if (toolCallIds.has(tool.toolCallId)) {
          return yield* invalidSequence(
            `tool_started ${tool.toolCallId} appears more than once in operation ${tool.operationId}.`,
          );
        }
        tools.push(tool);
        toolCallIds.add(tool.toolCallId);
        continue;
      }
      if (record.kind === "operation_finished") {
        const finished: OperationFinishedPayload = yield* decodeOperationFinished(
          record.payload,
        ).pipe(Effect.mapError((cause) => schemaMismatch(record, cause)));
        if (started === undefined) {
          return yield* invalidSequence(
            `operation_finished ${finished.operationId} has no open operation_started Record.`,
          );
        }
        if (finished.operationId !== started.operationId) {
          return yield* invalidSequence(
            `operation_finished ${finished.operationId} does not close ${started.operationId}.`,
          );
        }
        started = undefined;
        tools = [];
        toolCallIds = new Set();
      }
    }
    return started === undefined ? undefined : { started, tools };
  });

export const boundedRecoveryRecords = (records: ReadonlyArray<Record>): ReadonlyArray<Record> => {
  const lastFinished = records.findLastIndex((record) => record.kind === "operation_finished");
  if (lastFinished < 0) {
    const firstOperationRecord = records.findIndex(
      (record) =>
        record.kind === "operation_started" ||
        record.kind === "operation_finished" ||
        record.kind === "tool_started",
    );
    return firstOperationRecord < 0 ? [] : records.slice(firstOperationRecord);
  }
  return records.slice(lastFinished + 1);
};

export const recoverSession = (
  records: ReadonlyArray<Record>,
  entries: ReadonlyArray<Entry>,
): Effect.Effect<RecoveryPlan, JournalError> =>
  Effect.gen(function* () {
    const open = yield* parseOpenOperation(records);
    if (open === undefined) {
      const trailing = entries.at(-1);
      if (trailing?.kind !== "message") {
        return idlePlan;
      }
      const payload = yield* decodeMessageEntryPayload(trailing.payload).pipe(
        Effect.mapError((cause) => entrySchemaMismatch(trailing, cause)),
      );
      if (payload.role !== "user") {
        return idlePlan;
      }
      return {
        actions: [{ action: "orphaned_prompt_closed", promptEntryId: trailing.id }],
        assistantEntry: interruptedAssistant(),
        finish: undefined,
        operationId: undefined,
        promptEntryId: trailing.id,
        safeReplay: [],
        toolResults: [],
      } satisfies RecoveryPlan;
    }
    const operationEntries = entriesForOperation(entries, open.started.promptEntryId);
    if (operationEntries === undefined) {
      return {
        actions: [
          {
            action: "unrecoverable-on-this-branch",
            operationId: open.started.operationId,
            promptEntryId: open.started.promptEntryId,
          },
        ],
        assistantEntry: undefined,
        finish: { operationId: open.started.operationId, outcome: "error" },
        operationId: open.started.operationId,
        promptEntryId: open.started.promptEntryId,
        safeReplay: [],
        toolResults: [],
      } satisfies RecoveryPlan;
    }
    const decodedEntries = yield* decodeMessageEntries(operationEntries);
    const completed = completedToolCallIds(decodedEntries);
    const assistantCalls = assistantToolCallsById(decodedEntries);
    const startedByCallId = new Map(open.tools.map((tool) => [tool.toolCallId, tool]));
    for (const tool of open.tools) {
      const call = assistantCalls.get(tool.toolCallId);
      if (call === undefined || call.name !== tool.toolName) {
        return yield* invalidSequence(
          `tool_started ${tool.toolCallId} does not match an assistant Tool call.`,
        );
      }
    }
    const actions: Array<RecoveryAction> = [];
    const safeReplay: Array<SafeReplayCall> = [];
    const toolResults: Array<EntryDraft> = [];
    for (const call of assistantCalls.values()) {
      const started = startedByCallId.get(call.id);
      const replay = started?.replay ?? "never";
      if (completed.has(call.id)) {
        actions.push({
          action: "already_resolved",
          replay,
          toolCallId: call.id,
          toolName: call.name,
        });
        continue;
      }
      actions.push({
        action: replay === "safe" ? "safe_replay" : "synthesized_interrupted",
        replay,
        toolCallId: call.id,
        toolName: call.name,
      });
      toolResults.push(interruptedToolResult(call.id, call.name));
      if (replay === "safe") {
        safeReplay.push({
          argumentsJson: call.argumentsJson,
          name: call.name,
          operationId: open.started.operationId,
          toolCallId: call.id,
        });
      }
    }
    return {
      actions,
      assistantEntry: interruptedAssistant(),
      finish: { operationId: open.started.operationId, outcome: "error" },
      operationId: open.started.operationId,
      promptEntryId: open.started.promptEntryId,
      safeReplay,
      toolResults,
    } satisfies RecoveryPlan;
  });

export const applyRecoveryPlan = (
  journal: JournalService,
  sessionId: SessionId,
  plan: RecoveryPlan,
  options: RecoveryApplicationOptions = {},
): Effect.Effect<RecoveryReport, JournalFailure> =>
  Effect.gen(function* () {
    const records = options.snapshot?.records ?? (yield* journal.readRecords(sessionId));
    if (
      plan.operationId !== undefined &&
      (yield* isLatestOperationFinished(records, plan.operationId))
    ) {
      return {
        actions: [],
        entriesAppended: [],
        operationIdFound: plan.operationId,
        safeReplay: [],
      } satisfies RecoveryReport;
    }

    const entries = options.snapshot?.entries ?? (yield* journal.readBranch(sessionId));
    const operationEntries =
      (plan.promptEntryId === undefined
        ? undefined
        : entriesForOperation(entries, plan.promptEntryId)) ?? [];
    const decodedEntries = yield* decodeMessageEntries(operationEntries);
    const completed = new Set(completedToolCallIds(decodedEntries));
    const recovered = hasInterruptedAssistant(decodedEntries);
    const appended: Array<EntryId> = [];
    for (const result of plan.toolResults) {
      const payload = yield* decodeMessageEntryPayload(result.payload).pipe(
        Effect.mapError(
          (cause) =>
            new JournalError({
              cause,
              corruptionClass: "schema_mismatch",
              message: `Recovery Entry payload does not match message: ${String(cause)}`,
            }),
        ),
      );
      if (payload.role !== "toolResult" || completed.has(payload.toolCallId)) {
        continue;
      }
      const entry = yield* journal.appendEntry(sessionId, result);
      appended.push(entry.id);
      completed.add(payload.toolCallId);
    }

    const safeReplay: Array<SafeReplayCall> = [];
    const missingSafeToolCallIds = new Set<string>();
    for (const call of plan.safeReplay) {
      if (options.availableToolNames === undefined || options.availableToolNames.has(call.name)) {
        safeReplay.push(call);
        continue;
      }
      missingSafeToolCallIds.add(call.toolCallId);
    }

    if (plan.assistantEntry !== undefined && !recovered) {
      const assistant = yield* journal.appendEntry(sessionId, plan.assistantEntry);
      appended.push(assistant.id);
    }
    if (plan.finish !== undefined) {
      yield* appendOperationFinished(journal, sessionId, plan.finish);
    }
    const actions = plan.actions.map((action): RecoveryAction => {
      if (action.action === "safe_replay" && missingSafeToolCallIds.has(action.toolCallId)) {
        return {
          action: "synthesized_missing_tool",
          replay: "safe",
          toolCallId: action.toolCallId,
          toolName: action.toolName,
        };
      }
      return action;
    });
    return {
      actions,
      entriesAppended: appended,
      operationIdFound: plan.operationId,
      safeReplay,
    } satisfies RecoveryReport;
  });
