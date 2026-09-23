/**
 * Owns the kernel message Entry payload Schemas shared by Turn persistence and recovery reads.
 * It exists so both paths use one AssistantDiagnostic shape and one trust-boundary decoder.
 */

import { EntryIdSchema } from "@popeye/journal";
import { Schema } from "effect";

import { ASSISTANT_STOP_REASONS, THINKING_LEVELS } from "./provider.js";

export const ModelChangePayloadSchema = Schema.Struct({
  model: Schema.NonEmptyString,
});

export type ModelChangePayload = Schema.Schema.Type<typeof ModelChangePayloadSchema>;

export const ThinkingChangePayloadSchema = Schema.Struct({
  thinkingLevel: Schema.Literal(...THINKING_LEVELS),
});

export type ThinkingChangePayload = Schema.Schema.Type<typeof ThinkingChangePayloadSchema>;

export const SESSION_NAME_MAX_LENGTH = 200;

export const SessionNameSchema = Schema.String.pipe(
  Schema.filter((name) => name.trim().length > 0, {
    message: () => "Session name must contain a non-whitespace character",
  }),
  Schema.maxLength(SESSION_NAME_MAX_LENGTH, {
    message: () => `Session name must be at most ${SESSION_NAME_MAX_LENGTH} characters`,
  }),
);

export const SessionNamePayloadSchema = Schema.Struct({
  name: SessionNameSchema,
});

export type SessionNamePayload = Schema.Schema.Type<typeof SessionNamePayloadSchema>;

/**
 * C2 diagnostic extension (RFC-02 P1): ProviderError transient and status
 * ride the settled assistant diagnostic so the HCN run mapper can classify
 * failures in-process, before the head boundary. Fields are optional so
 * older journal lines still decode.
 */
export const ProviderDiagnosticFieldsSchema = Schema.Struct({
  status: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
  transient: Schema.optional(Schema.Boolean),
});

export const AssistantDiagnosticSchema = Schema.Union(
  Schema.Struct({
    compactionApplied: Schema.optional(EntryIdSchema),
    detail: Schema.String,
    reason: Schema.Literal("budget_exceeded"),
  }),
  Schema.Struct({
    detail: Schema.String,
    reason: Schema.Literal("journal_failure", "turn_failure"),
  }),
  Schema.extend(
    Schema.Struct({
      attempts: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
      detail: Schema.String,
      reason: Schema.Literal("provider_error"),
    }),
    ProviderDiagnosticFieldsSchema,
  ),
);

export type AssistantDiagnostic = Schema.Schema.Type<typeof AssistantDiagnosticSchema>;

export const MessageToolCallSchema = Schema.Struct({
  argumentsJson: Schema.String,
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
});

export type MessageToolCall = Schema.Schema.Type<typeof MessageToolCallSchema>;

export const AssistantMessagePayloadSchema = Schema.Struct({
  content: Schema.String,
  diagnostic: Schema.optional(AssistantDiagnosticSchema),
  role: Schema.Literal("assistant"),
  stopReason: Schema.Literal(...ASSISTANT_STOP_REASONS),
  toolCalls: Schema.optional(Schema.Array(MessageToolCallSchema)),
});

export const ToolResultMessagePayloadSchema = Schema.Struct({
  content: Schema.String,
  isError: Schema.Boolean,
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.NonEmptyString,
  toolName: Schema.NonEmptyString,
});

export const UserMessagePayloadSchema = Schema.Struct({
  content: Schema.String,
  deliveryMode: Schema.optional(Schema.Literal("steer")),
  role: Schema.Literal("user"),
});

export const MessageEntryPayloadSchema = Schema.Union(
  AssistantMessagePayloadSchema,
  ToolResultMessagePayloadSchema,
  UserMessagePayloadSchema,
);

export type MessageEntryPayload = Schema.Schema.Type<typeof MessageEntryPayloadSchema>;
