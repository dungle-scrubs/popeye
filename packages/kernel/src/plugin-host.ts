/**
 * Owns the kernel-side seam for Plugin Command dispatch.
 * It exists so the Driver can invoke Commands without depending on the Plugin package.
 */
import type { SessionId } from "@popeye/journal";
import { Context, Data, Effect, Layer } from "effect";

export class InvokeCommandError extends Data.TaggedError("InvokeCommandError")<{
  readonly cause?: unknown;
  readonly commandName: string;
  readonly message: string;
  readonly reason:
    | "arguments_invalid"
    | "command_ambiguous"
    | "command_failed"
    | "command_not_found"
    | "command_vetoed";
}> {}

export interface PluginCompactionGateRequest {
  readonly reason: "manual" | "overflow";
  readonly tokenCount: number;
}

export type PluginCompactionGateResult =
  | { readonly action: "compact" }
  | { readonly action: "skip"; readonly reason: string };

export interface PluginCompactionResult {
  readonly compactionEntryId: string;
  readonly entriesCovered: number;
  readonly sliceCount: number;
  readonly summaryLength: number;
}

export interface PluginCommandContext {
  readonly compactNow: (
    expectedRevision?: number,
  ) => Effect.Effect<PluginCompactionResult, unknown>;
  readonly sessionId: SessionId;
  readonly setSessionName: (
    name: string,
    expectedRevision?: number,
  ) => Effect.Effect<void, unknown>;
}

export interface PluginHostService {
  readonly compactionGate: (
    sessionId: SessionId,
    request: PluginCompactionGateRequest,
  ) => Effect.Effect<PluginCompactionGateResult>;
  readonly invokeCommand: (
    name: string,
    args: unknown,
    context: PluginCommandContext,
  ) => Effect.Effect<unknown, InvokeCommandError>;
}

export class PluginHost extends Context.Tag("@popeye/kernel/PluginHost")<
  PluginHost,
  PluginHostService
>() {}

export const PluginHostNone: Layer.Layer<PluginHost> = Layer.succeed(PluginHost, {
  compactionGate: () => Effect.succeed({ action: "compact" }),
  invokeCommand: (name) =>
    Effect.fail(
      new InvokeCommandError({
        commandName: name,
        message: `Command ${name} was not found.`,
        reason: "command_not_found",
      }),
    ),
});
