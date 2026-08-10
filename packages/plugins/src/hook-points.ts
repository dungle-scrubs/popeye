/**
 * Owns the declared input, output, merge, and failure semantics for every Hook point.
 * It exists so adding a Hook point is a data registration instead of a new execution path.
 */
import { Schema } from "effect";

export type HookPayload = Readonly<Record<string, unknown>>;

const payloadSchema = (): Schema.Schema<HookPayload> =>
  Schema.Record({ key: Schema.String, value: Schema.Unknown });

export const ContextHookInputSchema = payloadSchema();
export const ContextHookOutputSchema = payloadSchema();
export type ContextHookInput = Schema.Schema.Type<typeof ContextHookInputSchema>;
export type ContextHookOutput = Schema.Schema.Type<typeof ContextHookOutputSchema>;

export const ProviderRequestHookInputSchema = payloadSchema();
export const ProviderRequestHookOutputSchema = payloadSchema();
export type ProviderRequestHookInput = Schema.Schema.Type<typeof ProviderRequestHookInputSchema>;
export type ProviderRequestHookOutput = Schema.Schema.Type<typeof ProviderRequestHookOutputSchema>;

export const InputTransformHookInputSchema = payloadSchema();
export const InputTransformHookOutputSchema = payloadSchema();
export type InputTransformHookInput = Schema.Schema.Type<typeof InputTransformHookInputSchema>;
export type InputTransformHookOutput = Schema.Schema.Type<typeof InputTransformHookOutputSchema>;

export const InputHandlingHookInputSchema = payloadSchema();
export const InputHandlingHookOutputSchema = Schema.UndefinedOr(payloadSchema());
export type InputHandlingHookInput = Schema.Schema.Type<typeof InputHandlingHookInputSchema>;
export type InputHandlingHookOutput = Schema.Schema.Type<typeof InputHandlingHookOutputSchema>;

export const ToolCallGateHookInputSchema = payloadSchema();
export const ToolCallGateHookOutputSchema = Schema.UndefinedOr(payloadSchema());
export type ToolCallGateHookInput = Schema.Schema.Type<typeof ToolCallGateHookInputSchema>;
export type ToolCallGateHookOutput = Schema.Schema.Type<typeof ToolCallGateHookOutputSchema>;

export const ToolResultHookInputSchema = payloadSchema();
export const ToolResultHookOutputSchema = payloadSchema();
export type ToolResultHookInput = Schema.Schema.Type<typeof ToolResultHookInputSchema>;
export type ToolResultHookOutput = Schema.Schema.Type<typeof ToolResultHookOutputSchema>;

export const ResourceDiscoveryHookInputSchema = payloadSchema();
export const ResourceDiscoveryHookOutputSchema = payloadSchema();
export type ResourceDiscoveryHookInput = Schema.Schema.Type<
  typeof ResourceDiscoveryHookInputSchema
>;
export type ResourceDiscoveryHookOutput = Schema.Schema.Type<
  typeof ResourceDiscoveryHookOutputSchema
>;

export const CompactionGateHookInputSchema = payloadSchema();
export const CompactionGateHookOutputSchema = Schema.UndefinedOr(payloadSchema());
export type CompactionGateHookInput = Schema.Schema.Type<typeof CompactionGateHookInputSchema>;
export type CompactionGateHookOutput = Schema.Schema.Type<typeof CompactionGateHookOutputSchema>;

export const TrustHookInputSchema = payloadSchema();
export const TrustHookOutputSchema = Schema.UndefinedOr(payloadSchema());
export type TrustHookInput = Schema.Schema.Type<typeof TrustHookInputSchema>;
export type TrustHookOutput = Schema.Schema.Type<typeof TrustHookOutputSchema>;

export const TurnLifecycleHookInputSchema = payloadSchema();
export const TurnLifecycleHookOutputSchema = Schema.Void;
export type TurnLifecycleHookInput = Schema.Schema.Type<typeof TurnLifecycleHookInputSchema>;
export type TurnLifecycleHookOutput = Schema.Schema.Type<typeof TurnLifecycleHookOutputSchema>;

export const ProgressHookInputSchema = payloadSchema();
export const ProgressHookOutputSchema = Schema.Void;
export type ProgressHookInput = Schema.Schema.Type<typeof ProgressHookInputSchema>;
export type ProgressHookOutput = Schema.Schema.Type<typeof ProgressHookOutputSchema>;

export const SessionLifecycleHookInputSchema = payloadSchema();
export const SessionLifecycleHookOutputSchema = Schema.Void;
export type SessionLifecycleHookInput = Schema.Schema.Type<typeof SessionLifecycleHookInputSchema>;
export type SessionLifecycleHookOutput = Schema.Schema.Type<
  typeof SessionLifecycleHookOutputSchema
>;

export type HookFailurePolicy = "drop" | "reject" | "skip";

