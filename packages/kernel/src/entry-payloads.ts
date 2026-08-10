/**
 * Owns the kernel message Entry payload Schemas shared by Turn persistence and recovery reads.
 * It exists so both paths use one AssistantDiagnostic shape and one trust-boundary decoder.
 */

import { Schema } from "effect";

import { ASSISTANT_STOP_REASONS } from "./provider.js";

export const AssistantDiagnosticSchema = Schema.Union(
  Schema.Struct({
    detail: Schema.String,
    reason: Schema.Literal("budget_exceeded", "journal_failure", "turn_failure"),
  }),
  Schema.Struct({
    attempts: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
    detail: Schema.String,
    reason: Schema.Literal("provider_error"),
  }),
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
