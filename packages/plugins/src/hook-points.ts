/**
 * Owns the declared input, output, result, merge, failure, and latency semantics for every Hook
 * point. Runtime extensions are registered through ContributionRegistry.registerHookPoint so the
 * exported built-in table can remain immutable.
 */
import type { Duration } from "effect";
import { Schema } from "effect";

export type HookPayload = Readonly<Record<string, unknown>>;

const UnknownFieldsSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });

export const ContextHookInputSchema = Schema.Struct({
  messages: Schema.Array(Schema.Unknown),
  tokenBudget: Schema.Number,
});
export const ContextHookOutputSchema = ContextHookInputSchema;
export const ContextHookResultSchema = ContextHookOutputSchema;

export const ProviderRequestHookInputSchema = Schema.Struct({
  messages: Schema.Array(Schema.Unknown),
  model: Schema.String,
  options: UnknownFieldsSchema,
});
export const ProviderRequestHookOutputSchema = ProviderRequestHookInputSchema;
export const ProviderRequestHookResultSchema = ProviderRequestHookOutputSchema;

export const InputTransformHookInputSchema = Schema.Struct({ text: Schema.String });
export const InputTransformHookOutputSchema = InputTransformHookInputSchema;
export const InputTransformHookResultSchema = InputTransformHookOutputSchema;

export const InputHandlingResultSchema = Schema.Struct({
  handledBy: Schema.String,
  response: Schema.optional(Schema.String),
});
export const InputHandlingHookInputSchema = Schema.Struct({ text: Schema.String });
export const InputHandlingHookOutputSchema = Schema.Union(
  Schema.Struct({ decision: Schema.Literal("continue") }),
  Schema.Struct({ decision: Schema.Literal("handled"), value: InputHandlingResultSchema }),
);

export const ToolCallGateResultSchema = Schema.Struct({
  arguments: Schema.Unknown,
  toolCallId: Schema.String,
  toolName: Schema.String,
});
export const ToolCallGateHookInputSchema = ToolCallGateResultSchema;

export const CompactionGateResultSchema = Schema.Union(
  Schema.Struct({ action: Schema.Literal("compact") }),
  Schema.Struct({ action: Schema.Literal("skip"), reason: Schema.String }),
);
export const CompactionGateHookInputSchema = Schema.Struct({
  reason: Schema.String,
  tokenCount: Schema.Number,
});

export const TrustChangeSummarySchema = Schema.Struct({
  added: Schema.Array(Schema.String),
  modified: Schema.Array(Schema.String),
  removed: Schema.Array(Schema.String),
});
export const TrustResultSchema = Schema.Struct({
  decision: Schema.Literal("trusted", "untrusted"),
});
export const TrustHookInputSchema = Schema.Struct({
  changeSummary: Schema.optional(TrustChangeSummarySchema),
  currentDigest: Schema.String,
  kind: Schema.Literal("prompt_required", "reprompt_required"),
  projectPath: Schema.String,
});

const gateDecisionSchema = <TValue, TEncoded>(value: Schema.Schema<TValue, TEncoded>) =>
  Schema.Union(
    Schema.Struct({ decision: Schema.Literal("continue") }),
    Schema.Struct({ decision: Schema.Literal("block"), reason: Schema.String }),
    Schema.Struct({ decision: Schema.Literal("replace"), value }),
  );

export const ToolCallGateHookOutputSchema = gateDecisionSchema(ToolCallGateResultSchema);
export const CompactionGateHookOutputSchema = CompactionGateResultSchema;
export const TrustHookOutputSchema = gateDecisionSchema(TrustResultSchema);

export const ToolResultHookInputSchema = Schema.Struct({
  content: Schema.String,
  isError: Schema.Boolean,
  metadata: UnknownFieldsSchema,
  toolCallId: Schema.String,
  toolName: Schema.String,
});
export const ToolResultHookOutputSchema = Schema.Struct({
  content: Schema.optional(Schema.String),
  isError: Schema.optional(Schema.Boolean),
  metadata: Schema.optional(UnknownFieldsSchema),
});
export const ToolResultHookResultSchema = ToolResultHookInputSchema;

