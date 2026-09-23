/**
 * Owns generic Hook execution for every declared point.
 * It exists because one emitter must execute all Hook points from declared semantics; bespoke
 * per-point emitters must not exist.
 */
import type { Cause as CauseType, Fiber as FiberType, Scope, Tracer } from "effect";
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
} from "effect";

import type { CapabilityGrants } from "./capability.js";
import type { RegisteredContribution } from "./contribution.js";
import { type ContributionRegistryError, GateRejected, HookInputInvalid } from "./errors.js";
import type {
  HookMergeClass,
  HookPayload,
  HookPointDefinition,
  HookPointInput,
  HookPointName,
  HookPointResult,
  HookPointTypeMap,
} from "./hook-points.js";
import { CurrentGrantsFiberRef, CurrentPluginFiberRef } from "./interactions.js";
import { ContributionRegistry, HookContributionKind } from "./registry.js";
import type { PluginSourceScope } from "./sources.js";

type RegisteredHook = RegisteredContribution<
  "hook",
  {
    readonly mergeClass: HookMergeClass;
    readonly name: string;
    readonly point: string;
    readonly run: (input: unknown) => Effect.Effect<unknown, unknown>;
  }
>;

export const DEFAULT_HOOK_TIMEOUT_MILLIS = 30_000;
/** @deprecated Use DEFAULT_HOOK_TIMEOUT_MILLIS. */
export const DEFAULT_GATE_TIMEOUT_MILLIS = DEFAULT_HOOK_TIMEOUT_MILLIS;
export const DEFAULT_TAP_QUEUE_CAPACITY = 64;
const MAX_FAILURE_RENDER_LENGTH = 1_024;

export type HookErrorPayload = Readonly<Record<string, unknown>> | null;

interface HookFailureDiagnosticFields {
  readonly cause: string;
  readonly errorPayload: HookErrorPayload;
  readonly errorTag: string | null;
  readonly reason: string;
  readonly timedOut: boolean;
}

export interface HookContributionSkippedDiagnostic extends HookFailureDiagnosticFields {
  readonly mergeClass: "Accumulate" | "Chain" | "FirstWins";
  readonly plugin: string;
  readonly point: HookPointName;
  readonly type: "hook_contribution_skipped";
}

export interface HookTapFailedDiagnostic extends HookFailureDiagnosticFields {
  readonly plugin: string;
  readonly point: HookPointName;
  readonly type: "hook_tap_failed";
}

export interface HookTapDroppedDiagnostic {
  readonly droppedCount: number;
  readonly plugin: string;
  readonly point: HookPointName;
  readonly type: "hook_tap_dropped";
}

export interface HookGateRejectedDiagnostic extends HookFailureDiagnosticFields {
  readonly plugin: string;
  readonly point: HookPointName;
  readonly type: "hook_gate_rejected";
}

export interface HookFieldConflictDiagnostic {
  readonly field: string;
  readonly point: HookPointName;
  readonly selectedPlugin: string;
  readonly skippedPlugin: string;
  readonly type: "hook_field_conflict";
}

export interface HookPriorityTieDiagnostic {
  readonly orderedPlugins: readonly [string, string];
  readonly point: HookPointName;
  readonly priority: number;
  readonly type: "hook_priority_tie";
}

export type HookDiagnostic =
  | HookContributionSkippedDiagnostic
  | HookFieldConflictDiagnostic
  | HookGateRejectedDiagnostic
  | HookPriorityTieDiagnostic
  | HookTapDroppedDiagnostic
  | HookTapFailedDiagnostic;

export interface HookEmitterOptions {
  /** Test seam for forcing the consumer/eviction interleaving. */
  readonly beforeTapEviction?: Effect.Effect<void>;
  readonly diagnosticSink?: (diagnostic: HookDiagnostic) => Effect.Effect<void>;
  readonly tapQueueCapacity?: number;
}

const compareCodepoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareHookPriority = (left: RegisteredHook, right: RegisteredHook): number =>
  right.priority - left.priority || compareCodepoints(left.key, right.key);

const hooksAtPoint = (
  contributions: ReadonlyArray<RegisteredHook>,
  definition: HookPointDefinition,
): ReadonlyArray<RegisteredHook> =>
  contributions
    .filter(
      (contribution) =>
        contribution.payload.point === definition.name &&
        contribution.payload.mergeClass === definition.mergeClass,
    )
    .sort(compareHookPriority);

const pluginName = (contribution: RegisteredHook): string =>
  contribution.key.slice(0, contribution.key.indexOf("/"));

