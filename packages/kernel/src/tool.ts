/**
 * Owns execution-side Tool declarations and the minimal in-kernel registry used by M9.
 * It exists so a Tool's schema, capability requirements, and execution remain one declaration.
 * This is not the plugin contribution system - Phase 3 owns contribution and feeds this registry.
 */

import type { SessionId } from "@peye/journal";
import type { Scope } from "effect";
import { Context, Effect, Layer, type Schema } from "effect";

import { DuplicateToolName, type ToolError } from "./errors.js";
import type { ToolReplay } from "./records.js";

export type ToolExecutionMode = "parallel" | "sequential";

export interface ToolExecutionContext {
  readonly sessionId: SessionId;
}

export interface ToolResult {
  readonly content: string;
  readonly isError?: boolean;
}

// Phase 3 will provide tool capabilities. Scope is the only allowed v1 requirement so an
// unconstrained R cannot silently compile while leaving services unprovided.
export interface Tool<TArguments, R extends Scope.Scope = never> {
  readonly description: string;
  readonly execute: (
    arguments_: TArguments,
    context: ToolExecutionContext,
  ) => Effect.Effect<ToolResult, ToolError, R>;
  readonly executionMode?: ToolExecutionMode;
  readonly name: string;
  readonly parameters: Schema.Schema<TArguments>;
  readonly replay?: ToolReplay;
  readonly requiredCapabilities?: ReadonlyArray<string>;
}

export namespace Tool {
  /** Existential view used only after defineTool preserves declaration-site inference. */
  export interface Any {
    readonly description: string;
    readonly execute: (
      arguments_: never,
      context: ToolExecutionContext,
    ) => Effect.Effect<ToolResult, ToolError, Scope.Scope>;
    readonly executionMode?: ToolExecutionMode;
    readonly name: string;
    readonly parameters: Schema.Schema<unknown>;
    readonly replay?: ToolReplay;
    readonly requiredCapabilities?: ReadonlyArray<string>;
  }
}

export const defineTool = <TArguments, R extends Scope.Scope = never>(
  tool: Tool<TArguments, R>,
): Tool<TArguments, R> & Tool.Any => tool as Tool<TArguments, R> & Tool.Any;

export interface RegisteredTool {
  readonly description: string;
  readonly execute: (
    arguments_: unknown,
    context: ToolExecutionContext,
  ) => Effect.Effect<ToolResult, ToolError, Scope.Scope>;
  readonly executionMode: ToolExecutionMode;
  readonly name: string;
  readonly parameters: Schema.Schema<unknown>;
  readonly replay: ToolReplay;
  readonly requiredCapabilities: ReadonlyArray<string>;
}

export interface ToolRegistryService {
  readonly get: (name: string) => RegisteredTool | undefined;
  readonly list: () => ReadonlyArray<RegisteredTool>;
}

export class ToolRegistry extends Context.Tag("@peye/kernel/ToolRegistry")<
  ToolRegistry,
  ToolRegistryService
>() {}

const registerTool = (tool: Tool.Any): RegisteredTool => ({
  description: tool.description,
  execute: (arguments_, context) => tool.execute(arguments_ as never, context),
  executionMode: tool.executionMode ?? "parallel",
  name: tool.name,
  parameters: tool.parameters as Schema.Schema<unknown>,
  replay: tool.replay ?? "never",
  requiredCapabilities: tool.requiredCapabilities ?? [],
});

export const ToolRegistryLive = (
  tools: ReadonlyArray<Tool.Any>,
): Layer.Layer<ToolRegistry, DuplicateToolName> =>
  Layer.effect(
    ToolRegistry,
    Effect.gen(function* () {
      const registered: Array<RegisteredTool> = [];
      const registry = new Map<string, RegisteredTool>();
      for (const tool of tools) {
        if (registry.has(tool.name)) {
          return yield* new DuplicateToolName({
            message: `Duplicate tool name: ${tool.name}.`,
            name: tool.name,
          });
        }
        const next = registerTool(tool);
        registered.push(next);
        registry.set(next.name, next);
      }
      return {
        get: (name) => registry.get(name),
        list: () => [...registered],
      } satisfies ToolRegistryService;
    }),
  );