export const ResourceDiscoveryHookInputSchema = Schema.Struct({ query: Schema.String });
export const ResourceDiscoveryHookOutputSchema = Schema.Struct({
  metadata: Schema.optional(UnknownFieldsSchema),
  resources: Schema.optional(Schema.Array(Schema.String)),
});
export const ResourceDiscoveryHookResultSchema = Schema.Struct({
  metadata: Schema.optional(UnknownFieldsSchema),
  query: Schema.String,
  resources: Schema.optional(Schema.Array(Schema.String)),
});

export const TurnLifecycleHookInputSchema = Schema.Struct({
  phase: Schema.Literal("assembling", "executing", "settling", "streaming"),
  sessionId: Schema.String,
});
export const TurnLifecycleHookOutputSchema = Schema.Void;
export const TurnLifecycleHookResultSchema = Schema.Void;

export const ProgressHookInputSchema = Schema.Struct({
  completed: Schema.Number,
  message: Schema.String,
  total: Schema.Number,
});
export const ProgressHookOutputSchema = Schema.Void;
export const ProgressHookResultSchema = Schema.Void;

export const SessionLifecycleHookInputSchema = Schema.Struct({
  event: Schema.Literal("created", "closed", "resumed"),
  sessionId: Schema.String,
});
export const SessionLifecycleHookOutputSchema = Schema.Void;
export const SessionLifecycleHookResultSchema = Schema.Void;

export type ContextHookInput = Schema.Schema.Type<typeof ContextHookInputSchema>;
export type ContextHookOutput = Schema.Schema.Type<typeof ContextHookOutputSchema>;
export type ProviderRequestHookInput = Schema.Schema.Type<typeof ProviderRequestHookInputSchema>;
export type ProviderRequestHookOutput = Schema.Schema.Type<typeof ProviderRequestHookOutputSchema>;
export type InputTransformHookInput = Schema.Schema.Type<typeof InputTransformHookInputSchema>;
export type InputTransformHookOutput = Schema.Schema.Type<typeof InputTransformHookOutputSchema>;
export type InputHandlingHookInput = Schema.Schema.Type<typeof InputHandlingHookInputSchema>;
export type InputHandlingHookOutput = Schema.Schema.Type<typeof InputHandlingHookOutputSchema>;
export type InputHandlingResult = Schema.Schema.Type<typeof InputHandlingResultSchema>;
export type ToolCallGateHookInput = Schema.Schema.Type<typeof ToolCallGateHookInputSchema>;
export type ToolCallGateHookOutput = Schema.Schema.Type<typeof ToolCallGateHookOutputSchema>;
export type ToolCallGateResult = Schema.Schema.Type<typeof ToolCallGateResultSchema>;
export type ToolResultHookInput = Schema.Schema.Type<typeof ToolResultHookInputSchema>;
export type ToolResultHookOutput = Schema.Schema.Type<typeof ToolResultHookOutputSchema>;
export type ResourceDiscoveryHookInput = Schema.Schema.Type<
  typeof ResourceDiscoveryHookInputSchema
>;
export type ResourceDiscoveryHookOutput = Schema.Schema.Type<
  typeof ResourceDiscoveryHookOutputSchema
>;
export type CompactionGateHookInput = Schema.Schema.Type<typeof CompactionGateHookInputSchema>;
export type CompactionGateHookOutput = Schema.Schema.Type<typeof CompactionGateHookOutputSchema>;
export type CompactionGateResult = Schema.Schema.Type<typeof CompactionGateResultSchema>;
export type TrustHookInput = Schema.Schema.Type<typeof TrustHookInputSchema>;
export type TrustHookOutput = Schema.Schema.Type<typeof TrustHookOutputSchema>;
export type TrustResult = Schema.Schema.Type<typeof TrustResultSchema>;
export type TurnLifecycleHookInput = Schema.Schema.Type<typeof TurnLifecycleHookInputSchema>;
export type TurnLifecycleHookOutput = Schema.Schema.Type<typeof TurnLifecycleHookOutputSchema>;
export type ProgressHookInput = Schema.Schema.Type<typeof ProgressHookInputSchema>;
export type ProgressHookOutput = Schema.Schema.Type<typeof ProgressHookOutputSchema>;
export type SessionLifecycleHookInput = Schema.Schema.Type<typeof SessionLifecycleHookInputSchema>;
export type SessionLifecycleHookOutput = Schema.Schema.Type<
  typeof SessionLifecycleHookOutputSchema
