/**
 * Owns Delegation: create, narrow, bind, prompt, read, and release a child Session in-process.
 * A new Session avoids the parent's occupied Mailbox (RFC-04 section 6 step 2).
 * Not responsible for the Tool declaration (features/delegate.ts), discovery (loader.ts),
 * or filter composition (tools/grants.ts).
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { SessionId } from "@dungle-scrubs/popeye-journal";
import { Context, Data, Effect, Layer, Option, Ref, Schema } from "effect";

import {
  Driver,
  type DriverService,
  type SessionTurnOptions,
  type ThinkingLevel,
  type ToolRegistryService,
} from "../compose.js";
import { type CliModelSource, unknownAgentMessage } from "../entry/config.js";
import { type DelegationPort, makeDelegatePlugin } from "../features/delegate.js";
import type { FirstPartyPlugin } from "../features/first-party-suite.js";
import { composeToolGrantFilter, partitionAgentTools } from "../tools/grants.js";
import type { SessionToolGrantsService } from "../tools/session-grants.js";
import type { AgentDefinition, AgentDiscoveryError, AgentDiscoveryResult } from "./loader.js";

export const MAX_DELEGATION_DEPTH = 3;

export interface DelegationServices {
  readonly driver: DriverService;
  readonly sessionToolGrants: SessionToolGrantsService;
  readonly toolRegistry: ToolRegistryService;
}

export interface DelegationOptions {
  /** Fresh discovery, run at each delegate call (RFC-04 §6 step 1). */
  readonly discover: Effect.Effect<AgentDiscoveryResult, AgentDiscoveryError>;
  /** True when --model was passed: a child keeps the process model (RFC-04 §3). */
  readonly modelSource: CliModelSource;
  /** Base for a relative cwd argument: the process working directory in production. */
  readonly projectPath: string;
  /** Definitions discovered at startup; the Tool description lists them in this order. */
  readonly startupAgents: ReadonlyMap<string, AgentDefinition>;
  /** The head's --effort level, applied to every child Turn. */
  readonly thinkingLevel: ThinkingLevel | undefined;
}

export interface Delegation {
  readonly bind: (services: DelegationServices) => Effect.Effect<void>;
  readonly plugin: FirstPartyPlugin;
}

class DelegationFailure extends Data.TaggedError("DelegationFailure")<{
  readonly content: string;
}> {}

const assistantMessage = Schema.decodeUnknownOption(
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.String,
  }),
);

const message = (cause: unknown): string =>
  typeof cause === "object" &&
  cause !== null &&
  "message" in cause &&
  typeof cause.message === "string"
    ? cause.message
    : String(cause);