const bounded = (value: string): string =>
  value.length <= MAX_FAILURE_RENDER_LENGTH
    ? value
    : `${value.slice(0, MAX_FAILURE_RENDER_LENGTH - 1)}…`;

const jsonValue = (value: unknown): unknown => {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return bounded(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(jsonValue);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "_tag" && key !== "stack")
        .slice(0, 20)
        .map(([key, item]) => [key, jsonValue(item)]),
    );
  }
  return String(value);
};

const boundedJson = (value: unknown): string => {
  try {
    return bounded(JSON.stringify(jsonValue(value)));
  } catch {
    return bounded(String(value));
  }
};

interface FailureDetails {
  readonly cause: string;
  readonly errorPayload: HookErrorPayload;
  readonly errorTag: string | null;
  readonly reason: string;
  readonly timedOut: boolean;
}

const failureDetails = (cause: CauseType.Cause<unknown>): FailureDetails => {
  const failure = Cause.failures(cause).pipe(
    (failures) => failures[Symbol.iterator]().next().value,
  );
  const tagged =
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string"
      ? failure
      : null;
  const errorPayload = tagged === null ? null : (jsonValue(tagged) as HookErrorPayload);
  const reason =
    tagged !== null
      ? bounded(`${tagged._tag}: ${boundedJson(errorPayload)}`)
      : failure instanceof Error
        ? bounded(`${failure.name}: ${failure.message}`)
        : failure !== undefined
          ? bounded(String(failure))
          : bounded(Cause.pretty(cause));
  return {
    cause: bounded(Cause.pretty(cause)),
    errorPayload,
    errorTag: tagged?._tag ?? null,
    reason,
    timedOut: false,
  };
};

const timeoutDetails = (definition: HookPointDefinition): FailureDetails => {
  const timeoutMillis = Duration.toMillis(Duration.decode(definition.timeout));
  const reason = `Hook timed out after ${timeoutMillis} ms.`;
  return {
    cause: reason,
    errorPayload: null,
    errorTag: null,
    reason,
    timedOut: true,
  };
};

const gateRejected = (
  contribution: RegisteredHook,
  details: FailureDetails,
  point: HookPointName,
  rejection: GateRejected["rejection"],
): GateRejected =>
  new GateRejected({
    cause: details.cause,
    plugin: pluginName(contribution),
    point,
    rejection,
    reason: details.reason,
    timedOut: details.timedOut,
  });

const skippedDiagnostic = (
  contribution: RegisteredHook,
  details: FailureDetails,
  mergeClass: HookContributionSkippedDiagnostic["mergeClass"],
  point: HookPointName,
): HookContributionSkippedDiagnostic => ({
  ...details,
  mergeClass,
  plugin: pluginName(contribution),
  point,
  type: "hook_contribution_skipped",
});

const tapFailedDiagnostic = (
  contribution: RegisteredHook,
  details: FailureDetails,
  point: HookPointName,
): HookTapFailedDiagnostic => ({
  ...details,
  plugin: pluginName(contribution),
  point,
  type: "hook_tap_failed",
});

interface HookTraceState {
  contributionCount: number;
  readonly rejectedPlugins: Array<string>;
  readonly skippedPlugins: Array<string>;
}

const makeHookTraceState = (): HookTraceState => ({
  contributionCount: 0,
  rejectedPlugins: [],
  skippedPlugins: [],
});

const exitOutcome = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isSuccess(exit) ? "success" : Cause.isInterrupted(exit.cause) ? "interrupted" : "failure";

const traceHook = <TValue, TError, TRequirements>(
  effect: Effect.Effect<TValue, TError, TRequirements>,
  point: HookPointName,
  traceState: HookTraceState,
): Effect.Effect<TValue, TError, TRequirements> =>
  effect.pipe(
    Effect.onExit((exit) =>
      Effect.annotateCurrentSpan({
        contributionCount: traceState.contributionCount,
        outcome:
          traceState.rejectedPlugins.length > 0
            ? "rejected"
            : Exit.isFailure(exit) && Cause.isInterrupted(exit.cause)
              ? "interrupted"
              : Exit.isSuccess(exit)
                ? "success"
                : "error",
        rejectedPlugins: [...traceState.rejectedPlugins],
        skippedPlugins: [...traceState.skippedPlugins],
      }),
    ),
    Effect.withSpan("plugins.hook", { attributes: { point } }),
  );