>;

export type HookFailurePolicy = "drop" | "reject" | "skip";
export type HookMergeClass = "Accumulate" | "Chain" | "FirstWins" | "Tap";

export interface HookPointDefinition<
  TName extends string = string,
  TMergeClass extends HookMergeClass = HookMergeClass,
  TFailurePolicy extends HookFailurePolicy = HookFailurePolicy,
  TInputSchema extends Schema.Schema.AnyNoContext = Schema.Schema.AnyNoContext,
  TOutputSchema extends Schema.Schema.AnyNoContext = Schema.Schema.AnyNoContext,
  TResultSchema extends Schema.Schema.AnyNoContext = Schema.Schema.AnyNoContext,
> {
  readonly conflictPolicy: TMergeClass extends "Accumulate" ? "highest-priority-wins" : null;
  readonly failurePolicy: TFailurePolicy;
  readonly inputSchema: TInputSchema;
  readonly mergeClass: TMergeClass;
  readonly name: TName;
  readonly outputSchema: TOutputSchema;
  readonly resultSchema: TResultSchema;
  readonly timeout: Duration.DurationInput;
}

export const defineHookPoint = <
  const TName extends string,
  const TMergeClass extends HookMergeClass,
  const TFailurePolicy extends HookFailurePolicy,
  TInputSchema extends Schema.Schema.AnyNoContext,
  TOutputSchema extends Schema.Schema.AnyNoContext,
  TResultSchema extends Schema.Schema.AnyNoContext,
>(
  definition: HookPointDefinition<
    TName,
    TMergeClass,
    TFailurePolicy,
    TInputSchema,
    TOutputSchema,
    TResultSchema
  >,
): HookPointDefinition<
  TName,
  TMergeClass,
  TFailurePolicy,
  TInputSchema,
  TOutputSchema,
  TResultSchema
> => Object.freeze(definition);

const DEFAULT_HOOK_TIMEOUT = "30 seconds";

