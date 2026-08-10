import assert from "node:assert/strict";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Ref,
  Scope,
} from "effect";

interface GenerationService {
  readonly closed: Ref.Ref<boolean>;
  readonly id: number;
}

class Generation extends Context.Tag("peye/Generation")<Generation, GenerationService>() {}

interface GenerationRuntime {
  readonly drained: Deferred.Deferred<void>;
  readonly inFlight: Ref.Ref<number>;
  readonly scope: Scope.CloseableScope;
  readonly service: GenerationService;
}

interface TurnStart {
  readonly generationId: number;
  readonly started: Deferred.Deferred<number>;
}

function randomInt(minimum: number, maximum: number): number {
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

function append(log: Ref.Ref<readonly string[]>, event: string): Effect.Effect<void> {
  return Ref.update(log, (events) => [...events, event]);
}

function makeGeneration(id: number, log: Ref.Ref<readonly string[]>): Effect.Effect<GenerationRuntime> {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const closed = yield* Ref.make(false);
    const layer = Layer.scoped(
      Generation,
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Ref.set(closed, true);
            yield* append(log, `finalizer:${id}`);
          }),
        );
        return { closed, id } satisfies GenerationService;
      }),
    );
    const context = yield* Layer.buildWithScope(layer, scope);
    const service = Context.get(context, Generation);
    return {
      drained: yield* Deferred.make<void>(),
      inFlight: yield* Ref.make(0),
      scope,
      service,
    };
  });
}

function settleTurn(generation: GenerationRuntime, log: Ref.Ref<readonly string[]>): Effect.Effect<void> {
  return Effect.gen(function* () {
    const wasClosed = yield* Ref.get(generation.service.closed);
    assert.equal(wasClosed, false, `generation ${generation.service.id} was used after its scope closed`);
    yield* append(log, `turn-settled:${generation.service.id}`);
    const remaining = yield* Ref.modify(generation.inFlight, (count) => [count - 1, count - 1] as const);
    assert.ok(remaining >= 0, `generation ${generation.service.id} in-flight count became negative`);
    if (remaining === 0) yield* Deferred.succeed(generation.drained, undefined);
  });
}

function runTurn(
  current: Ref.Ref<GenerationRuntime>,
  delayMs: number,
  log: Ref.Ref<readonly string[]>,
  started: Deferred.Deferred<number>,
): Effect.Effect<number> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const generation = yield* Ref.get(current);
      yield* Ref.update(generation.inFlight, (count) => count + 1);
      yield* Deferred.succeed(started, generation.service.id);
      return yield* restore(
        Effect.gen(function* () {
          const wasClosedAtStart = yield* Ref.get(generation.service.closed);
          assert.equal(wasClosedAtStart, false, `generation ${generation.service.id} was closed before its turn started`);
          yield* Effect.sleep(`${delayMs} millis`);
          const wasClosedAtEnd = yield* Ref.get(generation.service.closed);
          assert.equal(wasClosedAtEnd, false, `generation ${generation.service.id} closed while a turn was in flight`);
          return generation.service.id;
        }),
      ).pipe(Effect.ensuring(settleTurn(generation, log)));
    }),
  );
}

function startTurn(
  current: Ref.Ref<GenerationRuntime>,
  delayMs: number,
  log: Ref.Ref<readonly string[]>,
): Effect.Effect<TurnStart & { readonly fiber: Fiber.Fiber<number, never> }> {
  return Effect.gen(function* () {
    const started = yield* Deferred.make<number>();
    const fiber = yield* Effect.fork(runTurn(current, delayMs, log, started));
    const generationId = yield* Deferred.await(started);
    return { fiber, generationId, started };
  });
}

function indexAfter(events: readonly string[], first: string, second: string): void {
  const firstIndex = events.lastIndexOf(first);
  const secondIndex = events.lastIndexOf(second);
  assert.ok(firstIndex >= 0, `missing ${first}`);
  assert.ok(secondIndex >= 0, `missing ${second}`);
  assert.ok(firstIndex < secondIndex, `${first} must precede ${second}`);
}

