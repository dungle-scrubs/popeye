/**
 * Owns kernel operation Record kinds, their payload Schemas, and validated Journal writers.
 * It exists because D-022 makes replay idempotent by recording durable identities before later
 * side effects depend on them.
 *
 * The Journal owns Entry id generation, so the prompt Entry id is recorded immediately after its
 * append. Tool-result idempotency uses the operationId/toolCallId pair rather than the RFC's literal
 * pre-provisioned result Entry id. The guarantee is identical: recovery appends a result only when
 * no toolResult Entry for that durable Tool call identity exists.
 */

import {
  type EntryId,
  EntryIdSchema,
  JournalDraftRejected,
  type JournalFailure,
  type JournalService,
  type Record,
  RecordDraftSchema,
  type SessionId,
} from "@peye/journal";
import { Effect, type ParseResult, Schema } from "effect";

import { ASSISTANT_STOP_REASONS, type AssistantStopReason } from "./provider.js";

export const OperationIdSchema = Schema.NonEmptyString.pipe(Schema.brand("OperationId"));

export type OperationId = Schema.Schema.Type<typeof OperationIdSchema>;

export const createOperationId = (): Effect.Effect<OperationId> =>
  Effect.sync(() => OperationIdSchema.make(crypto.randomUUID()));

export const OperationStartedPayloadSchema = Schema.Struct({
  intent: Schema.Literal("turn"),
  operationId: OperationIdSchema,
  promptEntryId: EntryIdSchema,
  turnOrdinal: Schema.Number.pipe(Schema.int(), Schema.positive()),
});

export interface OperationStartedPayload {
  readonly intent: "turn";
  readonly operationId: OperationId;
  readonly promptEntryId: EntryId;
  readonly turnOrdinal: number;
}

export const ToolReplaySchema = Schema.Literal("never", "safe");

export type ToolReplay = Schema.Schema.Type<typeof ToolReplaySchema>;

export const ToolStartedPayloadSchema = Schema.Struct({
  operationId: OperationIdSchema,
  replay: ToolReplaySchema,
  toolCallId: Schema.NonEmptyString,
  toolName: Schema.NonEmptyString,
});

export interface ToolStartedPayload {
  readonly operationId: OperationId;
  readonly replay: ToolReplay;
  readonly toolCallId: string;
  readonly toolName: string;
}

export const OperationOutcomeSchema = Schema.Literal(...ASSISTANT_STOP_REASONS);

export type OperationOutcome = AssistantStopReason;

export const OperationFinishedPayloadSchema = Schema.Struct({
  operationId: OperationIdSchema,
  outcome: OperationOutcomeSchema,
});

export interface OperationFinishedPayload {
  readonly operationId: OperationId;
  readonly outcome: OperationOutcome;
}

const strict: { readonly onExcessProperty: "error" } = { onExcessProperty: "error" };
const decodeOperationFinished = Schema.decodeUnknown(OperationFinishedPayloadSchema, strict);
const decodeOperationStarted = Schema.decodeUnknown(OperationStartedPayloadSchema, strict);
const decodeToolStarted = Schema.decodeUnknown(ToolStartedPayloadSchema, strict);

const invalidPayload = (kind: string, cause: unknown): JournalDraftRejected =>
  new JournalDraftRejected({ cause, kind, reason: "invalid_payload" });

const appendValidatedRecord = <TPayload>(
  journal: JournalService,
  sessionId: SessionId,
  kind: string,
  payload: TPayload,
  decode: (input: unknown) => Effect.Effect<TPayload, ParseResult.ParseError>,
): Effect.Effect<Record, JournalFailure> =>
  decode(payload).pipe(
    Effect.mapError((cause) => invalidPayload(kind, cause)),
    Effect.flatMap((validated) =>
      journal.appendRecord(sessionId, RecordDraftSchema.make({ kind, payload: validated })),
    ),
  );

export const appendOperationStarted = (
  journal: JournalService,
  sessionId: SessionId,
  payload: OperationStartedPayload,
): Effect.Effect<Record, JournalFailure> =>
  appendValidatedRecord(journal, sessionId, "operation_started", payload, decodeOperationStarted);

export const appendToolStarted = (
  journal: JournalService,
  sessionId: SessionId,
  payload: ToolStartedPayload,
): Effect.Effect<Record, JournalFailure> =>
  appendValidatedRecord(journal, sessionId, "tool_started", payload, decodeToolStarted);

export const appendOperationFinished = (
  journal: JournalService,
  sessionId: SessionId,
  payload: OperationFinishedPayload,
): Effect.Effect<Record, JournalFailure> =>
  appendValidatedRecord(journal, sessionId, "operation_finished", payload, decodeOperationFinished);