export interface HookPointTypeMap {
  readonly "compaction-gate": {
    readonly input: CompactionGateHookInput;
    readonly output: CompactionGateHookOutput;
  };
  readonly context: { readonly input: ContextHookInput; readonly output: ContextHookOutput };
  readonly "input-handling": {
    readonly input: InputHandlingHookInput;
    readonly output: InputHandlingHookOutput;
  };
  readonly "input-transform": {
    readonly input: InputTransformHookInput;
    readonly output: InputTransformHookOutput;
  };
  readonly progress: { readonly input: ProgressHookInput; readonly output: ProgressHookOutput };
  readonly "provider-request": {
    readonly input: ProviderRequestHookInput;
    readonly output: ProviderRequestHookOutput;
  };
  readonly "resource-discovery": {
    readonly input: ResourceDiscoveryHookInput;
    readonly output: ResourceDiscoveryHookOutput;
  };
  readonly "session-lifecycle": {
    readonly input: SessionLifecycleHookInput;
    readonly output: SessionLifecycleHookOutput;
  };
  readonly "tool-call-gate": {
    readonly input: ToolCallGateHookInput;
    readonly output: ToolCallGateHookOutput;
  };
  readonly "tool-result": {
    readonly input: ToolResultHookInput;
    readonly output: ToolResultHookOutput;
  };
  readonly trust: { readonly input: TrustHookInput; readonly output: TrustHookOutput };
  readonly "turn-lifecycle": {
    readonly input: TurnLifecycleHookInput;
    readonly output: TurnLifecycleHookOutput;
  };
}

export type HookPointName = keyof HookPointTypeMap;
export type HookPointInput<TPoint extends HookPointName> = HookPointTypeMap[TPoint]["input"];
export type HookPointOutput<TPoint extends HookPointName> = HookPointTypeMap[TPoint]["output"];

export interface HookPointDefinition {
  readonly combine: ((current: HookPayload, next: HookPayload) => HookPayload) | null;
  readonly failurePolicy: HookFailurePolicy;
  readonly inputSchema: Schema.Schema.AnyNoContext;
  readonly mergeClass: "Accumulate" | "Chain" | "FirstWins" | "Tap";
  readonly name: HookPointName;
  readonly outputSchema: Schema.Schema.AnyNoContext;
}

export const defineHookPoint = (definition: HookPointDefinition): HookPointDefinition => definition;

const mergeFields = (current: HookPayload, next: HookPayload): HookPayload => ({
  ...current,
  ...next,
});

export const HOOK_POINTS: Readonly<Record<HookPointName, HookPointDefinition>> = {
  "compaction-gate": defineHookPoint({
    combine: null,
    failurePolicy: "reject",
    inputSchema: CompactionGateHookInputSchema,
    mergeClass: "FirstWins",
    name: "compaction-gate",
    outputSchema: CompactionGateHookOutputSchema,
  }),
  context: defineHookPoint({
    combine: null,
    failurePolicy: "skip",
    inputSchema: ContextHookInputSchema,
    mergeClass: "Chain",
    name: "context",
    outputSchema: ContextHookOutputSchema,
  }),
  "input-handling": defineHookPoint({
    combine: null,
    // Input handling fails open so a broken optional Hook cannot discard user input.
    failurePolicy: "skip",
    inputSchema: InputHandlingHookInputSchema,
    mergeClass: "FirstWins",
    name: "input-handling",
    outputSchema: InputHandlingHookOutputSchema,
  }),
  "input-transform": defineHookPoint({
    combine: null,
    failurePolicy: "skip",
    inputSchema: InputTransformHookInputSchema,
    mergeClass: "Chain",
    name: "input-transform",
    outputSchema: InputTransformHookOutputSchema,
  }),
  progress: defineHookPoint({
    combine: null,
    failurePolicy: "drop",
    inputSchema: ProgressHookInputSchema,
    mergeClass: "Tap",
    name: "progress",
    outputSchema: ProgressHookOutputSchema,
  }),
  "provider-request": defineHookPoint({
    combine: null,
    failurePolicy: "skip",
    inputSchema: ProviderRequestHookInputSchema,
    mergeClass: "Chain",
    name: "provider-request",
    outputSchema: ProviderRequestHookOutputSchema,
  }),
  "resource-discovery": defineHookPoint({
    combine: mergeFields,
    failurePolicy: "skip",
    inputSchema: ResourceDiscoveryHookInputSchema,
    mergeClass: "Accumulate",
    name: "resource-discovery",
    outputSchema: ResourceDiscoveryHookOutputSchema,
  }),
  "session-lifecycle": defineHookPoint({
    combine: null,
    failurePolicy: "drop",
    inputSchema: SessionLifecycleHookInputSchema,
    mergeClass: "Tap",
    name: "session-lifecycle",
    outputSchema: SessionLifecycleHookOutputSchema,
  }),
  "tool-call-gate": defineHookPoint({
    combine: null,
    failurePolicy: "reject",
    inputSchema: ToolCallGateHookInputSchema,
    mergeClass: "FirstWins",
    name: "tool-call-gate",
    outputSchema: ToolCallGateHookOutputSchema,
  }),
  "tool-result": defineHookPoint({
    combine: mergeFields,
    failurePolicy: "skip",
    inputSchema: ToolResultHookInputSchema,
    mergeClass: "Accumulate",
    name: "tool-result",
    outputSchema: ToolResultHookOutputSchema,
  }),
  trust: defineHookPoint({
    combine: null,
    failurePolicy: "reject",
    inputSchema: TrustHookInputSchema,
    mergeClass: "FirstWins",
    name: "trust",
    outputSchema: TrustHookOutputSchema,
  }),
  "turn-lifecycle": defineHookPoint({
    combine: null,
    failurePolicy: "drop",
    inputSchema: TurnLifecycleHookInputSchema,
    mergeClass: "Tap",
    name: "turn-lifecycle",
    outputSchema: TurnLifecycleHookOutputSchema,
  }),
};

export const HOOK_POINT_NAMES = [
  "context",
  "provider-request",
  "input-transform",
  "input-handling",
  "tool-call-gate",
  "tool-result",
  "resource-discovery",
  "compaction-gate",
  "trust",
  "turn-lifecycle",
  "progress",
  "session-lifecycle",
] as const satisfies ReadonlyArray<HookPointName>;
