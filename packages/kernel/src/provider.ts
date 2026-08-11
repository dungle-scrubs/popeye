/**
 * Owns the Provider seam consumed by turns and implemented by pi-ai in M12.
 * It exists so turn coordination is independent from a concrete LLM endpoint.
 * Provider requests receive tool declarations per request (D-004/D-005) so each
 * Turn can pin a Session view; compaction requests carry no tools.
 */

import { Context, Schema, type Stream } from "effect";

import type { ProviderError } from "./errors.js";
import type { RegisteredTool } from "./tool.js";

export const ASSISTANT_STOP_REASONS = [
  "aborted",
  "done",
  "error",
  "toolCalls",
  "truncated",
] as const;

export type AssistantStopReason = (typeof ASSISTANT_STOP_REASONS)[number];

export const AssistantStopReasonSchema = Schema.Literal(...ASSISTANT_STOP_REASONS);

export const THINKING_LEVELS = ["high", "low", "max", "medium", "minimal", "xhigh"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const ThinkingLevelSchema = Schema.Literal(...THINKING_LEVELS);

export interface ContextToolCall {
  readonly argumentsJson: string;
  readonly id: string;
  readonly name: string;
}

export const asContextToolCalls = (value: unknown): ReadonlyArray<ContextToolCall> | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const calls: Array<ContextToolCall> = [];
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) {
      return undefined;
    }
    const call = candidate as {
      readonly argumentsJson?: unknown;
      readonly id?: unknown;
      readonly name?: unknown;
    };
    if (
      typeof call.argumentsJson !== "string" ||
      typeof call.id !== "string" ||
      typeof call.name !== "string"
    ) {
      return undefined;
    }
    calls.push({ argumentsJson: call.argumentsJson, id: call.id, name: call.name });
  }
  return calls;
};

export type ContextItem =
  | {
      readonly content: string;
      readonly role: "assistant";
      readonly toolCalls?: ReadonlyArray<ContextToolCall>;
    }
  | { readonly content: string; readonly role: "system" | "user" }
  | {
      readonly content: string;
      readonly isError: boolean;
      readonly role: "toolResult";
      readonly toolCallId: string;
      readonly toolName: string;
    };

export type AssistantItem =
  | { readonly _tag: "done"; readonly stopReason: AssistantStopReason }
  | { readonly _tag: "textDelta"; readonly text: string }
  | { readonly _tag: "thinkingDelta"; readonly text: string }
  | {
      readonly _tag: "toolCall";
      readonly argumentsJson: string;
      readonly id: string;
      readonly name: string;
    }
  | {
      readonly _tag: "toolCallDelta";
      readonly argumentsJsonDelta: string;
      readonly id: string;
      readonly index?: number;
      readonly name: string | undefined;
    };

export interface ProviderStreamOptions {
  readonly attempt: number;
  readonly model?: string;
  readonly purpose?: "compaction" | "turn";
  readonly sliceIndex?: number;
  readonly thinkingLevel?: ThinkingLevel;
  readonly tools?: ReadonlyArray<RegisteredTool>;
  readonly turnOrdinal: number;
}

export interface ProviderService {
  readonly streamAssistant: (
    context: ReadonlyArray<ContextItem>,
    options: ProviderStreamOptions,
  ) => Stream.Stream<AssistantItem, ProviderError>;
}

export class Provider extends Context.Tag("@pop-eye/kernel/Provider")<
  Provider,
  ProviderService
>() {}
