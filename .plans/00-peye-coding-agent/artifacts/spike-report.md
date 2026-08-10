# peye v1 - Spike Report

Executed 2026-08-10 by Codex (gpt-5.6, workspace-write sandbox, offline)
against `effect@3.22.1` and `@earendil-works/pi-ai@0.84.1` on Node
v24.15.0. Full reports and runnable scripts:
`artifacts/spikes/report-A-00{1,2,3}.md`, `spike-a00{1,2,3}.ts`.

## A-001: pi-ai stream wrapping - FAIL (narrow), resolved

Every fidelity assertion passed on real `AssistantMessageEventStream`
instances: item order preserved through `Stream.fromAsyncIterable`;
terminal `error`/`aborted` fixtures convert to typed failures (never a
throw); `result()` agrees with stream end; `isRetryableAssistantError`
imports and classifies. The failure is scoped to cancellation: consumer
fiber interruption does not stop the producer, because the stream type
exposes no cancellation hook.

**Resolution (merged into M12):** cancellation belongs at the request,
not the stream. pi-ai stream options accept `signal?: AbortSignal`
(`dist/types.d.ts:50`); the seam owns an `AbortController` per request
and wires fiber interruption to `abort()` (`Effect.onInterrupt`). No
buffering/normalization layer is needed - escape hatch 3 is retired in
favor of this bridge, which M12 tests explicitly.

## A-002: native TS plugin loading - PASS

Node 24 type stripping loads user plugin files by absolute `file:` URL
`import()`: annotations, `import type`, generics, `effect` resolved from
host `node_modules`, and relative sibling `.ts` imports all work with no
loader dependency. Hot reload gets fresh module state via a
query-string-busted URL (`?reload=<key>`), proven by stateful module
counters. Unsupported (documented as prohibited plugin syntax): `enum`
and `namespace` (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` in strip-only
mode). jiti is not needed; escape hatch 1 is retired.

## A-003: Scope-drain hot reload - PASS

120 randomized race-stress iterations of the exact M18 design -
`Scope.make()` per generation, `Layer.scoped` + `Layer.buildWithScope`,
`Ref` for the routable generation, per-generation in-flight counts, and
a `Deferred` drain barrier: the old finalizer ran exactly once, always
after the last old-generation turn settled and before reload completion;
post-swap turns never observed the old generation; interrupting an old
turn mid-drain stayed safe. Strict `tsc --noEmit` passed over all spike
code. Escape hatch 2 is retired; the named primitives move into M18's
tasks as the validated design.
