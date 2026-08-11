/**
 * Owns family-specific decoding at protocol trust boundaries.
 * It exists so Commands stay strict while newer Snapshot and Progress frames remain readable.
 */
import { Effect, Schema } from "effect";

import { COMMAND_TAGS, type Command, CommandSchema } from "./commands.js";
import { ProtocolError } from "./errors.js";
import {
  type InteractionRequest,
  InteractionRequestSchema,
  type InteractionResponse,
  InteractionResponseSchema,
} from "./interactions.js";
import { type Progress, ProgressSchema } from "./progress.js";
import { type Response, ResponseSchema } from "./results.js";
import { LenientParseOptions, StrictParseOptions } from "./schema-common.js";
import { type Snapshot, SnapshotSchema } from "./snapshot.js";

const commandTags: ReadonlySet<string> = new Set(COMMAND_TAGS);

const malformed = (family: string, cause: unknown): ProtocolError =>
  new ProtocolError({
    cause,
    message: `Malformed ${family} frame: ${String(cause)}`,
    reason: "malformed_frame",
  });

const hasUnknownCommandTag = (input: unknown): input is { readonly _tag: string } => {
  if (typeof input !== "object" || input === null || !("_tag" in input)) {
    return false;
  }
  const tag = input._tag;
  return typeof tag === "string" && !commandTags.has(tag);
};

export const decodeCommand = (input: unknown): Effect.Effect<Command, ProtocolError> => {
  if (hasUnknownCommandTag(input)) {
    return Effect.fail(
      new ProtocolError({
        message: `Unknown command tag: ${input._tag}`,
        reason: "unknown_command",
      }),
    );
  }
  return Schema.decodeUnknown(
    CommandSchema,
    StrictParseOptions,
  )(input).pipe(Effect.mapError((cause) => malformed("command", cause)));
};

export const decodeSnapshot = (input: unknown): Effect.Effect<Snapshot, ProtocolError> =>
  Schema.decodeUnknown(
    SnapshotSchema,
    LenientParseOptions,
  )(input).pipe(Effect.mapError((cause) => malformed("Snapshot", cause)));

export const decodeProgress = (input: unknown): Effect.Effect<Progress, ProtocolError> =>
  Schema.decodeUnknown(
    ProgressSchema,
    LenientParseOptions,
  )(input).pipe(Effect.mapError((cause) => malformed("Progress", cause)));

export const decodeInteractionRequest = (
  input: unknown,
): Effect.Effect<InteractionRequest, ProtocolError> =>
  Schema.decodeUnknown(
    InteractionRequestSchema,
    LenientParseOptions,
  )(input).pipe(Effect.mapError((cause) => malformed("interaction request", cause)));

export const decodeInteractionResponse = (
  input: unknown,
): Effect.Effect<InteractionResponse, ProtocolError> =>
  Schema.decodeUnknown(
    InteractionResponseSchema,
    StrictParseOptions,
  )(input).pipe(Effect.mapError((cause) => malformed("interaction response", cause)));

export const decodeResponse = (input: unknown): Effect.Effect<Response, ProtocolError> =>
  Schema.decodeUnknown(
    ResponseSchema,
    StrictParseOptions,
  )(input).pipe(Effect.mapError((cause) => malformed("response", cause)));
