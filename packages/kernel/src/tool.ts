/**
 * Owns execution-side Tool declarations and the session-keyed registry views.
 * It exists so a Tool's schema, capability requirements, and execution remain one declaration,
 * and so every Session resolves its own Tool view via view(sessionId) (D-004). The degenerate
 * ToolRegistryLive(tools) returns the same view for every Session, keeping simple hosts and
 * existing kernel tests working. The CLI generation-aware registry replaces this in M3. Recovery
 * identifies Tools by name only (documented caveat in docs/plugin-authoring.md).
 * Not responsible for Provider transport (ai/seam owns that) or for Tool execution batching
 * (tool-batch owns that); this module only owns declarations and lookup.
 */

import type { SessionId } from "@popeye/journal";
import type { Scope } from "effect";
import { Context, Effect, Layer, type Schema } from "effect";

import { DuplicateToolName, type ToolError } from "./errors.js";
import type { ToolReplay } from "./records.js";

export type ToolExecutionMode = "parallel" | "sequential";

export interface ToolExecutionContext {
  readonly sessionId: SessionId;
  readonly toolCallId?: string;
  readonly toolName?: string;
}

export interface ToolResult {
  readonly content: string;
  readonly isError?: boolean;
}

// Phase 3 will provide tool capabilities. Scope is the only allowed v1 requirement so an
// unconstrained R cannot silently compile while leaving services unprovided.
export interface Tool<TArguments, R extends Scope.Scope = never, TEncoded = TArguments> {
  readonly description: string;
  readonly execute: (
    arguments_: TArguments,
    context: ToolExecutionContext,
  ) => Effect.Effect<ToolResult, ToolError, R>;
  readonly executionMode?: ToolExecutionMode;
  readonly name: string;
  readonly parameters: Schema.Schema<TArguments, TEncoded>;
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
    readonly parameters: Schema.Schema<unknown, unknown>;
    readonly replay?: ToolReplay;
    readonly requiredCapabilities?: ReadonlyArray<string>;
  }
}

export const defineTool = <TArguments, R extends Scope.Scope = never, TEncoded = TArguments>(
  tool: Tool<TArguments, R, TEncoded>,
): Tool<TArguments, R, TEncoded> & Tool.Any => tool as Tool<TArguments, R, TEncoded> & Tool.Any;

export interface RegisteredTool {
  readonly description: string;
  readonly execute: (
    arguments_: unknown,
    context: ToolExecutionContext,
  ) => Effect.Effect<ToolResult, ToolError, Scope.Scope>;
  readonly executionMode: ToolExecutionMode;
  readonly name: string;
  readonly parameters: Schema.Schema<unknown, unknown>;
  readonly replay: ToolReplay;
  readonly requiredCapabilities: ReadonlyArray<string>;
}

export interface SessionToolView {
  readonly get: (name: string) => RegisteredTool | undefined;
  readonly list: () => ReadonlyArray<RegisteredTool>;
}

export interface ToolRegistryService {
  readonly view: (sessionId: SessionId) => Effect.Effect<SessionToolView>;
  /** @deprecated Prefer view(sessionId). Kept for degenerate hosts and existing tests. */
  readonly get: (name: string) => RegisteredTool | undefined;
  /** @deprecated Prefer view(sessionId). Kept for degenerate hosts and existing tests. */
  readonly list: () => ReadonlyArray<RegisteredTool>;
}

export class ToolRegistry extends Context.Tag("@popeye/kernel/ToolRegistry")<
  ToolRegistry,
  ToolRegistryService
>() {}

const registerTool = (tool: Tool.Any): RegisteredTool => ({
  description: tool.description,
  execute: (arguments_, context) => tool.execute(arguments_ as never, context),
  executionMode: tool.executionMode ?? "parallel",
  name: tool.name,
  parameters: tool.parameters,
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
      const view: SessionToolView = {
        get: (name) => registry.get(name),
        list: () => [...registered],
      };
      return {
        list: view.list,
        get: view.get,
        view: () => Effect.succeed(view),
      } satisfies ToolRegistryService;
    }),
  );
