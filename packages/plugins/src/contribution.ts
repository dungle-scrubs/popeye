/**
 * Owns Contribution kinds and constructs their namespaced keys.
 * It exists so Plugin authors cannot supply an unqualified registry key.
 *
 * Tool Contribution declarations live here as plugin-side structural shapes. They match the
 * public kernel Tool interface without a runtime kernel dependency. This keeps the runtime graph
 * lean. A type-only compatibility test pins the structural contract against @pop-eye/kernel.
 */
import type { SessionId } from "@pop-eye/journal";
import type { Effect, Scope } from "effect";
import { Data, Schema } from "effect";

import { ContributionNameSchema, PluginNameSchema } from "./manifest.js";

declare const ContributionKeyType: unique symbol;

export type ContributionKey = `${string}/${string}` & {
  readonly [ContributionKeyType]: "ContributionKey";
};

export interface Contribution<TKind extends string = string, TPayload = unknown> {
  readonly kind: TKind;
  readonly name: string;
  readonly payload: TPayload;
  readonly priority?: number;
}

interface DefinedContribution<TKind extends string, TPayload>
  extends Contribution<TKind, TPayload> {
  readonly kind: TKind;
  readonly name: string;
  readonly priority: number;
}

export interface RegisteredContribution<TKind extends string = string, TPayload = unknown>
  extends Contribution<TKind, TPayload> {
  readonly key: ContributionKey;
  readonly priority: number;
  readonly registrationRevision: number;
}

export interface CommandCompactionResult {
  readonly compactionEntryId: string;
  readonly entriesCovered: number;
  readonly sliceCount: number;
  readonly summaryLength: number;
}

export interface CommandExecutionContext {
  readonly compactNow: (
    expectedRevision?: number,
  ) => Effect.Effect<CommandCompactionResult, unknown>;
  readonly sessionId: SessionId;
  readonly setSessionName: (
    name: string,
    expectedRevision?: number,
  ) => Effect.Effect<void, unknown>;
}

export interface CommandDeclaration<
  TInput = unknown,
  TOutput = unknown,
  TError = never,
  TRequirements = never,
  TEncoded = TInput,
> {
  readonly arguments: Schema.Schema<TInput, TEncoded>;
  readonly description: string;
  readonly execute: (
    input: TInput,
    context: CommandExecutionContext,
  ) => Effect.Effect<TOutput, TError, TRequirements>;
  readonly name: string;
}

export type CommandContribution<
  TInput = unknown,
  TOutput = unknown,
  TError = never,
  TRequirements = never,
  TEncoded = TInput,
> = DefinedContribution<
  "command",
  CommandDeclaration<TInput, TOutput, TError, TRequirements, TEncoded>
>;

export type HookMergeClass = "Accumulate" | "Chain" | "FirstWins" | "Tap";

export type HookExecute<
  TMergeClass extends HookMergeClass,
  TInput,
  TOutput,
  TError,
  TRequirements,
> = TMergeClass extends "Tap"
  ? (input: TInput) => Effect.Effect<void, TError, TRequirements>
  : TMergeClass extends "FirstWins"
    ? (input: TInput) => Effect.Effect<TOutput | undefined, TError, TRequirements>
    : (input: TInput) => Effect.Effect<TOutput, TError, TRequirements>;

export interface HookDeclaration<
  TMergeClass extends HookMergeClass,
  TInput = unknown,
  TOutput = unknown,
  TError = never,
  TRequirements = never,
> {
  readonly mergeClass: TMergeClass;
  readonly name: string;
  readonly point: string;
  readonly run: HookExecute<TMergeClass, TInput, TOutput, TError, TRequirements>;
}

export type HookContribution<
  TMergeClass extends HookMergeClass,
  TInput = unknown,
  TOutput = unknown,
  TError = never,
  TRequirements = never,
> = DefinedContribution<
  "hook",
  HookDeclaration<TMergeClass, TInput, TOutput, TError, TRequirements>
>;

export interface InstructionFragmentDeclaration {
  readonly content: string;
  readonly id: string;
  readonly trigger: "explicit";
}

