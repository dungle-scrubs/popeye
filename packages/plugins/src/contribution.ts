/**
 * Owns Contribution kinds and constructs their namespaced keys.
 * It exists so Plugin authors cannot supply an unqualified registry key.
 *
 * Tool Contribution declarations live here as plugin-side structural shapes. They match the
 * public kernel Tool interface without importing kernel internals or adding a plugins-to-kernel
 * dependency that the TypeScript project graph does not permit.
 */
import type { SessionId } from "@peye/journal";
import type { Effect, Schema, Scope } from "effect";
import { Data } from "effect";

declare const ContributionKeyType: unique symbol;

export type ContributionKey = `${string}/${string}` & {
  readonly [ContributionKeyType]: "ContributionKey";
};

export interface Contribution<TPayload = unknown> {
  readonly key: ContributionKey;
  readonly kind: string;
  readonly payload: TPayload;
  readonly priority?: number;
}

interface DefinedContribution<TKind extends string, TPayload> extends Contribution<TPayload> {
  readonly kind: TKind;
  readonly priority: number;
}

export type CommandHandlerData =
  | boolean
  | number
  | string
  | null
  | ReadonlyArray<CommandHandlerData>
  | { readonly [key: string]: CommandHandlerData };

export interface CommandExecutionContext {
  readonly sessionId: SessionId;
}

export interface CommandDeclaration<
  TInput = unknown,
  TOutput = unknown,
  TError = never,
  TRequirements = never,
> {
  readonly description: string;
  readonly execute: (
    input: TInput,
    context: CommandExecutionContext,
  ) => Effect.Effect<TOutput, TError, TRequirements>;
  readonly handler: CommandHandlerData;
  readonly name: string;
}

export type CommandContribution<
  TInput = unknown,
  TOutput = unknown,
  TError = never,
  TRequirements = never,
> = DefinedContribution<"command", CommandDeclaration<TInput, TOutput, TError, TRequirements>>;

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

export interface HookHandler<
  TMergeClass extends HookMergeClass,
  TInput,
  TOutput,
  TError,
  TRequirements,
> {
  readonly execute: HookExecute<TMergeClass, TInput, TOutput, TError, TRequirements>;
  readonly mergeClass: TMergeClass;
}

export interface HookDeclaration<
  TMergeClass extends HookMergeClass,
  TInput = unknown,
  TOutput = unknown,
  TError = never,
  TRequirements = never,
> {
  readonly handler: HookHandler<TMergeClass, TInput, TOutput, TError, TRequirements>;
  readonly name: string;
  readonly point: string;
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
  `${plugin}/${name}` as ContributionKey;

const defineContribution = <TKind extends string, TPayload>(
  plugin: string,
  name: string,
  kind: TKind,
  payload: TPayload,
  priority: number,
): DefinedContribution<TKind, TPayload> => ({
  key: contributionKey(plugin, name),
  kind,
  payload,
  priority,
});

export const defineCommandContribution = <TInput, TOutput, TError, TRequirements>(
  plugin: string,
  command: CommandDeclaration<TInput, TOutput, TError, TRequirements>,
  priority = 0,
): CommandContribution<TInput, TOutput, TError, TRequirements> =>
  defineContribution(plugin, command.name, "command", command, priority);

export const defineHookContribution = <
  TMergeClass extends HookMergeClass,
  TInput,
  TOutput,
  TError,
  TRequirements,
>(
  plugin: string,
  hook: HookDeclaration<TMergeClass, TInput, TOutput, TError, TRequirements>,
  priority = 0,
): HookContribution<TMergeClass, TInput, TOutput, TError, TRequirements> =>
  defineContribution(plugin, hook.name, "hook", hook, priority);

export const defineInstructionFragmentContribution = (
  plugin: string,
  instructionFragment: InstructionFragmentDeclaration,
  priority = 0,
): InstructionFragmentContribution =>
  defineContribution(
    plugin,
    instructionFragment.id,
    "instruction-fragment",
    instructionFragment,
    priority,
  );

export const defineToolContribution = <
  TArguments,
  TRequirements extends Scope.Scope = never,
  TEncoded = TArguments,
>(
  plugin: string,
  tool: ToolDeclaration<TArguments, TRequirements, TEncoded>,
  priority = 0,
): ToolContribution<TArguments, TRequirements, TEncoded> =>
  defineContribution(
    plugin,
    tool.name,
    "tool",
    tool as ToolDeclaration<TArguments, TRequirements, TEncoded> & AnyToolDeclaration,
    priority,
  );