const builtInHookPoints = {
  context: defineHookPoint({
    conflictPolicy: null,
    failurePolicy: "skip",
    inputSchema: ContextHookInputSchema,
    mergeClass: "Chain",
    name: "context",
    outputSchema: ContextHookOutputSchema,
    resultSchema: ContextHookResultSchema,
    timeout: DEFAULT_HOOK_TIMEOUT,
  }),
  "provider-request": defineHookPoint({
    conflictPolicy: null,
    failurePolicy: "skip",
    inputSchema: ProviderRequestHookInputSchema,
    mergeClass: "Chain",
    name: "provider-request",
    outputSchema: ProviderRequestHookOutputSchema,
    resultSchema: ProviderRequestHookResultSchema,
    timeout: DEFAULT_HOOK_TIMEOUT,
  }),
  "input-transform": defineHookPoint({
    conflictPolicy: null,
    failurePolicy: "skip",
    inputSchema: InputTransformHookInputSchema,
    mergeClass: "Chain",
    name: "input-transform",
    outputSchema: InputTransformHookOutputSchema,
    resultSchema: InputTransformHookResultSchema,
    timeout: DEFAULT_HOOK_TIMEOUT,
  }),
  "input-handling": defineHookPoint({
    conflictPolicy: null,
    // A broken optional input handler must not discard user input.
    failurePolicy: "skip",
    inputSchema: InputHandlingHookInputSchema,
    mergeClass: "FirstWins",
    name: "input-handling",
    outputSchema: InputHandlingHookOutputSchema,
    resultSchema: InputHandlingResultSchema,
    timeout: DEFAULT_HOOK_TIMEOUT,
  }),
  "tool-call-gate": defineHookPoint({
    conflictPolicy: null,
    failurePolicy: "reject",
    inputSchema: ToolCallGateHookInputSchema,
    mergeClass: "FirstWins",
    name: "tool-call-gate",
    outputSchema: ToolCallGateHookOutputSchema,
    resultSchema: ToolCallGateResultSchema,
    timeout: DEFAULT_HOOK_TIMEOUT,
  }),
  "tool-result": defineHookPoint({
    conflictPolicy: "highest-priority-wins",
    failurePolicy: "skip",
    inputSchema: ToolResultHookInputSchema,
    mergeClass: "Accumulate",
    name: "tool-result",
    outputSchema: ToolResultHookOutputSchema,
    resultSchema: ToolResultHookResultSchema,
    timeout: DEFAULT_HOOK_TIMEOUT,
  }),
  "resource-discovery": defineHookPoint({
    conflictPolicy: "highest-priority-wins",
    failurePolicy: "skip",
    inputSchema: ResourceDiscoveryHookInputSchema,
    mergeClass: "Accumulate",
    name: "resource-discovery",
    outputSchema: ResourceDiscoveryHookOutputSchema,
    resultSchema: ResourceDiscoveryHookResultSchema,
    timeout: DEFAULT_HOOK_TIMEOUT,
  }),
  "compaction-gate": defineHookPoint({
    conflictPolicy: null,
    failurePolicy: "reject",
    inputSchema: CompactionGateHookInputSchema,
    mergeClass: "FirstWins",
    name: "compaction-gate",
    outputSchema: CompactionGateHookOutputSchema,
    resultSchema: CompactionGateResultSchema,
    timeout: DEFAULT_HOOK_TIMEOUT,
  }),
  trust: defineHookPoint({
    conflictPolicy: null,
    failurePolicy: "reject",
    inputSchema: TrustHookInputSchema,
    mergeClass: "FirstWins",
    name: "trust",
    outputSchema: TrustHookOutputSchema,
    resultSchema: TrustResultSchema,
    timeout: DEFAULT_HOOK_TIMEOUT,
  }),
  "turn-lifecycle": defineHookPoint({
    conflictPolicy: null,
    failurePolicy: "drop",
    inputSchema: TurnLifecycleHookInputSchema,
    mergeClass: "Tap",
    name: "turn-lifecycle",
    outputSchema: TurnLifecycleHookOutputSchema,
    resultSchema: TurnLifecycleHookResultSchema,
    timeout: DEFAULT_HOOK_TIMEOUT,
  }),
  progress: defineHookPoint({
    conflictPolicy: null,
    failurePolicy: "drop",
    inputSchema: ProgressHookInputSchema,
    mergeClass: "Tap",
    name: "progress",
    outputSchema: ProgressHookOutputSchema,
    resultSchema: ProgressHookResultSchema,
    timeout: DEFAULT_HOOK_TIMEOUT,
  }),
  "session-lifecycle": defineHookPoint({
    conflictPolicy: null,
    failurePolicy: "drop",
    inputSchema: SessionLifecycleHookInputSchema,
    mergeClass: "Tap",
    name: "session-lifecycle",
    outputSchema: SessionLifecycleHookOutputSchema,
    resultSchema: SessionLifecycleHookResultSchema,
    timeout: DEFAULT_HOOK_TIMEOUT,
  }),
} as const;

export const HOOK_POINTS = Object.freeze(builtInHookPoints);

export type HookPointName = keyof typeof HOOK_POINTS;
export const HOOK_POINT_NAMES = Object.freeze(Object.keys(HOOK_POINTS) as Array<HookPointName>);

export type HookPointTypeMap = {
  readonly [TPoint in HookPointName]: {
    readonly failurePolicy: (typeof HOOK_POINTS)[TPoint]["failurePolicy"];
    readonly input: Schema.Schema.Type<(typeof HOOK_POINTS)[TPoint]["inputSchema"]>;
    readonly mergeClass: (typeof HOOK_POINTS)[TPoint]["mergeClass"];
    readonly output: Schema.Schema.Type<(typeof HOOK_POINTS)[TPoint]["outputSchema"]>;
    readonly result: Schema.Schema.Type<(typeof HOOK_POINTS)[TPoint]["resultSchema"]>;
  };
};

export type HookPointInput<TPoint extends HookPointName> = HookPointTypeMap[TPoint]["input"];
export type HookPointOutput<TPoint extends HookPointName> = HookPointTypeMap[TPoint]["output"];
export type HookPointResult<TPoint extends HookPointName> = HookPointTypeMap[TPoint]["result"];