export const makeDelegation = (options: DelegationOptions): Effect.Effect<Delegation> =>
  Effect.gen(function* () {
    const bound = yield* Ref.make<Option.Option<DelegationServices>>(Option.none());
    const depths = yield* Ref.make<ReadonlyMap<SessionId, number>>(new Map());
    const port: DelegationPort = {
      delegate: ({ agent, task, cwd }, context) =>
        Effect.gen(function* () {
          const binding = yield* Ref.get(bound);
          if (Option.isNone(binding)) {
            return yield* new DelegationFailure({
              content: "The delegate Tool is not bound to a Driver.",
            });
          }
          const services = binding.value;
          const parentDepth = (yield* Ref.get(depths)).get(context.sessionId) ?? 0;
          if (parentDepth >= MAX_DELEGATION_DEPTH) {
            return yield* new DelegationFailure({
              content: `delegate is not available at delegation depth ${parentDepth}: the limit is ${MAX_DELEGATION_DEPTH}.`,
            });
          }
          const discovery = yield* options.discover.pipe(
            Effect.mapError(
              (error) =>
                new DelegationFailure({
                  content: `Agent definitions could not be loaded: ${error.message}`,
                }),
            ),
          );
          const definition = discovery.agents.get(agent);
          if (definition === undefined) {
            return yield* new DelegationFailure({
              content: unknownAgentMessage(agent, discovery),
            });
          }
          let cwdLine: string | undefined;
          if (cwd !== undefined) {
            const resolved = resolve(options.projectPath, cwd);
            const invalidCwd = () =>
              new DelegationFailure({
                content: `Working directory ${JSON.stringify(cwd)} is not a directory.`,
              });
            const info = yield* Effect.tryPromise({
              try: () => stat(resolved),
              catch: invalidCwd,
            });
            if (!info.isDirectory()) {
              return yield* invalidCwd();
            }
            cwdLine = `Working directory: ${resolved}`;
          }
          const agentTools = definition.tools;
          if (agentTools !== undefined && agentTools.length > 0) {
            const view = yield* services.toolRegistry.view(context.sessionId);
            const { known, unknown } = partitionAgentTools(
              agentTools,
              new Set(view.list().map((tool) => tool.name)),
            );
            if (known.length === 0) {
              return yield* new DelegationFailure({
                content: `Agent ${definition.name} (${definition.filePath}) lists only tools this session does not grant: ${unknown.join(", ")}. Delegation fails closed.`,
              });
            }
            if (unknown.length > 0) {
              yield* Effect.logWarning(
                `Agent ${definition.name} (${definition.filePath}) names tools this session does not grant: ${unknown.join(", ")}. The delegated session runs with the granted subset: ${known.join(", ")}.`,
              );
            }
          }
          const child = yield* Effect.acquireRelease(
            services.driver.createSession().pipe(
              Effect.mapError(
                (cause) =>
                  new DelegationFailure({
                    content: `Could not create the delegated session: ${message(cause)}`,
                  }),
              ),
            ),
            (child) =>
              services.driver.closeSession(child.id).pipe(
                Effect.catchAllCause((cause) =>
                  Effect.logWarning("Delegated session close failed", cause),
                ),
                Effect.zipRight(services.sessionToolGrants.release(child.id)),
                Effect.zipRight(services.driver.releaseSessionTurnOptions(child.id)),
                Effect.ensuring(
                  Ref.update(depths, (current) => {
                    const next = new Map(current);
                    next.delete(child.id);
                    return next;
                  }),
                ),
              ),
          );
          const childDepth = parentDepth + 1;
          yield* Ref.update(depths, (current) => new Map(current).set(child.id, childDepth));
          for (const filter of yield* services.sessionToolGrants.filtersFor(context.sessionId)) {
            yield* services.sessionToolGrants.narrow(child.id, filter);
          }
          const agentFilter = composeToolGrantFilter({
            access: undefined,
            agentTools,
            excludeTools: [],
            isolation: undefined,
            tools: [],
          });
          if (agentFilter !== undefined) {
            yield* services.sessionToolGrants.narrow(child.id, agentFilter);
          }
          if (childDepth >= MAX_DELEGATION_DEPTH) {
            const depthFilter = composeToolGrantFilter({
              access: undefined,
              agentTools: undefined,
              excludeTools: ["delegate"],
              isolation: undefined,
              tools: [],
            });
            if (depthFilter !== undefined) {
              yield* services.sessionToolGrants.narrow(child.id, depthFilter);
            }
          }
          const appendSystemPrompt = [definition.body, cwdLine]
            .filter((part): part is string => part !== undefined && part.length > 0)
            .join("\n\n");
          const childOptions: SessionTurnOptions = {
            ...(appendSystemPrompt === "" ? {} : { appendSystemPrompt }),
            ...(options.modelSource === "flag" || !definition.model
              ? {}
              : { model: definition.model }),
            ...(options.thinkingLevel === undefined
              ? {}
              : { thinkingLevel: options.thinkingLevel }),
          };
          yield* services.driver.bindSessionTurnOptions(child.id, childOptions);
          const turn = yield* services.driver.prompt(child.id, `Task: ${task}`).pipe(
            Effect.mapError(
              (cause) =>
                new DelegationFailure({
                  content: `Delegated session ${child.id} failed: ${message(cause)}`,
                }),
            ),
          );
          const snapshot = yield* services.driver.getSnapshot(child.id).pipe(
            Effect.mapError(
              (cause) =>
                new DelegationFailure({
                  content: `Could not read the delegated session ${child.id}: ${message(cause)}`,
                }),
            ),
          );
          const final = snapshot.entries
            .filter((entry) => entry.kind === "message")
            .map((entry) => assistantMessage(entry.payload))
            .findLast(Option.isSome);
          const content = final !== undefined && Option.isSome(final) ? final.value.content : "";
          switch (turn.stopReason) {
            case "done":
            case "truncated":
              return { content };
            case "toolCalls":
            case "error":
              return yield* new DelegationFailure({
                content: `Agent ${definition.name} ended with an error: ${content}`,
              });
            case "aborted":
              return yield* new DelegationFailure({
                content: `Agent ${definition.name} was aborted before it finished.`,
              });
          }
        }).pipe(
          Effect.catchTag("DelegationFailure", (failure) =>
            Effect.succeed({ content: failure.content, isError: true }),
          ),
        ),
    };
    return {
      bind: (services) => Ref.set(bound, Option.some(services)),
      plugin: makeDelegatePlugin(port, [...options.startupAgents.values()]),
    };
  });

/** The Driver layer, binding the Delegation to the Driver it builds. */
export const withDelegation = <E, R>(
  driver: Layer.Layer<Driver, E, R>,
  delegation: Delegation,
  services: Omit<DelegationServices, "driver">,
): Layer.Layer<Driver, E, R> =>
  driver.pipe(
    Layer.tap((context) => delegation.bind({ ...services, driver: Context.get(context, Driver) })),
  );
