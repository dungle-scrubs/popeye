/**
 * Owns resolving an Agent definition for one Session at creation time (RFC-04 §4).
 * It exists so the rpc create and resume agent field applies the same resolution, message
 * contract, model precedence, persona, and Tool filter composition as --agent, per Session.
 * Not responsible for binding the result to a Session (the rpc session bridge does that)
 * or for applying filters (the registry in plugins/runtime.ts).
 */

import { Data, Effect } from "effect";

import { type CliModelSource, unknownAgentMessage } from "../entry/config.js";
import {
  composeToolGrantFilter,
  partitionAgentTools,
  type ToolGrantFilter,
} from "../tools/grants.js";
import type {
  AgentDiscoveryError,
  AgentDiscoveryErrorReason,
  AgentDiscoveryResult,
} from "./loader.js";

/** The turn options every prompt of an Agent Session carries (RFC-04 §2, §3). */
export interface AgentTurnOptions {
  readonly appendSystemPrompt?: string;
  readonly model?: string;
}

export interface AgentSessionPlan {
  readonly filePath: string;
  /** Listed names the process grant has; empty when the definition has no tools list. */
  readonly grantedTools: ReadonlyArray<string>;
  readonly name: string;
  /** The Session's own filter: the Agent list only. Undefined: no tools list, no narrow. */
  readonly toolFilter: ToolGrantFilter | undefined;
  readonly turnOptions: AgentTurnOptions;
  /** Listed names the process grant lacks; non-empty only when some names are granted. */
  readonly ungrantedTools: ReadonlyArray<string>;
}

export type AgentSessionErrorReason =
  | AgentDiscoveryErrorReason
  | "agent_binding_lost"
  | "agent_model_unresolvable"
  | "agent_session_bound"
  | "agent_tools_unknown"
  | "agents_unavailable"
  | "unknown_agent";

export class AgentSessionError extends Data.TaggedError("AgentSessionError")<{
  readonly agent: string;
  /** Discovered names, in the message's order; set for unknown_agent. */
  readonly available?: ReadonlyArray<string>;
  readonly cause?: unknown;
  readonly message: string;
  readonly reason: AgentSessionErrorReason;
  /** Set for agent_tools_unknown. */
  readonly ungrantedTools?: ReadonlyArray<string>;
}> {}

export interface AgentSessionResolver {
  readonly resolve: (name: string) => Effect.Effect<AgentSessionPlan, AgentSessionError>;
}

export interface AgentSessionResolverOptions {
  /** Runs on every resolve, so an edited definition applies to the next create. */
  readonly discover: Effect.Effect<AgentDiscoveryResult, AgentDiscoveryError>;
  /** The process-level Tool view's names, read on every resolve that has a tools list. */
  readonly grantedToolNames: Effect.Effect<ReadonlySet<string>>;
  readonly modelSource: CliModelSource;
  readonly unresolvedModelMessage: (modelId: string) => string | undefined;
}

export const makeAgentSessionResolver = (
  options: AgentSessionResolverOptions,
): AgentSessionResolver => ({
  resolve: (name) =>
    Effect.gen(function* () {
      const discovery = yield* options.discover.pipe(
        Effect.mapError(
          (cause) =>
            new AgentSessionError({
              agent: name,
              ...(cause.cause === undefined ? {} : { cause: cause.cause }),
              message: cause.message,
              reason: cause.reason,
            }),
        ),
      );
      yield* Effect.forEach(
        discovery.diagnostics,
        (diagnostic) =>
          Effect.logWarning(
            `Agent definition ${diagnostic.filePath} skipped: ${diagnostic.detail}.`,
          ).pipe(
            Effect.annotateLogs({
              diagnostic: "agent_definition_skipped",
              filePath: diagnostic.filePath,
            }),
          ),
        { discard: true },
      );
      const definition = discovery.agents.get(name);
      if (definition === undefined) {
        return yield* new AgentSessionError({
          agent: name,
          available: [...discovery.agents.values()].map((candidate) => candidate.name),
          message: unknownAgentMessage(name, discovery),
          reason: "unknown_agent",
        });
      }
      let grantedTools: ReadonlyArray<string> = [];
      let ungrantedTools: ReadonlyArray<string> = [];
      if (definition.tools !== undefined && definition.tools.length > 0) {
        const { known, unknown } = partitionAgentTools(
          definition.tools,
          yield* options.grantedToolNames,
        );
        if (known.length === 0) {
          return yield* new AgentSessionError({
            agent: name,
            message: `Agent ${definition.name} (${definition.filePath}) lists only tools this session does not grant: ${unknown.join(", ")}. The Session fails closed.`,
            reason: "agent_tools_unknown",
            ungrantedTools: unknown,
          });
        }
        grantedTools = known;
        ungrantedTools = unknown;
      }
      // RFC-04 §3 precedence per Session: --model > agent model > POPEYE_MODEL.
      const model =
        options.modelSource === "flag" ||
        definition.model === undefined ||
        definition.model.length === 0
          ? undefined
          : definition.model;
      if (model !== undefined) {
        const message = options.unresolvedModelMessage(model);
        if (message !== undefined) {
          return yield* new AgentSessionError({
            agent: name,
            message: `Agent ${definition.name} (${definition.filePath}): ${message} The Session fails closed.`,
            reason: "agent_model_unresolvable",
          });
        }
      }
      return {
        filePath: definition.filePath,
        grantedTools,
        name: definition.name,
        toolFilter: composeToolGrantFilter({
          access: undefined,
          agentTools: definition.tools,
          excludeTools: [],
          isolation: undefined,
          tools: [],
        }),
        turnOptions: {
          ...(definition.body.length === 0 ? {} : { appendSystemPrompt: definition.body }),
          ...(model === undefined ? {} : { model }),
        },
        ungrantedTools,
      } satisfies AgentSessionPlan;
    }),
});
