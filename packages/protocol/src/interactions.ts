/**
 * Owns kernel-initiated interaction requests and Head responses.
 * It exists so timeout and fallback behavior is declared before a Head receives a request.
 */
import { Schema } from "effect";

import { PositiveIntegerSchema } from "./schema-common.js";

export const SelectFallbackSchema = Schema.Struct({
  kind: Schema.Literal("select"),
  value: Schema.String,
});

export const ConfirmFallbackSchema = Schema.Struct({
  kind: Schema.Literal("confirm"),
  value: Schema.Boolean,
});

export const InputFallbackSchema = Schema.Struct({
  kind: Schema.Literal("input"),
  value: Schema.String,
});

export const InteractionFallbackSchema = Schema.Union(
  SelectFallbackSchema,
  ConfirmFallbackSchema,
  InputFallbackSchema,
);

export const SelectOptionSchema = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
});

export const InteractionRequestSchema = Schema.Union(
  Schema.TaggedStruct("interaction-request", {
    fallback: SelectFallbackSchema,
    id: Schema.NonEmptyString,
    kind: Schema.Literal("select"),
    options: Schema.Array(SelectOptionSchema).pipe(Schema.minItems(1)),
    prompt: Schema.String,
    timeoutMs: PositiveIntegerSchema,
  }),
  Schema.TaggedStruct("interaction-request", {
    fallback: ConfirmFallbackSchema,
    id: Schema.NonEmptyString,
    kind: Schema.Literal("confirm"),
    prompt: Schema.String,
    timeoutMs: PositiveIntegerSchema,
  }),
  Schema.TaggedStruct("interaction-request", {
    fallback: InputFallbackSchema,
    id: Schema.NonEmptyString,
    kind: Schema.Literal("input"),
    placeholder: Schema.optional(Schema.String),
    prompt: Schema.String,
    timeoutMs: PositiveIntegerSchema,
  }),
);

export type InteractionRequest = Schema.Schema.Type<typeof InteractionRequestSchema>;

export const InteractionResponseSchema = Schema.Union(
  Schema.TaggedStruct("interaction-response", {
    id: Schema.NonEmptyString,
    kind: Schema.Literal("select"),
    value: Schema.String,
  }),
  Schema.TaggedStruct("interaction-response", {
    id: Schema.NonEmptyString,
    kind: Schema.Literal("confirm"),
    value: Schema.Boolean,
  }),
  Schema.TaggedStruct("interaction-response", {
    id: Schema.NonEmptyString,
    kind: Schema.Literal("input"),
    value: Schema.String,
  }),
);

export type InteractionResponse = Schema.Schema.Type<typeof InteractionResponseSchema>;