const traceContribution = <TValue, TError, TRequirements>(
  contribution: RegisteredHook,
  effect: Effect.Effect<TValue, TError, TRequirements>,
  point: HookPointName,
): Effect.Effect<TValue, TError, TRequirements> =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((startedAt) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((finishedAt) =>
              Effect.annotateCurrentSpan({
                durationMillis: finishedAt - startedAt,
                outcome: exitOutcome(exit),
              }),
            ),
          ),
        ),
        Effect.withSpan("plugins.hook.contribution", {
          attributes: { plugin: pluginName(contribution), point },
        }),
      ),
    ),
  );

type HookRunResult =
  | { readonly details: FailureDetails; readonly status: "failure" }
  | { readonly status: "success"; readonly value: unknown };

const runContribution = (
  contribution: RegisteredHook,
  definition: HookPointDefinition,
  input: unknown,
  point: HookPointName,
): Effect.Effect<HookRunResult> =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      traceContribution(
        contribution,
        contribution.payload
          .run(input)
          .pipe(Effect.flatMap(Schema.decodeUnknown(definition.outputSchema))),
        point,
      )
        .pipe(Effect.timeoutOption(definition.timeout))
        .pipe(Effect.locally(CurrentPluginFiberRef, Option.some(pluginName(contribution)))),
    );
    if (Exit.isFailure(exit)) {
      if (Cause.isInterrupted(exit.cause)) {
        return yield* Effect.failCause(exit.cause as CauseType.Cause<never>);
      }
      return { details: failureDetails(exit.cause), status: "failure" };
    }
    return Option.isNone(exit.value)
      ? { details: timeoutDetails(definition), status: "failure" }
      : { status: "success", value: exit.value.value };
  });

const emitPriorityTieDiagnostics = (
  contributions: ReadonlyArray<RegisteredHook>,
  diagnosticSink: (diagnostic: HookDiagnostic) => Effect.Effect<void>,
  point: HookPointName,
): Effect.Effect<void> =>
  Effect.forEach(
    contributions.slice(1),
    (contribution, index) => {
      const previous = contributions[index];
      if (
        previous === undefined ||
        previous.priority !== contribution.priority ||
        pluginName(previous) === pluginName(contribution)
      ) {
        return Effect.void;
      }
      return diagnosticSink({
        orderedPlugins: [pluginName(previous), pluginName(contribution)],
        point,
        priority: contribution.priority,
        type: "hook_priority_tie",
      });
    },
    { discard: true },
  );

const emitFailureDiagnostic = (
  contribution: RegisteredHook,
  details: FailureDetails,
  diagnosticSink: (diagnostic: HookDiagnostic) => Effect.Effect<void>,
  mergeClass: HookContributionSkippedDiagnostic["mergeClass"],
  point: HookPointName,
  traceState: HookTraceState,
): Effect.Effect<void> => {
  traceState.skippedPlugins.push(pluginName(contribution));
  return diagnosticSink(skippedDiagnostic(contribution, details, mergeClass, point));
};

const runFirstWins = (
  contributions: ReadonlyArray<RegisteredHook>,
  definition: HookPointDefinition,
  diagnosticSink: (diagnostic: HookDiagnostic) => Effect.Effect<void>,
  input: unknown,
  point: HookPointName,
  traceState: HookTraceState,
): Effect.Effect<unknown | undefined, GateRejected> =>
  Effect.gen(function* () {
    for (const contribution of contributions) {
      const result = yield* runContribution(contribution, definition, input, point);
      if (result.status === "failure") {
        if (definition.failurePolicy === "reject") {
          const error = gateRejected(contribution, result.details, point, "failure");
          traceState.rejectedPlugins.push(pluginName(contribution));
          yield* diagnosticSink({
            ...result.details,
            plugin: error.plugin,
            point,
            type: "hook_gate_rejected",
          });
          return yield* error;
        }
        yield* emitFailureDiagnostic(
          contribution,
          result.details,
          diagnosticSink,
          "FirstWins",
          point,
          traceState,
        );
        continue;
      }
      const decision = result.value as Readonly<Record<string, unknown>>;
      if (decision.action === "compact") {
        continue;
      }
      if (decision.action === "skip") {
        const reason = String(decision.reason);
        const details: FailureDetails = {
          cause: `skip(${reason})`,
          errorPayload: null,
          errorTag: null,
          reason,
          timedOut: false,
        };
        const error = gateRejected(contribution, details, point, "block");
        traceState.rejectedPlugins.push(pluginName(contribution));
        yield* diagnosticSink({
          ...details,
          plugin: error.plugin,
          point,
          type: "hook_gate_rejected",
        });
        return yield* error;
      }
      if (decision.decision === "continue") {
        continue;
      }
      if (decision.decision === "block") {
        const reason = String(decision.reason);
        const details: FailureDetails = {
          cause: `block(${reason})`,
          errorPayload: null,
          errorTag: null,
          reason,
          timedOut: false,
        };
        const error = gateRejected(contribution, details, point, "block");
        traceState.rejectedPlugins.push(pluginName(contribution));
        yield* diagnosticSink({
          ...details,
          plugin: error.plugin,
          point,
          type: "hook_gate_rejected",
        });
        return yield* error;
      }
      if (decision.decision === "replace" || decision.decision === "handled") {
        return decision.value;
      }
    }
    return undefined;
  });

