# 04-architecture-deepening - Implementation Plan

## ⚠️ Execution Protocol

A progress report exists at `.plans/04-architecture-deepening/progress-report.md`.
It lists every user-facing feature for every milestone as a checkbox.

**Mandatory rules for all agents working on this plan:**

1. Before starting a milestone, run `plan-db check-progress --plan "04-architecture-deepening"` and read its section in the progress report
2. Check each box as you complete the feature, not at the end
3. A milestone is NOT done until every current-cutoff checkbox under it is checked
4. If you find features missing from the report, add them first
5. Never declare a phase complete without updating the current focus marker and Summary
6. `FP-<number>` references must be backed by real progress-report sections and checkboxes
7. Fully deferred/tabled sections must be moved under Deferred follow-up; empty active sections must not remain
8. `complete` means merged to `main` via manual PR

## 0. Hard Dependencies

- Plan `03-deferred-follow-ups` is complete (518 tests, all gates green). Its generation lease (`D-005`), `ToolRegistry.view(sessionId)`, `PluginInteractions` FiberRef, and `/reload` drain/busy are the baseline this plan deepens. No other hard dependencies.

## Architecture

This document plus the decisions ledger in `plan.db` (D-001..D-006) are canonical and sufficient to execute.

```
kernel                          plugins
  TurnOrchestrator              GenerationRuntime        D-002, D-003
  (hides retry/batch/           (owns checkout/drain/
   compaction/steering)           busy/view — ONE count)

cli                             protocol
  ToolGateService               RpcTransport           D-004
  (owns vet + Ref               (owns LF/1MB framing
   generation-scoped)             + per-Session FIFO)

journal (no change this plan — D-006 defers to restructure)
  adapter-core stays deep; JournalRecovery drift is placement, not depth
```

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Keep `turn.ts` as thin adapter for one commit (D-002) | Migrate `abort-between-retries` test first; only then move callers; final delete of shim is a separate commit |
| One generation lease counted once (D-003, D-005) | New `GenerationRuntime` in `plugins` owns `checkout/drain/busy/view`; `cli/runtime.ts` becomes `DiscoveryAdapter → config` only; no `pendingOlds` duplication |
| Generation-scoped ToolGate Ref (D-004) | `allow-for-session` `Ref<Set>` cleared on `GenerationSwapDiagnostic`; no closure `Set` relying on ESM `cacheKey` |
| One seam, two adapters = real (D-004, D-005) | `RpcTransport` introduced with `serializedWriter` + `FakeTransport` adapters; soak drops dual `rawStdoutBytes` capture |
| No ADR-0001 conflict (D-006) | Journal `adapter-core` stays deep; do not deepen consumers — defer 05 to `restructure` |

### Boundaries

- New/changed module seams (module comments state owns/why/not-responsible):
  - `packages/kernel/src/turn-orchestrator.ts` (new): owns `TurnOrchestrator` deep interface `openTurn(sessionId, prompt, leasedGeneration)`. Not responsible for Journal folding (journal owns that) or generation lifetime (GenerationRuntime owns that).
  - `packages/plugins/src/generation-runtime.ts` (new): owns `GenerationRuntime` (checkout/drain/busy/close/view). Not responsible for discovery (`pipeline` owns that) or Turn orchestration.
  - `packages/cli/src/tools/tool-gate.ts` (new): owns `ToolGateService` (vet + diagnostics + generation-scoped Ref). Not responsible for `PluginInteractions` transport (heads own that) or Hook emission (`emitter` owns that).
  - `packages/cli/src/heads/rpc-transport.ts` (new): owns `RpcTransport` framing (LF, 1MB, U+2028/2029, `Buffer` provenance, per-Session FIFO). Not responsible for dispatch policy (`rpc-dispatch` owns that).
- Import-boundary CI unchanged; `protocol` keeps zero kernel imports; no `pi-ai` outside seam.

### Observability

- TurnOrchestrator: spans `turn.orchestrate` with `generationId`, `retryAttempt`, `abort` attributes.
- GenerationRuntime: single `leaseCount` in swap diagnostic; `drainDurationMillis` from one Ref.
- ToolGate: `tool_gate_decision` diagnostic with `plugin`, `sessionId`, `toolName`, `outcome` (allow/deny/cached), `generationId`.
- RpcTransport: `rpc.frame.write/read` diagnostics with `byteLength`, `sessionId`, `queueDepth`.

---

## Phases

### Phase 1: Turn deepening

**Goal:** `turn.ts` stops being a God-Module; callers depend on a small Turn handle.

#### M1: TurnOrchestrator deep module

