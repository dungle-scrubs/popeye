# A-003 - Scoped generation drain during hot reload

## What ran

`npx tsx spike-a003.ts` against `effect@3.22.1`, followed by strict TypeScript checking. The experiment uses `Scope.make()` for each generation, `Layer.scoped` plus `Layer.buildWithScope` to create the generation service, a `Ref` for the currently routable generation and each generation's in-flight count, and a `Deferred` drain barrier.

## Stress result

The script completed 120 randomized iterations. Each iteration:

- Started 2-5 old-generation turns, waited until each had captured the old generation, then atomically replaced the current-generation `Ref`.
- Started a new turn after the swap and asserted that it captured only the new generation.
- Started old-scope closure behind `Deferred.await(old.drained)`.
- Interrupted one selected old turn during the drain, with randomized 0-3 ms interruption delay and 8-20 ms old-turn durations.
- Asserted that every old turn settled, the old finalizer ran exactly once after the last old settlement, and reload completion was logged only after that finalizer.
- Asserted that no turn observed its generation as closed, and closed the fresh generation exactly once during cleanup.

The full strict check also passed:

```text
npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --strict --noUncheckedIndexedAccess --skipLibCheck --allowImportingTsExtensions spike-a001.ts spike-a002.ts spike-a003.ts fixtures-a002/*.ts
```

VERDICT: pass