const runChain = (
  contributions: ReadonlyArray<RegisteredHook>,
  definition: HookPointDefinition,
  diagnosticSink: (diagnostic: HookDiagnostic) => Effect.Effect<void>,
  input: HookPayload,
  point: HookPointName,
  traceState: HookTraceState,
): Effect.Effect<HookPayload> =>
  Effect.reduce(contributions, input, (current, contribution) =>
    runContribution(contribution, definition, current, point).pipe(
      Effect.flatMap((result) => {
        if (result.status === "success") {
          return Effect.succeed(result.value as HookPayload);
        }
        return emitFailureDiagnostic(
          contribution,
          result.details,
          diagnosticSink,
          "Chain",
          point,
          traceState,
        ).pipe(Effect.as(current));
      }),
    ),
  );

interface AccumulateState {
  readonly output: HookPayload;
  readonly owners: ReadonlyMap<string, string>;
}

const runAccumulate = (
  contributions: ReadonlyArray<RegisteredHook>,
  definition: HookPointDefinition,
  diagnosticSink: (diagnostic: HookDiagnostic) => Effect.Effect<void>,
  input: HookPayload,
  point: HookPointName,
  traceState: HookTraceState,
): Effect.Effect<HookPayload> =>
  Effect.reduce(
    contributions,
    { output: input, owners: new Map<string, string>() } satisfies AccumulateState,
    (state, contribution) =>
      runContribution(contribution, definition, input, point).pipe(
        Effect.flatMap((result) => {
          if (result.status === "failure") {
            return emitFailureDiagnostic(
              contribution,
              result.details,
              diagnosticSink,
              "Accumulate",
              point,
              traceState,
            ).pipe(Effect.as(state));
          }
          const output = { ...state.output };
          const owners = new Map(state.owners);
          return Effect.forEach(
            Object.entries(result.value as HookPayload),
            ([field, value]) => {
              const selectedPlugin = owners.get(field);
              if (selectedPlugin !== undefined) {
                return diagnosticSink({
                  field,
                  point,
                  selectedPlugin,
                  skippedPlugin: pluginName(contribution),
                  type: "hook_field_conflict",
                });
              }
              output[field] = value;
              owners.set(field, pluginName(contribution));
              return Effect.void;
            },
            { discard: true },
          ).pipe(Effect.as({ output, owners }));
        }),
      ),
  ).pipe(Effect.map((state) => state.output));

interface TapWork {
  readonly grants: CapabilityGrants;
  readonly input: HookPayload;
  readonly parentSpan: Tracer.Span;
  readonly pluginName: string;
}

interface TapWorker {
  readonly droppedCount: Ref.Ref<number>;
  readonly fiber: FiberType.RuntimeFiber<void, never>;
  readonly offerMutex: Effect.Semaphore;
  readonly queue: Queue.Queue<TapWork>;
  readonly registrationRevision: number;
}

const runTap = (
  contribution: RegisteredHook,
  definition: HookPointDefinition,
  diagnosticSink: (diagnostic: HookDiagnostic) => Effect.Effect<void>,
  input: HookPayload,
  point: HookPointName,
): Effect.Effect<void> =>
  runContribution(contribution, definition, input, point).pipe(
    Effect.flatMap((result) => {
      if (result.status === "success") {
        return Effect.void;
      }
      const diagnostic = tapFailedDiagnostic(contribution, result.details, point);
      return diagnosticSink(diagnostic).pipe(
        Effect.zipRight(Effect.logWarning(JSON.stringify(diagnostic))),
      );
    }),
  );

