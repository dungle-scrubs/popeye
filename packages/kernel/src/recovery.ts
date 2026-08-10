/**
 * Owns crash recovery planning and resume-time application for one Session.
 * It exists because recovery is a pure function of a bounded Record slice, which makes every
 * durable action inspectable and repeatable without hidden Journal reads.
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

import { asContextToolCalls, type ContextToolCall } from "./provider.js";
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

export interface RecoveryAction {
  readonly action:
    | "already_resolved"
    | "safe_replay"
    | "synthesized_interrupted"
    | "synthesized_missing_tool";
  readonly replay: ToolReplay;
  readonly toolCallId: string;
  readonly toolName: string;
}

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

const schemaMismatch = (record: Record, cause: unknown): JournalError =>
  new JournalError({
    cause,
    corruptionClass: "schema_mismatch",
    message: `Record ${record.id} payload does not match ${record.kind}: ${String(cause)}`,
  });

const interruptedAssistant = (operationId: OperationId): EntryDraft =>
  EntryDraftSchema.make({
    kind: "message",
    payload: {
      content: "Turn interrupted by crash.",
      diagnostic: { detail: "interrupted by crash", operationId, reason: "turn_failure" },
      role: "assistant",
      stopReason: "error",
    },
  });

const interruptedToolResult = (toolCallId: string): EntryDraft =>
  EntryDraftSchema.make({
    kind: "message",
    payload: {
      content: "Tool execution interrupted by crash.",
      isError: true,
      role: "toolResult",
      toolCallId,
    },
  });

const toolResultCallId = (payload: unknown): string | undefined => {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const result = payload as { readonly role?: unknown; readonly toolCallId?: unknown };
  return result.role === "toolResult" && typeof result.toolCallId === "string"
    ? result.toolCallId
    : undefined;
};

const completedToolCallIds = (entries: ReadonlyArray<Entry>): ReadonlySet<string> => {
  const completed = new Set<string>();
  for (const entry of entries) {
    const toolCallId = toolResultCallId(entry.payload);
    if (toolCallId !== undefined) {
      completed.add(toolCallId);
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
  entries: ReadonlyArray<Entry>,
): ReadonlyMap<string, ContextToolCall> => {
  const indexed = new Map<string, ContextToolCall>();
  for (const entry of entries) {
    if (typeof entry.payload !== "object" || entry.payload === null) {
      continue;
    }
    const payload = entry.payload as { readonly role?: unknown; readonly toolCalls?: unknown };
    if (payload.role !== "assistant") {
      continue;
    }
    for (const call of asContextToolCalls(payload.toolCalls) ?? []) {
      if (!indexed.has(call.id)) {
        indexed.set(call.id, call);
      }
    }
  }
  return indexed;
};

const invalidSequence = (message: string): JournalError =>
  new JournalError({ corruptionClass: "invalid_record_sequence", message });

const recoveredOperationIds = (entries: ReadonlyArray<Entry>): ReadonlySet<string> => {
  const recovered = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.payload !== "object" || entry.payload === null) {
      continue;
    }
    const payload = entry.payload as {
      readonly diagnostic?: { readonly operationId?: unknown };
      readonly role?: unknown;
    };
    if (payload.role === "assistant" && typeof payload.diagnostic?.operationId === "string") {
      recovered.add(payload.diagnostic.operationId);
    }
  }
  return recovered;
};

const finishedOperationIds = (records: ReadonlyArray<Record>): ReadonlySet<string> => {
  const finished = new Set<string>();
  for (const record of records) {
    if (
      record.kind === "operation_finished" &&
      typeof record.payload === "object" &&
      record.payload !== null
    ) {
      const payload = record.payload as { readonly operationId?: unknown };
      if (typeof payload.operationId === "string") {
        finished.add(payload.operationId);
      }
    }
  }
  return finished;
};

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
  const boundaryStart = records.findLastIndex(
    (record, index) => index <= lastFinished && record.kind === "operation_started",
  );
  return records.slice(boundaryStart < 0 ? lastFinished : boundaryStart);
};

export const recoverSession = (
  records: ReadonlyArray<Record>,
  entries: ReadonlyArray<Entry>,
): Effect.Effect<RecoveryPlan, JournalError> =>
  Effect.gen(function* () {
    const open = yield* parseOpenOperation(records);
    if (open === undefined) {
      return idlePlan;
    }
    const operationEntries = entriesForOperation(entries, open.started.promptEntryId);
    if (operationEntries === undefined) {
      return yield* invalidSequence(
        `operation_started ${open.started.operationId} names missing prompt Entry ${open.started.promptEntryId}.`,
      );
    }
    const completed = completedToolCallIds(operationEntries);
    const assistantCalls = assistantToolCallsById(operationEntries);
    const safeReplay: Array<SafeReplayCall> = [];
    for (const tool of open.tools) {
      const call = assistantCalls.get(tool.toolCallId);
      if (call === undefined || call.name !== tool.toolName) {
        return yield* invalidSequence(
          `tool_started ${tool.toolCallId} does not match an assistant Tool call.`,
        );
      }
      if (!completed.has(tool.toolCallId) && tool.replay === "safe") {
        safeReplay.push({
          argumentsJson: call.argumentsJson,
          name: call.name,
          operationId: open.started.operationId,
          toolCallId: call.id,
        });
      }
    }
    const unresolvedTools = open.tools.filter((tool) => !completed.has(tool.toolCallId));
    const interrupted = unresolvedTools.filter((tool) => tool.replay === "never");
    return {
      actions: open.tools.map((tool) => ({
        action: completed.has(tool.toolCallId)
          ? "already_resolved"
          : tool.replay === "never"
            ? "synthesized_interrupted"
            : "safe_replay",
        replay: tool.replay,
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
      })),
      assistantEntry: interruptedAssistant(open.started.operationId),
      finish: { operationId: open.started.operationId, outcome: "error" },
      operationId: open.started.operationId,
      promptEntryId: open.started.promptEntryId,
      safeReplay,
      toolResults: interrupted.map((tool) => interruptedToolResult(tool.toolCallId)),
    } satisfies RecoveryPlan;
  });

export const applyRecoveryPlan = (
  journal: JournalService,
  sessionId: SessionId,
  plan: RecoveryPlan,
  options: RecoveryApplicationOptions = {},
): Effect.Effect<RecoveryReport, JournalFailure> =>
  Effect.gen(function* () {
    if (plan.operationId === undefined) {
      return {
        actions: [],
        entriesAppended: [],
        operationIdFound: undefined,
        safeReplay: [],
      } satisfies RecoveryReport;
    }
    const records = options.snapshot?.records ?? (yield* journal.readRecords(sessionId));
    if (finishedOperationIds(records).has(plan.operationId)) {
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
    const completed = new Set(completedToolCallIds(operationEntries));
    const recovered = recoveredOperationIds(entries);
    const appended: Array<EntryId> = [];
    const actionsByToolCallId = new Map(plan.actions.map((action) => [action.toolCallId, action]));
    const actions: Array<RecoveryAction> = plan.actions.filter(
      (action) => action.action === "already_resolved",
    );
    for (const result of plan.toolResults) {
      const toolCallId = toolResultCallId(result.payload);
      if (toolCallId === undefined || completed.has(toolCallId)) {
        continue;
      }
      const entry = yield* journal.appendEntry(sessionId, result);
      appended.push(entry.id);
      completed.add(toolCallId);
      const action = actionsByToolCallId.get(toolCallId);
      if (action !== undefined) {
        actions.push(action);
      }
    }

    const safeReplay: Array<SafeReplayCall> = [];
    for (const call of plan.safeReplay) {
      const planned = actionsByToolCallId.get(call.toolCallId);
      if (options.availableToolNames?.has(call.name) === true) {
        safeReplay.push(call);
        if (planned !== undefined) {
          actions.push(planned);
        }
        continue;
      }
      if (!completed.has(call.toolCallId)) {
        const entry = yield* journal.appendEntry(sessionId, interruptedToolResult(call.toolCallId));
        appended.push(entry.id);
        completed.add(call.toolCallId);
      }
      actions.push({
        action: "synthesized_missing_tool",
        replay: "safe",
        toolCallId: call.toolCallId,
        toolName: call.name,
      });
    }

    if (
      plan.assistantEntry !== undefined &&
      safeReplay.length === 0 &&
      !recovered.has(plan.operationId)
    ) {
      const assistant = yield* journal.appendEntry(sessionId, plan.assistantEntry);
      appended.push(assistant.id);
    }
    if (plan.finish !== undefined && safeReplay.length === 0) {
      yield* appendOperationFinished(journal, sessionId, plan.finish);
    }
    return {
      actions,
      entriesAppended: appended,
      operationIdFound: plan.operationId,
      safeReplay,
    } satisfies RecoveryReport;
  });
