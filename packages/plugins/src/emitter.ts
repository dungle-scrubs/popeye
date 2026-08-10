/**
 * Owns generic Hook execution for every declared point.
 * It exists because one emitter must execute all Hook points from declared semantics; bespoke
 * per-point emitters must not exist, which preserves the M2 review lesson from pi.
 */
import type { Duration, Scope, Tracer } from "effect";
import { Clock, Context, Effect, Exit, Layer, Queue, Ref } from "effect";

import type { CapabilityGrants } from "./capability.js";
import type { RegisteredContribution } from "./contribution.js";
import { type ContributionRegistryError, GateRejected } from "./errors.js";
import {
  HOOK_POINTS,
  type HookPayload,
  type HookPointInput,
  type HookPointName,
  type HookPointOutput,
} from "./hook-points.js";
import { ContributionRegistry, HookContributionKind } from "./registry.js";

type RegisteredHook = RegisteredContribution<
  "hook",
  {
    readonly mergeClass: "Accumulate" | "Chain" | "FirstWins" | "Tap";
    readonly name: string;
    readonly point: string;
    readonly run: (input: unknown) => Effect.Effect<unknown, unknown>;
  }
>;

export const DEFAULT_GATE_TIMEOUT_MILLIS = 30_000;
export const DEFAULT_TAP_QUEUE_CAPACITY = 64;

export interface HookContributionSkippedDiagnostic {
  readonly mergeClass: "Accumulate" | "Chain" | "FirstWins";
  readonly plugin: string;
  readonly point: HookPointName;
  readonly reason: string;
  readonly type: "hook_contribution_skipped";
}

export interface HookTapFailedDiagnostic {
  readonly plugin: string;
  readonly point: HookPointName;
  readonly reason: string;
  readonly type: "hook_tap_failed";
}

export interface HookTapDroppedDiagnostic {
  readonly droppedCount: number;
  readonly plugin: string;
  readonly point: HookPointName;
  readonly type: "hook_tap_dropped";
}

export interface HookGateRejectedDiagnostic {
  readonly plugin: string;
  readonly point: HookPointName;
  readonly reason: string;
  readonly timedOut: boolean;
  readonly type: "hook_gate_rejected";
}

export type HookDiagnostic =
  | HookContributionSkippedDiagnostic
  | HookGateRejectedDiagnostic
  | HookTapDroppedDiagnostic
  | HookTapFailedDiagnostic;

export interface HookEmitterOptions {
  readonly diagnosticSink?: (diagnostic: HookDiagnostic) => Effect.Effect<void>;
  readonly gateTimeout?: Duration.DurationInput;
  readonly tapQueueCapacity?: number;
}

const compareHookPriority = (left: RegisteredHook, right: RegisteredHook): number =>
  right.priority - left.priority || left.key.localeCompare(right.key);

const hooksAtPoint = (
  contributions: ReadonlyArray<RegisteredHook>,
  point: HookPointName,
): ReadonlyArray<RegisteredHook> => {
  const definition = HOOK_POINTS[point];
  return contributions
    .filter(
      (contribution) =>
        contribution.payload.point === point &&
        contribution.payload.mergeClass === definition.mergeClass,
    )
    .sort(compareHookPriority);
};

const pluginName = (contribution: RegisteredHook): string =>
  contribution.key.slice(0, contribution.key.indexOf("/"));

const failureReason = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

const gateRejected = (
  contribution: RegisteredHook,
  point: HookPointName,
  reason: string,
  timedOut: boolean,
): GateRejected => new GateRejected({ plugin: pluginName(contribution), point, reason, timedOut });

const skippedDiagnostic = (
  contribution: RegisteredHook,
  failure: unknown,
  mergeClass: HookContributionSkippedDiagnostic["mergeClass"],
  point: HookPointName,
): HookContributionSkippedDiagnostic => ({
  mergeClass,
  plugin: pluginName(contribution),
  point,
  reason: failureReason(failure),
  type: "hook_contribution_skipped",
});