- **Dependencies:** none
- **Effort:** L
- **Testing:** test-first
- **Observability:** required
- **Tasks:**
  1. Seams under test: new `packages/kernel/src/turn-orchestrator.ts` (`TurnOrchestrator` service); existing `turn.ts` as adapter; `provider-retry`, `tool-batch`, `compaction-policy`.
  2. RED: `abort between provider retry attempts` (M9 test) moved to `TurnOrchestrator` fake Provider: one `providerStart`, `stopReason: "aborted"`, Session usable for follow-up turn. GREEN: keep `turn.ts` delegating.
  3. RED: per-Session `view(sessionId)` pinned at `openTurn`, per-request `streamAssistant` declarations, `tool-batch` via `Tool` seam, `steering`/`follow-up` queueing, `compaction` no-tools — all hidden behind `openTurn`. GREEN.
  4. REFACTOR: module comments (owns/why/not-responsible); delete shim in follow-up commit.

### Phase 2: Generation unification

**Goal:** One `Ref` counts the lease; CLI and future TUI reuse without copy.

#### M2: GenerationRuntime single owner

- **Dependencies:** M1
- **Effort:** L
- **Testing:** test-first
- **Observability:** required
- **Tasks:**
  1. Seams under test: new `packages/plugins/src/generation-runtime.ts` (`GenerationRuntime`); `cli/plugins/runtime.ts` as DiscoveryAdapter; `pipeline.ts`; `reload.ts`.
  2. RED: `checkout`/`drain`/`busy`/`view(sessionId)` via one `Ref<{inFlight, drain}>`; `isReloading` single flag; no `pendingOlds` duplication. GREEN: re-express `makeCliRuntime` over `GenerationRuntime` (thin adapter).
  3. RED: `FakeClock` drain + `stalled fake provider` in-flight test as single `GenerationRuntime` spec (no `cli/runtime` integration spinning a real `Turn`). GREEN.
  4. REFACTOR: `GenerationRuntime` module comment; remove duplicated routing; `cli/runtime` comment states adapter only.

### Phase 3: ToolGate deepening

**Goal:** Vetting’s session memory and gate branching live in one module.

#### M3: ToolGateService

- **Dependencies:** M2
- **Effort:** M
- **Testing:** test-first
- **Observability:** required
- **Tasks:**
  1. Seams under test: new `packages/cli/src/tools/tool-gate.ts` (`ToolGateService`); `adapter.ts` thin; `tool-vetting.ts`/`trust-gate.ts` as second adapters; `emitter.ts` `tool-call-gate`.
  2. RED: `adapter` `execute` delegates to `ToolGateService.vet(toolCallId, toolName, args, sessionId)` → `GateDecision`; no direct `emitter.emit`. GREEN.
  3. RED: `allow-for-session` `Ref<Set<string>>` owned by service, cleared on `GenerationSwapDiagnostic`; generation-scoped forget asserted (no ESM `cacheKey` hack). GREEN.
  4. RED: `GateRejected` → `{content: reason, isError:true}` model-visible in call order; diagnostics `tool_gate_rejected` carry `plugin`. GREEN.
  5. REFACTOR: `ToolGate` module comment; adapter comment thin; gates’ module comments state linkable-module ownership.

### Phase 4: RpcTransport seam realization

**Goal:** Framing guarantees surfaced by the interface; soak no longer needs byte hacks.

#### M4: RpcTransport deep module

- **Dependencies:** M3
- **Effort:** M
- **Testing:** test-first
- **Observability:** required
- **Tasks:**
  1. Seams under test: new `packages/cli/src/heads/rpc-transport.ts` (`RpcTransport`); `rpc.ts`/`rpc-dispatch.ts`; `protocol`.
  2. RED: `writeFrame(frame)` / `readFrames(byteChunk: Buffer)` owns LF-only splitting, 1MB limit, `U+2028`/`U+2029` preservation, `Buffer` provenance, per-Session FIFO queue. GREEN.
  3. RED: `FakeTransport` second adapter for soak: `rawStdoutBytes` capture becomes `FakeTransport.capturedBytes` → `decode` → `strictEqual`; `providerStartLog` per Session `Set(["A","B","C"])` asserted via transport’s queue, not byte parsing. GREEN: delete dual capture.
  4. REFACTOR: `RpcTransport` module comment; `rpc`/`rpc-dispatch` comments state dispatch policy only.

### Gate → done

- [ ] All four milestones’ tests pass; `pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm check-boundaries` green; 10x flake for kernel/heads green
- [ ] README/docs updated (Turn handle, GenerationRuntime owner, ToolGate authoring, RpcTransport framing)
- [ ] PRs merged: plan recommends PR per phase (4 PRs) on `main`; `complete` means all merged

---

## Landing Strategy

| Field | Value |
|-------|-------|
| Merge target | `main` <!-- D-001 --> |
| Branch model | branch per phase |
| PR cadence | PR per phase (4 PRs) |
| Ship mechanism | manual PR via GitHub (tool-proxy) |

## Validation Commands

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm check-boundaries
# flake: for i in 1..10; do pnpm --filter @pop-eye/kernel test src/turn-orchestrator.test.ts; done
```
