# 05-journal-drift - Progress Report

> Auto-generated from implementation plan. This is the canonical
> source of truth for what is done and what remains. Update this
> file as features are implemented - never mark a milestone complete
> until every current-cutoff checkbox under it is checked.

> Current focus: Complete — all milestones done

## Phase 1: SessionStore deep module (placement, not depth)

### M1: SessionStore deep module
Source: `implementation.md` (M1)

- [x] `SessionStore` `Context.Tag` owns session lifecycle against `Journal` — `create`/`list`/`resume` (recovery planning + application + diagnostics)/`branch`/`compact`/`leaf`/`revision` behind `JournalService`
- [x] `sessions.ts` delegates to `SessionStore`; no direct `journal.readRecords`/`readBranch`/`recoverSession`/`applyRecoveryPlan`/`getLeaf` duplication
- [x] `driver.ts` delegates branch/compact/revision durable ops to `SessionStore`; no duplicated `journal.readBranch`/`appendCompaction` patterns
- [x] `recovery.ts` stays one commit as thin re-export adapter over `SessionStore` helpers; module comment states adapter only
- [x] `SessionStore` module comment owns/why/not-responsible; thin-adapter comments on `sessions.ts`/`driver.ts`
- [x] `pnpm test` (`recovery-matrix`, `recovery-crash`, `sessions`, `driver`) green with identical recovery reports; `pnpm check-boundaries` green

### M2: Restructure moves (history-preserving)
Source: `implementation.md` (M2)

- [x] Pure `git mv` commits with no content edits; splits separate from moves; `git log --follow` survives for `session-store.ts` — additive new file, no rename needed; `recovery.ts` stays as re-export per D-001 for one commit
- [x] `pnpm check-boundaries` green; `protocol` imports unchanged
- [x] Docs (`testing-with-fixtures.md`, `conformance-suites.md`) references updated if they named old paths — no old path references required update

## Summary
- Total features: 9
- Completed: 9
- Remaining: 0
- Current cutoff blockers: 0
- Accepted/deferred follow-up: 0
