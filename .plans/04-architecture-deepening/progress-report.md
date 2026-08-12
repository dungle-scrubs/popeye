# 04-architecture-deepening - Progress Report

> Auto-generated from implementation plan. This is the canonical
> source of truth for what is done and what remains. Update this
> file as features are implemented - never mark a milestone complete
> until every current-cutoff checkbox under it is checked.

> Current focus: Phase 4 - RpcTransport seam realization

## Phase 1: Turn deepening

### M1: TurnOrchestrator deep module
Source: `implementation.md` (M1)

- [x] `abort between provider retry attempts` moved to TurnOrchestrator fake Provider: one providerStart, stopReason aborted, Session usable for follow-up
- [x] per-Session view pinned at openTurn, per-request streamAssistant declarations, tool-batch via Tool seam, steering/follow-up queueing, compaction no-tools hidden behind openTurn
- [x] module comments owns/why/not-responsible; shim deletion follow-up

## Phase 2: Generation unification

### M2: GenerationRuntime single owner
Source: `implementation.md` (M2)

- [x] checkout/drain/busy/view via one Ref<{inFlight,drain}>; isReloading single flag; no pendingOlds duplication
- [x] makeCliRuntime thin adapter over GenerationRuntime
- [x] FakeClock drain + stalled fake provider in-flight as single GenerationRuntime spec
- [x] module comments; remove duplicated routing

## Phase 3: ToolGate deepening

### M3: ToolGateService
Source: `implementation.md` (M3)

- [x] adapter execute delegates to ToolGateService.vet(toolCallId, toolName, args, sessionId)
- [x] allow-for-session Ref<Set> owned by service, cleared on GenerationSwap; generation-scoped forget asserted
- [x] GateRejected → {content, isError:true} model-visible in call order; diagnostics carry plugin
- [x] module comments; gates as second adapters

## Phase 4: RpcTransport seam realization

### M4: RpcTransport deep module
Source: `implementation.md` (M4)

- [ ] writeFrame/readFrames owns LF-only, 1MB, U+2028/2029, Buffer provenance, per-Session FIFO
- [ ] FakeTransport second adapter for soak; rawStdoutBytes dual capture deleted
- [ ] providerStartLog Set(["A","B","C"]) via transport queue
- [ ] module comments; dispatch policy only in rpc/rpc-dispatch

## Deferred follow-up

Source: `implementation.md` (Deferred)

- [ ] Journal drift (05) - restructure JournalRecovery centralization, not deepening

## Summary
- Total features: 14
- Completed: 11
- Remaining: 3
- Current cutoff blockers: 3
- Accepted/deferred follow-up: 1
