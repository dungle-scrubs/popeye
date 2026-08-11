/**
 * Owns command frames sent by Heads to the Kernel composition boundary.
 * It exists so kernel primitives and plugin Commands have one strict wire contract.
 */

import { Schema } from "effect";
import { EntryIdSchema, SessionIdSchema } from "#journal";

import { NonNegativeIntegerSchema } from "./schema-common.js";

export const COMMAND_TAGS = [
  "abort",
  "branch",
  "create",
  "fork",
  "get-snapshot",
  "invoke-command",
  "list",
  "prompt",
  "resume",
  "set-model",
  "set-thinking",
  "steer",
  "subscribe-progress",
] as const;

const CorrelationFields = {
  id: Schema.optional(Schema.String),
};

const SessionFields = {
  ...CorrelationFields,
  sessionId: SessionIdSchema,
};

const ExpectedRevisionFields = {
  expectedRevision: Schema.optional(NonNegativeIntegerSchema),
};

export const ThinkingLevelSchema = Schema.Literal(
  "high",
  "low",
  "max",
  "medium",
  "minimal",
  "xhigh",
);

export const CommandSchema = Schema.Union(
  Schema.TaggedStruct("create", CorrelationFields),
  Schema.TaggedStruct("resume", SessionFields),
  Schema.TaggedStruct("list", CorrelationFields),
  Schema.TaggedStruct("prompt", {
    ...SessionFields,
    content: Schema.String,
    deliveryMode: Schema.optional(Schema.Literal("followUp", "steer")),
    ...ExpectedRevisionFields,
  }),
  Schema.TaggedStruct("steer", {
    ...SessionFields,
    content: Schema.String,
  }),
  Schema.TaggedStruct("abort", SessionFields),
  Schema.TaggedStruct("get-snapshot", {
    ...SessionFields,
    afterEntryId: Schema.optional(EntryIdSchema),
    beforeEntryId: Schema.optional(EntryIdSchema),
  }),
  Schema.TaggedStruct("subscribe-progress", SessionFields),
  Schema.TaggedStruct("branch", {
    ...SessionFields,
    ...ExpectedRevisionFields,
    toEntryId: EntryIdSchema,
  }),
  Schema.TaggedStruct("fork", {
    ...SessionFields,
    ...ExpectedRevisionFields,
    fromEntryId: EntryIdSchema,
  }),
  Schema.TaggedStruct("set-model", {
    ...SessionFields,
    ...ExpectedRevisionFields,
    model: Schema.NonEmptyString,
  }),
  Schema.TaggedStruct("set-thinking", {
    ...SessionFields,
    ...ExpectedRevisionFields,
    thinkingLevel: ThinkingLevelSchema,
  }),
  Schema.TaggedStruct("invoke-command", {
    ...SessionFields,
    args: Schema.Unknown,
    ...ExpectedRevisionFields,
    name: Schema.NonEmptyString,
  }),
);

export type Command = Schema.Schema.Type<typeof CommandSchema>;
