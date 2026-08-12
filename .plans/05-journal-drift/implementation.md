# 05-journal-drift - Implementation Plan

## ⚠️ Execution Protocol

A progress report exists at `.plans/05-journal-drift/progress-report.md`.
It lists every user-facing feature for every milestone as a checkbox.

**Mandatory rules for all agents working on this plan:**

1. Before starting a milestone, run `plan-db check-progress --plan "05-journal-drift"` and read its section in the progress report
2. Check each box as you complete the feature, not at the end
3. A milestone is NOT done until every current-cutoff checkbox under it is checked
4. If you find features missing from the report, add them first
5. Never declare a phase complete without updating the current focus marker and Summary
6. `FP-<number>` references must be backed by real progress-report sections and checkboxes
7. Fully deferred/tabled sections must be moved under Deferred follow-up; empty active sections must not remain
8. `complete` means merged to `main` via manual PR

## 0. Hard Dependencies

- Plans `00`–`04` are complete and on `main` (521 tests, all gates green). `04` deferred this work as D-006 (adapter-core stays deep; consumer drift is placement). Baseline: `TurnOrchestrator` (`kernel/turn-orchestrator.ts`), `GenerationRuntime` (`plugins/generation-runtime.ts`), `ToolGateService` (`cli/tools/tool-gate.ts`), `RpcTransport` (`cli/heads/rpc-transport.ts`).

## Architecture

This document plus the decisions ledger in `plan.db` (D-001..D-00N) are canonical and sufficient to execute.

```
journal                          kernel
  Journal (tag)                    SessionStore        D-001
  adapter-core (deep, stays)       (owns create/list/  D-002
  JournalRecovery drift            resume/recovery +
  is consumer placement,          branch/compaction
  not depth per ADR-0001           writes — ONE journal
                                   caller)
         ▲
         │ JournalService only
         │
  kernel/recovery.ts             kernel/sessions.ts    kernel/driver.ts
  (pure planning stays,           (thin adapter)        (thin adapter)
   re-export one commit)
```

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| ADR-0001: journal is the only durable representation | Do not move kernel payload knowledge (MessageEntryPayload, OperationStarted, ToolReplay) into `journal`; centralize inside `kernel` behind one caller of `Journal` |
| `adapter-core` stays deep (04/D-006) | No new `journal/recovery.ts` that imports kernel types; the deep owner is `kernel/session-store.ts` calling `Journal` |
| History is comprehension (restructure) | File moves are pure `git mv` with no content edits in the same commit; splits are separate commits |
| One journal caller per session lifecycle (D-001) | `SessionStore` owns `createSession`, `listSessions`, `countDurableLines`, `readBranch`, `readRecords`, `boundedRecoveryRecords`, `recoverSession`, `applyRecoveryPlan`, `getLeaf`, `moveLeaf`, `appendEntry`, `appendCompaction` for session lifecycle; `sessions.ts` and `driver.ts` delegate |
| Preserve `Journal` seam | `SessionStore` depends only on `Journal` (Context.Tag), not on `JournalJsonl`/`JournalMemory` directly; tests inject layers as before |

### Boundaries

- New/changed module seams (module comments state owns/why/not-responsible):
  - `packages/kernel/src/session-store.ts` (new): owns session lifecycle against `Journal` — create, list, resume (recovery planning + application + diagnostics), branch reads, compaction writes, leaf/revision. Not responsible for mailbox serialization, ToolRegistry view, or Provider transport (callers own those); not responsible for journal persistence (adapter-core owns that).
  - `packages/kernel/src/recovery.ts` (existing, stays one commit as re-export): thin adapter over `session-store` pure helpers (`boundedRecoveryRecords`, `recoverSession`, `applyRecoveryPlan`) until callers migrate; module comment states adapter only.
  - `packages/kernel/src/sessions.ts` (thin): delegates `create`/`list`/`resume`/`setSessionName` to `SessionStore`; no direct `journal.readRecords`/`readBranch`/`recoverSession`.
  - `packages/kernel/src/driver.ts` (thin): delegates `createSession`/`branch`/`compactNow` durable ops to `SessionStore` where they duplicate sessions logic; no new direct journal imports.
- Import-boundary CI unchanged; `protocol` keeps zero kernel imports; no `pi-ai` outside seam.

### Observability

- SessionStore: spans `session_store.{create,list,resume,branch,compact}` with `sessionId`, `revision`, `actionCount`, `entriesAppendedCount`, `safeReplayCount`; reuses existing `session_recovery` diagnostic sink.
- No new metrics; `recovery` diagnostics remain as before but emitted from one caller.

---

## Phases

### Phase 1: SessionStore deep module (placement, not depth)

**Goal:** One caller of `Journal` for session lifecycle; consumers stop duplicating recovery reads.

#### M1: SessionStore deep module

- **Dependencies:** none
- **Effort:** M
- **Testing:** test-first
- **Observability:** required
- **Tasks:**
  1. Seams under test: new `packages/kernel/src/session-store.ts` (`SessionStore` Context.Tag + `SessionStoreLive`); existing `Journal` harness + `JournalMemory`.
  2. RED: `SessionStore.create()` → `journal.createSession` + `countDurableLines` + `mailbox.activate` equivalent (store activates via injected `Mailbox`) — or keep activation in caller and store only journal part; decide per D-002 and assert via `sessions.test.ts` style. GREEN: one journal caller for create.
  3. RED: `SessionStore.resume(sessionId, availableToolNames)` owns `readRecords` → `boundedRecoveryRecords` → `readBranch` → `recoverSession` → `applyRecoveryPlan` → `getLeaf` + diagnostic sink; `sessions.resume` delegates and no longer imports `recovery.ts` internals directly. Assert via `recovery-matrix.test.ts` + `recovery-crash.test.ts` equivalence (reports identical). GREEN.
  4. RED: `SessionStore.list()` and `SessionStore.getBranch`/`compactNow` paths used by `driver` (branch, compact) delegate through store; `driver.ts` no longer duplicates `journal.readBranch`/`appendCompaction` patterns. GREEN.
  5. REFACTOR: `SessionStore` module comment owns/why/not-responsible; `sessions.ts` and `driver.ts` comments state thin adapter; `recovery.ts` comment states re-export adapter for one commit.

#### M2: Restructure moves (history-preserving)

- **Dependencies:** M1
- **Effort:** S
- **Testing:** test-after (no behavior change; verify `git log --follow` and `pnpm test`)
- **Observability:** none
- **Tasks:**
  1. Pure `git mv` commits with no content edits: if `recovery.ts` helpers move into `session-store.ts`, first commit is `git mv` + re-export shim, second commit moves bodies. No content + move in same commit.
  2. Verify `pnpm check-boundaries` still green; `protocol` imports unchanged.
  3. Update `docs/testing-with-fixtures.md` and `docs/conformance-suites.md` references if they name old paths.

### Gate → done

- [ ] `SessionStore` owns all session lifecycle journal calls; `sessions.ts`/`driver.ts` are thin adapters; `recovery.ts` re-export shim green for one commit
- [ ] `pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm check-boundaries` green; no new `Journal` call sites outside `SessionStore`
- [ ] Docs updated; PR merged to `main`; `complete` means merged

---

## Landing Strategy

| Field | Value |
|-------|-------|
| Merge target | `main` <!-- D-001 --> |
| Branch model | branch per phase |
| PR cadence | 1 PR (placement-only restructure) |
| Ship mechanism | manual PR via GitHub (tool-proxy) |

## Validation Commands

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm check-boundaries
# history: git log --oneline --follow -- packages/kernel/src/session-store.ts
```
