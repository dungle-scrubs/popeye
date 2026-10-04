/**
 * Owns the delegate Tool declaration and its port.
 * Not responsible for running the child (agents/delegation.ts).
 */
import {
  defineToolContribution,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from "@dungle-scrubs/popeye-plugins";
import { type Effect, Schema, type Scope } from "effect";

import type { FirstPartyPlugin } from "./first-party-suite.js";

export const DELEGATION_PLUGIN_NAME = "delegation";
export const DELEGATE_TOOL_NAME = "delegate";

export const DelegateParametersSchema = Schema.Struct({
  agent: Schema.String.annotations({ description: "Exact name of the Agent definition to run." }),
  cwd: Schema.optional(
    Schema.String.annotations({
      description:
        "Optional working-directory hint for the agent, resolved against the process working directory.",
    }),
  ),
  task: Schema.String.annotations({
    description: "The full task. The agent sees only this text, not this conversation.",
  }),
});
export type DelegateArguments = typeof DelegateParametersSchema.Type;

export interface DelegationPort {
  readonly delegate: (
    arguments_: DelegateArguments,
    context: ToolExecutionContext,
  ) => Effect.Effect<ToolExecutionResult, never, Scope.Scope>;
}

export interface DelegateAgentSummary {
  readonly description: string;
  readonly name: string;
}

export const delegateToolDescription = (agents: ReadonlyArray<DelegateAgentSummary>): string =>
  [
    "Delegate one task to a named Agent definition. The agent runs in a new child Session with its own persona, model preference, and Tools, sees only the task text (not this conversation), and its final message is returned as this Tool's result. Put several delegate calls in one response to run them in parallel. cwd is an optional working-directory hint for the agent.",
    "Available agents:",
    ...agents.map((agent) => `- ${agent.name}: ${agent.description}`),
  ].join("\n");

export const makeDelegatePlugin = (
  port: DelegationPort,
  agents: ReadonlyArray<DelegateAgentSummary>,
): FirstPartyPlugin => ({
  contributions: [
    defineToolContribution({
      description: delegateToolDescription(agents),
      execute: (arguments_, context) => port.delegate(arguments_, context),
      name: DELEGATE_TOOL_NAME,
      parameters: DelegateParametersSchema,
      replay: "never",
    }),
  ],
  manifest: {
    capabilities: [],
    description: "Hands a task to a child Agent session and returns its final message.",
    name: DELEGATION_PLUGIN_NAME,
    version: "1.0.0",
  },
});