const makeTapWorker = (
  contribution: RegisteredHook,
  definition: HookPointDefinition,
  capacity: number,
  diagnosticSink: (diagnostic: HookDiagnostic) => Effect.Effect<void>,
  point: HookPointName,
  scope: Scope.Scope,
): Effect.Effect<TapWorker> =>
  Effect.gen(function* () {
    const droppedCount = yield* Ref.make(0);
    const offerMutex = yield* Effect.makeSemaphore(1);
    const queue = yield* Queue.bounded<TapWork>(capacity);
    const iteration = Queue.take(queue).pipe(
      Effect.flatMap((work) =>
        runTap(contribution, definition, diagnosticSink, work.input, point)
          .pipe(
            Effect.locally(CurrentPluginFiberRef, Option.some(work.pluginName)),
            Effect.locally(CurrentGrantsFiberRef, Option.some(work.grants)),
          )
          .pipe(Effect.withParentSpan(work.parentSpan)),
      ),
      Effect.catchAllCause((cause) =>
        Cause.isInterrupted(cause)
          ? Effect.failCause(cause as CauseType.Cause<never>)
          : Effect.logWarning(`Tap worker recovered from defect: ${bounded(Cause.pretty(cause))}`),
      ),
      Effect.asVoid,
    );
    const fiber = yield* Effect.forkIn(Effect.forever(iteration), scope);
    return {
      droppedCount,
      fiber,
      offerMutex,
      queue,
      registrationRevision: contribution.registrationRevision,
    };
  });

const closeTapWorker = (worker: TapWorker): Effect.Effect<void> =>
  Queue.shutdown(worker.queue).pipe(Effect.zipRight(Fiber.interrupt(worker.fiber)), Effect.asVoid);

const offerTap = (
  beforeTapEviction: Effect.Effect<void>,
  contribution: RegisteredHook,
  diagnosticSink: (diagnostic: HookDiagnostic) => Effect.Effect<void>,
  grants: CapabilityGrants,
  input: HookPayload,
  parentSpan: Tracer.Span,
  point: HookPointName,
  worker: TapWorker,
): Effect.Effect<void> =>
  worker.offerMutex.withPermits(1)(
    Effect.gen(function* () {
      if (yield* Queue.isFull(worker.queue)) {
        yield* beforeTapEviction;
        const evicted = yield* Queue.poll(worker.queue);
        if (Option.isSome(evicted)) {
          const droppedCount = yield* Ref.updateAndGet(worker.droppedCount, (count) => count + 1);
          yield* diagnosticSink({
            droppedCount,
            plugin: pluginName(contribution),
            point,
            type: "hook_tap_dropped",
          });
        }
      }
      yield* Queue.offer(worker.queue, {
        grants,
        input,
        parentSpan,
        pluginName: pluginName(contribution),
      });
    }),
  );

export type HookEmitError<TPoint extends HookPointName> =
  | ContributionRegistryError
  | HookInputInvalid
  | (HookPointTypeMap[TPoint]["failurePolicy"] extends "reject" ? GateRejected : never);

export interface HookEmitterService {
  readonly activeTapWorkerCount: Effect.Effect<number>;
  readonly emit: <TPoint extends HookPointName>(
    point: TPoint,
    input: HookPointInput<TPoint>,
    grants: CapabilityGrants,
    options?: { readonly pluginScope?: PluginSourceScope },
  ) => Effect.Effect<HookPointResult<TPoint>, HookEmitError<TPoint>>;
  readonly registerHookPoint: (
    definition: HookPointDefinition,
  ) => Effect.Effect<void, ContributionRegistryError>;
}

export class HookEmitter extends Context.Tag("@popeye/plugins/HookEmitter")<
  HookEmitter,
  HookEmitterService
>() {}