const tapFailedDiagnostic = (
  contribution: RegisteredHook,
  failure: unknown,
  point: HookPointName,
): HookTapFailedDiagnostic => ({
  plugin: pluginName(contribution),
  point,
  reason: failureReason(failure),
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
                outcome: Exit.isSuccess(exit) ? "success" : "failure",
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
  | { readonly status: "skipped" }
  | { readonly status: "success"; readonly value: unknown };

const runSkippable = (
  contribution: RegisteredHook,
  diagnosticSink: (diagnostic: HookDiagnostic) => Effect.Effect<void>,
  input: unknown,
  mergeClass: HookContributionSkippedDiagnostic["mergeClass"],
  point: HookPointName,
  traceState: HookTraceState,
): Effect.Effect<HookRunResult> =>
  traceContribution(contribution, contribution.payload.run(input), point).pipe(
    Effect.map((value) => ({ status: "success" as const, value })),
    Effect.catchAll((failure) => {
      traceState.skippedPlugins.push(pluginName(contribution));
      return diagnosticSink(skippedDiagnostic(contribution, failure, mergeClass, point)).pipe(
        Effect.as({ status: "skipped" as const }),
      );
    }),
  );

const runGate = (
  contribution: RegisteredHook,
  diagnosticSink: (diagnostic: HookDiagnostic) => Effect.Effect<void>,
  gateTimeout: Duration.DurationInput,
  input: unknown,
  point: HookPointName,
  traceState: HookTraceState,
): Effect.Effect<unknown, GateRejected> =>
  traceContribution(contribution, contribution.payload.run(input), point).pipe(
    Effect.mapError((failure) => gateRejected(contribution, point, failureReason(failure), false)),
    Effect.timeoutFail({
      duration: gateTimeout,
      onTimeout: () =>
        gateRejected(
          contribution,
          point,
          `Hook gate timed out after ${String(gateTimeout)}.`,
          true,
        ),
    }),
    Effect.tapError((error) =>
      Effect.sync(() => traceState.rejectedPlugins.push(pluginName(contribution))).pipe(
        Effect.zipRight(
          diagnosticSink({
            plugin: error.plugin,
            point,
            reason: error.reason,
            timedOut: error.timedOut,
            type: "hook_gate_rejected",
          }),
        ),
      ),
    ),
  );

const runTap = (
  contribution: RegisteredHook,
  diagnosticSink: (diagnostic: HookDiagnostic) => Effect.Effect<void>,
  input: HookPayload,
  point: HookPointName,
): Effect.Effect<void> =>
  traceContribution(contribution, contribution.payload.run(input), point).pipe(
    Effect.catchAll((failure) => {
      const diagnostic = tapFailedDiagnostic(contribution, failure, point);
      return diagnosticSink(diagnostic).pipe(
        Effect.zipRight(Effect.logWarning(JSON.stringify(diagnostic))),
      );
    }),
  );

const runFirstWins = (
  contributions: ReadonlyArray<RegisteredHook>,
  diagnosticSink: (diagnostic: HookDiagnostic) => Effect.Effect<void>,
  gateTimeout: Duration.DurationInput,
  input: HookPayload,
  point: HookPointName,
  rejectFailures: boolean,
  traceState: HookTraceState,
): Effect.Effect<unknown | undefined, GateRejected> =>
  Effect.gen(function* () {
    for (const contribution of contributions) {
      const output = rejectFailures
        ? yield* runGate(contribution, diagnosticSink, gateTimeout, input, point, traceState)
        : yield* runSkippable(
            contribution,
            diagnosticSink,
            input,
            "FirstWins",
            point,
            traceState,
          ).pipe(Effect.map((result) => (result.status === "success" ? result.value : undefined)));
      if (output !== undefined) {
        return output;
      }
    }
    return undefined;
  });

const runChain = (
  contributions: ReadonlyArray<RegisteredHook>,
  diagnosticSink: (diagnostic: HookDiagnostic) => Effect.Effect<void>,
  input: HookPayload,
  point: HookPointName,
  traceState: HookTraceState,
): Effect.Effect<HookPayload> =>
  Effect.reduce(contributions, input, (current, contribution) =>
    runSkippable(contribution, diagnosticSink, current, "Chain", point, traceState).pipe(
      Effect.map((result) =>
        result.status === "success" ? (result.value as HookPayload) : current,
      ),
    ),
  );

const runAccumulate = (
  combine: (current: HookPayload, next: HookPayload) => HookPayload,
  contributions: ReadonlyArray<RegisteredHook>,
  diagnosticSink: (diagnostic: HookDiagnostic) => Effect.Effect<void>,
  input: HookPayload,
  point: HookPointName,
  traceState: HookTraceState,
): Effect.Effect<HookPayload> =>
  Effect.reduce(contributions, input, (current, contribution) =>
    runSkippable(contribution, diagnosticSink, input, "Accumulate", point, traceState).pipe(
      Effect.map((result) =>
        result.status === "success" ? combine(current, result.value as HookPayload) : current,
      ),
    ),
  );

interface TapWork {
  readonly input: HookPayload;
  readonly parentSpan: Tracer.Span;
}

interface TapWorker {
  readonly capacity: number;
  readonly droppedCount: Ref.Ref<number>;
  readonly offerMutex: Effect.Semaphore;
  readonly queue: Queue.Queue<TapWork>;
}

const makeTapWorker = (
  contribution: RegisteredHook,
  capacity: number,
  diagnosticSink: (diagnostic: HookDiagnostic) => Effect.Effect<void>,
  point: HookPointName,
  scope: Scope.Scope,
): Effect.Effect<TapWorker> =>
  Effect.gen(function* () {
    const droppedCount = yield* Ref.make(0);
    const offerMutex = yield* Effect.makeSemaphore(1);
    const queue = yield* Queue.sliding<TapWork>(capacity);
    yield* Effect.forkIn(
      Effect.forever(
        Queue.take(queue).pipe(
          Effect.flatMap((work) =>
            runTap(contribution, diagnosticSink, work.input, point).pipe(
              Effect.withParentSpan(work.parentSpan),
            ),
          ),
          Effect.asVoid,
        ),
      ),
      scope,
    );
    return { capacity, droppedCount, offerMutex, queue };
  });

const offerTap = (
  contribution: RegisteredHook,
  diagnosticSink: (diagnostic: HookDiagnostic) => Effect.Effect<void>,
  input: HookPayload,
  parentSpan: Tracer.Span,
  point: HookPointName,
  worker: TapWorker,
): Effect.Effect<void> =>
  worker.offerMutex.withPermits(1)(
    Effect.gen(function* () {
      if (yield* Queue.isFull(worker.queue)) {
        const droppedCount = yield* Ref.updateAndGet(worker.droppedCount, (count) => count + 1);
        yield* diagnosticSink({
          droppedCount,
          plugin: pluginName(contribution),
          point,
          type: "hook_tap_dropped",
        });
      }
      yield* Queue.offer(worker.queue, { input, parentSpan });
    }),
  );

export interface HookEmitterService {
  readonly emit: <TPoint extends HookPointName>(
    point: TPoint,
    input: HookPointInput<TPoint>,
    grants: CapabilityGrants,
  ) => Effect.Effect<HookPointOutput<TPoint>, ContributionRegistryError | GateRejected>;
}

export class HookEmitter extends Context.Tag("@peye/plugins/HookEmitter")<
  HookEmitter,
  HookEmitterService
>() {}

const initialOutput = <TPoint extends HookPointName>(
  point: TPoint,
  input: HookPointInput<TPoint>,
): HookPointOutput<TPoint> => {
  const mergeClass = HOOK_POINTS[point].mergeClass;
  return (
    mergeClass === "Accumulate" || mergeClass === "Chain" ? (input as HookPayload) : undefined
  ) as HookPointOutput<TPoint>;
};

const makeHookEmitter = (options: HookEmitterOptions) =>
  Effect.gen(function* () {
    const registry = yield* ContributionRegistry;
    const diagnosticSink = options.diagnosticSink ?? (() => Effect.void);
    const gateTimeout = options.gateTimeout ?? DEFAULT_GATE_TIMEOUT_MILLIS;
    const tapQueueCapacity = options.tapQueueCapacity ?? DEFAULT_TAP_QUEUE_CAPACITY;
    const scope = yield* Effect.scope;
    const tapWorkerMutex = yield* Effect.makeSemaphore(1);
    const tapWorkers = new Map<string, TapWorker>();

    const tapWorker = (
      contribution: RegisteredHook,
      point: HookPointName,
    ): Effect.Effect<TapWorker> =>
      tapWorkerMutex.withPermits(1)(
        Effect.gen(function* () {
          const existing = tapWorkers.get(contribution.key);
          if (existing !== undefined) {
            return existing;
          }
          const worker = yield* makeTapWorker(
            contribution,
            tapQueueCapacity,
            diagnosticSink,
            point,
            scope,
          );
          tapWorkers.set(contribution.key, worker);
          return worker;
        }),
      );

    const emit: HookEmitterService["emit"] = (point, input, grants) => {
      const traceState = makeHookTraceState();
      return traceHook(
        Effect.gen(function* () {
          const definition = HOOK_POINTS[point];
          const contributions = hooksAtPoint(
            yield* registry.list(HookContributionKind, grants),
            point,
          );
          traceState.contributionCount = contributions.length;
          const initial = initialOutput(point, input);
          if (definition.mergeClass === "FirstWins") {
            return (yield* runFirstWins(
              contributions,
              diagnosticSink,
              gateTimeout,
              input,
              point,
              definition.failurePolicy === "reject",
              traceState,
            )) as HookPointOutput<typeof point>;
          }
          if (definition.mergeClass === "Chain") {
            return (yield* runChain(
              contributions,
              diagnosticSink,
              initial as HookPayload,
              point,
              traceState,
            )) as HookPointOutput<typeof point>;
          }
          if (definition.mergeClass === "Accumulate") {
            const combine = definition.combine;
            if (combine === null) {
              return yield* Effect.dieMessage(`Accumulate Hook point ${point} has no combiner.`);
            }
            return (yield* runAccumulate(
              combine,
              contributions,
              diagnosticSink,
              initial as HookPayload,
              point,
              traceState,
            )) as HookPointOutput<typeof point>;
          }
          if (definition.mergeClass === "Tap") {
            const parentSpan = yield* Effect.currentSpan.pipe(Effect.orDie);
            yield* Effect.forEach(
              contributions,
              (contribution) =>
                tapWorker(contribution, point).pipe(
                  Effect.flatMap((worker) =>
                    offerTap(contribution, diagnosticSink, input, parentSpan, point, worker),
                  ),
                ),
              { discard: true },
            );
          }
          return initial;
        }),
        point,
        traceState,
      );
    };
    return { emit } satisfies HookEmitterService;
  });

export const HookEmitterLive = (
  options: HookEmitterOptions = {},
): Layer.Layer<HookEmitter, never, ContributionRegistry> =>
  Layer.scoped(HookEmitter, makeHookEmitter(options));