function runIteration(iteration: number): Effect.Effect<void> {
  return Effect.gen(function* () {
    const log = yield* Ref.make<readonly string[]>([]);
    const old = yield* makeGeneration(iteration * 2, log);
    const current = yield* Ref.make(old);
    const oldTurnCount = randomInt(2, 5);
    const oldTurns: Array<TurnStart & { readonly fiber: Fiber.Fiber<number, never> }> = [];

    for (let index = 0; index < oldTurnCount; index += 1) {
      oldTurns.push(yield* startTurn(current, randomInt(8, 20), log));
    }
    assert.ok(oldTurns.every((turn) => turn.generationId === old.service.id));

    const fresh = yield* makeGeneration((iteration * 2) + 1, log);
    yield* Ref.set(current, fresh);
    const newTurn = yield* startTurn(current, randomInt(1, 5), log);
    assert.equal(newTurn.generationId, fresh.service.id, "a turn started after swap must not observe the old generation");

    const closeFiber = yield* Effect.fork(
      Deferred.await(old.drained).pipe(
        Effect.zipRight(Scope.close(old.scope, Exit.succeed(undefined))),
        Effect.zipRight(append(log, `reload-complete:${old.service.id}`)),
      ),
    );

    const interruptedIndex = randomInt(0, oldTurns.length - 1);
    yield* Effect.sleep(`${randomInt(0, 3)} millis`);
    yield* Fiber.interrupt(oldTurns[interruptedIndex]!.fiber);

    const oldExits = yield* Effect.forEach(oldTurns, (turn) => Fiber.await(turn.fiber));
    const interruptedExit = oldExits[interruptedIndex]!;
    assert.ok(Exit.isFailure(interruptedExit), "the selected old turn must have been interrupted during drain");
    if (Exit.isFailure(interruptedExit)) {
      assert.ok(Cause.isInterruptedOnly(interruptedExit.cause), "drain interruption must be interruption-only");
    }

    const newExit = yield* Fiber.await(newTurn.fiber);
    assert.ok(Exit.isSuccess(newExit));
    const closeExit = yield* Fiber.await(closeFiber);
    assert.ok(Exit.isSuccess(closeExit));

    const events = yield* Ref.get(log);
    const oldSettlements = events.filter((event) => event === `turn-settled:${old.service.id}`);
    const oldFinalizers = events.filter((event) => event === `finalizer:${old.service.id}`);
    assert.equal(oldSettlements.length, oldTurnCount, "every old turn must settle before scope close");
    assert.equal(oldFinalizers.length, 1, "old generation finalizer must run exactly once");
    indexAfter(events, `turn-settled:${old.service.id}`, `finalizer:${old.service.id}`);
    indexAfter(events, `finalizer:${old.service.id}`, `reload-complete:${old.service.id}`);

    yield* Scope.close(fresh.scope, Exit.succeed(undefined));
    const freshFinalizers = (yield* Ref.get(log)).filter((event) => event === `finalizer:${fresh.service.id}`);
    assert.equal(freshFinalizers.length, 1, "new generation finalizer must run exactly once on cleanup");
  });
}

async function main(): Promise<void> {
  const iterations = 120;
  const exit = await Effect.runPromiseExit(
    Effect.forEach(Array.from({ length: iterations }, (_, index) => index), runIteration),
  );
  assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "unreachable");
  console.log(JSON.stringify({
    assertions: [
      "new turns after Ref swap observed only the new generation",
      "old scope finalizer ran after all old turn settlements",
      "reload completion followed the old finalizer",
      "one old turn was interrupted during every drain and finalization still ran once",
      "no turn observed a closed generation",
    ],
    iterations,
    result: "pass",
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