const makeHookEmitter = (options: HookEmitterOptions) =>
  Effect.gen(function* () {
    const registry = yield* ContributionRegistry;
    const diagnosticSink = options.diagnosticSink ?? (() => Effect.void);
    const beforeTapEviction = options.beforeTapEviction ?? Effect.void;
    const tapQueueCapacity = options.tapQueueCapacity ?? DEFAULT_TAP_QUEUE_CAPACITY;
    const scope = yield* Effect.scope;
    const tapWorkerMutex = yield* Effect.makeSemaphore(1);
    const tapWorkers = new Map<string, TapWorker>();

    const sweepTapWorkers = (contributions: ReadonlyArray<RegisteredHook>): Effect.Effect<void> =>
      tapWorkerMutex.withPermits(1)(
        Effect.gen(function* () {
          const active = new Map<string, number>(
            contributions
              .filter((contribution) => contribution.payload.mergeClass === "Tap")
              .map((contribution) => [contribution.key, contribution.registrationRevision]),
          );
          for (const [key, worker] of tapWorkers) {
            if (active.get(key) !== worker.registrationRevision) {
              yield* closeTapWorker(worker);
              tapWorkers.delete(key);
            }
          }
        }),
      );

    const tapWorker = (
      contribution: RegisteredHook,
      definition: HookPointDefinition,
      point: HookPointName,
    ): Effect.Effect<TapWorker> =>
      tapWorkerMutex.withPermits(1)(
        Effect.gen(function* () {
          const existing = tapWorkers.get(contribution.key);
          if (existing?.registrationRevision === contribution.registrationRevision) {
            return existing;
          }
          if (existing !== undefined) {
            yield* closeTapWorker(existing);
          }
          const worker = yield* makeTapWorker(
            contribution,
            definition,
            tapQueueCapacity,
            diagnosticSink,
            point,
            scope,
          );
          tapWorkers.set(contribution.key, worker);
          return worker;
        }),
      );

    const emitImplementation = <TPoint extends HookPointName>(
      point: TPoint,
      input: HookPointInput<TPoint>,
      grants: CapabilityGrants,
      emitOptions?: { readonly pluginScope?: PluginSourceScope },
    ) => {
      const traceState = makeHookTraceState();
      return traceHook(
        Effect.gen(function* () {
          const definition = yield* registry.getHookPoint(point);
          const allContributions = yield* registry.listAll(HookContributionKind);
          yield* sweepTapWorkers(allContributions);
          const contributions = hooksAtPoint(
            yield* registry.list(HookContributionKind, grants, emitOptions),
            definition,
          );
          traceState.contributionCount = contributions.length;
          yield* emitPriorityTieDiagnostics(contributions, diagnosticSink, point);
          const decodedInput = yield* Schema.decodeUnknown(definition.inputSchema)(input).pipe(
            Effect.mapError((schemaCause) => {
              const cause = bounded(String(schemaCause));
              return new HookInputInvalid({
                cause,
                point,
                reason: `Invalid input for Hook point ${point}: ${cause}`,
                schemaCause,
              });
            }),
          );
          const runWithGrants = <T>(
            effect: Effect.Effect<T, unknown, unknown>,
          ): Effect.Effect<T, unknown, unknown> =>
            effect.pipe(Effect.locally(CurrentGrantsFiberRef, Option.some(grants)));
          if (definition.mergeClass === "FirstWins") {
            return (yield* runWithGrants(
              runFirstWins(
                contributions,
                definition,
                diagnosticSink,
                decodedInput,
                point,
                traceState,
              ),
            )) as HookPointResult<typeof point>;
          }
          if (definition.mergeClass === "Chain") {
            return (yield* runWithGrants(
              runChain(
                contributions,
                definition,
                diagnosticSink,
                decodedInput as HookPayload,
                point,
                traceState,
              ),
            )) as HookPointResult<typeof point>;
          }
          if (definition.mergeClass === "Accumulate") {
            return (yield* runWithGrants(
              runAccumulate(
                contributions,
                definition,
                diagnosticSink,
                decodedInput as HookPayload,
                point,
                traceState,
              ),
            )) as HookPointResult<typeof point>;
          }
          const parentSpan = yield* Effect.currentSpan.pipe(Effect.orDie);
          yield* runWithGrants(
            Effect.forEach(
              contributions,
              (contribution) =>
                tapWorker(contribution, definition, point).pipe(
                  Effect.flatMap((worker) =>
                    offerTap(
                      beforeTapEviction,
                      contribution,
                      diagnosticSink,
                      grants,
                      decodedInput as HookPayload,
                      parentSpan,
                      point,
                      worker,
                    ),
                  ),
                ),
              { discard: true },
            ),
          );
          return undefined as HookPointResult<typeof point>;
        }),
        point,
        traceState,
      );
    };
    const emit = emitImplementation as HookEmitterService["emit"];
    return {
      activeTapWorkerCount: Effect.sync(() => tapWorkers.size),
      emit,
      registerHookPoint: registry.registerHookPoint,
    } satisfies HookEmitterService;
  });

export const HookEmitterLive = (
  options: HookEmitterOptions = {},
): Layer.Layer<HookEmitter, never, ContributionRegistry> =>
  Layer.scoped(HookEmitter, makeHookEmitter(options));