export type InstructionFragmentContribution = DefinedContribution<
  "instruction-fragment",
  InstructionFragmentDeclaration
>;

export type ToolExecutionMode = "parallel" | "sequential";
export type ToolReplay = "never" | "safe";

export interface ToolExecutionContext {
  readonly sessionId: SessionId;
}

export interface ToolExecutionResult {
  readonly content: string;
  readonly isError?: boolean;
}

// WHY: This tag must equal kernel ToolError's tag for structural Effect error-channel
// compatibility. kernel-compatibility.test.ts pins the contract in both directions.
export class ToolContributionError extends Data.TaggedError("ToolError")<{
  readonly message: string;
  readonly toolCallId: string;
  readonly toolName: string;
}> {}

export interface ToolDeclaration<
  TArguments,
  TRequirements extends Scope.Scope = never,
  TEncoded = TArguments,
> {
  readonly description: string;
  readonly execute: (
    arguments_: TArguments,
    context: ToolExecutionContext,
  ) => Effect.Effect<ToolExecutionResult, ToolContributionError, TRequirements>;
  readonly executionMode?: ToolExecutionMode;
  readonly name: string;
  readonly parameters: Schema.Schema<TArguments, TEncoded>;
  readonly replay?: ToolReplay;
  readonly requiredCapabilities?: ReadonlyArray<string>;
}

export interface AnyToolDeclaration {
  readonly description: string;
  readonly execute: (
    arguments_: never,
    context: ToolExecutionContext,
  ) => Effect.Effect<ToolExecutionResult, ToolContributionError, Scope.Scope>;
  readonly executionMode?: ToolExecutionMode;
  readonly name: string;
  readonly parameters: Schema.Schema<unknown, unknown>;
  readonly replay?: ToolReplay;
  readonly requiredCapabilities?: ReadonlyArray<string>;
}

export type ToolContribution<
  TArguments,
  TRequirements extends Scope.Scope = never,
  TEncoded = TArguments,
> = DefinedContribution<
  "tool",
  ToolDeclaration<TArguments, TRequirements, TEncoded> & AnyToolDeclaration
>;

export const contributionKey = (plugin: string, name: string): ContributionKey =>
  `${Schema.decodeSync(PluginNameSchema)(plugin)}/${Schema.decodeSync(ContributionNameSchema)(name)}` as ContributionKey;

export const defineContribution = <TKind extends string, TPayload>(
  name: string,
  kind: TKind,
  payload: TPayload,
  priority = 0,
): DefinedContribution<TKind, TPayload> => ({
  kind,
  name: Schema.decodeSync(ContributionNameSchema)(name),
  payload,
  priority,
});

export const defineCommandContribution = <TInput, TOutput, TError, TRequirements, TEncoded>(
  command: CommandDeclaration<TInput, TOutput, TError, TRequirements, TEncoded>,
  priority = 0,
): CommandContribution<TInput, TOutput, TError, TRequirements, TEncoded> =>
  defineContribution(command.name, "command", command, priority);

export const defineHookContribution = <
  TMergeClass extends HookMergeClass,
  TInput,
  TOutput,
  TError,
  TRequirements,
>(
  hook: HookDeclaration<TMergeClass, TInput, TOutput, TError, TRequirements>,
  priority = 0,
): HookContribution<TMergeClass, TInput, TOutput, TError, TRequirements> =>
  defineContribution(hook.name, "hook", hook, priority);

export const defineInstructionFragmentContribution = (
  instructionFragment: InstructionFragmentDeclaration,
  priority = 0,
): InstructionFragmentContribution =>
  defineContribution(instructionFragment.id, "instruction-fragment", instructionFragment, priority);

export const defineToolContribution = <
  TArguments,
  TRequirements extends Scope.Scope = never,
  TEncoded = TArguments,
>(
  tool: ToolDeclaration<TArguments, TRequirements, TEncoded>,
  priority = 0,
): ToolContribution<TArguments, TRequirements, TEncoded> =>
  defineContribution(
    tool.name,
    "tool",
    tool as ToolDeclaration<TArguments, TRequirements, TEncoded> & AnyToolDeclaration,
    priority,
  );
