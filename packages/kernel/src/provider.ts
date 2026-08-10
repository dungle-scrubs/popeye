/**
 * Owns the Provider seam consumed by turns and implemented by pi-ai in M12.
 * It exists so turn coordination is independent from a concrete LLM endpoint.
 */

import type { ContextItem } from "@peye/journal";
import { Context, type Stream } from "effect";

import type { ProviderError } from "./errors.js";

export type AssistantStopReason = "aborted" | "done" | "error" | "toolCalls";

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
      readonly name: string | undefined;
    };

export interface ProviderStreamOptions {
  readonly turnOrdinal: number;
}

export interface ProviderService {
  readonly streamAssistant: (
    context: ReadonlyArray<ContextItem>,
    options: ProviderStreamOptions,
  ) => Stream.Stream<AssistantItem, ProviderError>;
}

export class Provider extends Context.Tag("@peye/kernel/Provider")<Provider, ProviderService>() {}
