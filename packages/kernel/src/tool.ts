/**
 * Owns execution-side Tool declarations and the minimal in-kernel registry used by M9.
 * It exists so a Tool's schema, capability requirements, and execution remain one declaration.
 * This is not the plugin contribution system - Phase 3 owns contribution and feeds this registry.
 */

import type { SessionId } from "@peye/journal";
import type { Effect } from "effect";
import { Context, Layer, type Schema } from "effect";

import type { ToolError } from "./errors.js";

export type ToolExecutionMode = "parallel" | "sequential";

export interface ToolExecutionContext {
  readonly sessionId: SessionId;
}

export interface ToolResult {
  readonly content: string;
  readonly isError?: boolean;
}

export interface Tool<TArguments, R = never> {
  readonly description: string;
  readonly execute: (
    arguments_: TArguments,
    context: ToolExecutionContext,
  ) => Effect.Effect<ToolResult, ToolError, R>;
  readonly executionMode?: ToolExecutionMode;
  readonly name: string;
  readonly parameters: Schema.Schema<TArguments>;
  readonly requiredCapabilities?: ReadonlyArray<string>;
}

export interface RegisteredTool {
  readonly description: string;
  readonly execute: (
    arguments_: unknown,
    context: ToolExecutionContext,
  ) => Effect.Effect<ToolResult, ToolError>;
  readonly executionMode: ToolExecutionMode;
  readonly name: string;
  readonly parameters: Schema.Schema<unknown>;
  readonly requiredCapabilities: ReadonlyArray<string>;
}

export interface ToolRegistryService {
  readonly get: (name: string) => RegisteredTool | undefined;
}

export class ToolRegistry extends Context.Tag("@peye/kernel/ToolRegistry")<
  ToolRegistry,
  ToolRegistryService
>() {}

const registerTool = <TArguments, R>(tool: Tool<TArguments, R>): RegisteredTool => ({
  description: tool.description,
  execute: (arguments_, context) =>
    tool.execute(arguments_ as TArguments, context) as unknown as Effect.Effect<
      ToolResult,
      ToolError
    >,
  executionMode: tool.executionMode ?? "parallel",
  name: tool.name,
  parameters: tool.parameters as Schema.Schema<unknown>,
  requiredCapabilities: tool.requiredCapabilities ?? [],
});

export const ToolRegistryLive = <TArguments, R>(
  tools: ReadonlyArray<Tool<TArguments, R>>,
): Layer.Layer<ToolRegistry> => {
  const registry = new Map(tools.map((tool) => [tool.name, registerTool(tool)]));
  return Layer.succeed(ToolRegistry, { get: (name) => registry.get(name) });
};
