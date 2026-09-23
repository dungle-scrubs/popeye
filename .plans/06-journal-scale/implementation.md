## ⚠️ Execution Protocol

A progress report exists at `.plans/06-journal-scale/progress-report.md`. It lists
every user-facing feature for every milestone as a checkbox.

**Mandatory rules for all agents working on this plan:**

1. Before starting a milestone, run `plan-db check-progress --plan
   "06-journal-scale"` and read its section in the progress report - those
   current-cutoff checkboxes are your spec
2. Check each box as you complete the feature, not at the end
3. A milestone is NOT done until every current-cutoff checkbox under
   it is checked
4. If you find features missing from the report, add them first
5. Never declare a phase complete without updating the current focus
   marker and Summary
6. Deferred follow-up and superseded/obsolete checklist debt must not
   be counted as current blockers
7. Fully deferred/tabled sections must be moved under Deferred follow-up;
   empty active sections must not remain between completed/current sections
8. `FP-<number>` references must be backed by real progress-report sections
   and checkboxes, not merely named

# 06-journal-scale - Implementation Plan

## 0. Hard Dependencies

None - this plan extends `00` foundations without blocking on external work. `01`-`05` are at `complete`.

## 1. Architecture

### System shape

This plan lands two deferred v1 primitives in order. Phase 1 adds the SQLite `Journal` layer behind the existing `Journal` tag; Phase 2 activates bounded `Snapshot` pagination. Both preserve the append-only invariant and the `Snapshot` authoritative / `Progress` hint contract.

```
packages/journal/src/
  adapter-core.ts  -- createJournalAdapter (unchanged, shared mailbox)
  journal.ts       -- Journal Tag + branchToLeaf (unchanged)
  memory.ts        -- Layer 1
  jsonl.ts         -- Layer 2
  sqlite.ts        -- NEW Layer 3 (this plan, Phase 1)
  sqlite/*.ts      -- DDL, fencing, helpers co-located

packages/protocol/src/
  snapshot.ts      -- Snapshot + EntryRange (already has entryRange)
  commands.ts      -- get-snapshot range (already has after/before)

packages/journal + kernel SessionStore
  SessionStore  -- range-aware Snapshot emission (Phase 2)
```

Dependency rules: only `packages/journal/src/sqlite*` may import `node:sqlite` <!-- D-008 --> D-008; only the ai seam imports `pi-ai`; `protocol` has no kernel dependency.

### Key Constraints

| Constraint | Impact |
|---|---|
| Node >=24 with `node:sqlite` | No native addon, sync API wrapped in Effect |
| Single-writer per session | Still enforced by `adapter-core` TSemaphore; SQLite fencing is persistence-local, not a second lock |
| Append-only: acknowledged lines never rewritten | SQLite transactions are atomic commits, not rewrites; diagnostics mirror JSONL |
| Snapshot authority | Every paginated Snapshot carries true `leafEntryId` + `revision` for its window |
| 1 MiB hard threshold configurable | Default 1,048,576 bytes, env `POPEYE_SNAPSHOT_PAGE_BYTES` overrides <!-- D-003 -->; 256 KiB warning never triggers pagination |

### Boundaries

* `Journal` is the seam. SQLite implements `JournalPersistence` - `initializeSession`, `persistLine`, `loadSession` - and is constructed via `createJournalAdapter`. All callers use the `Journal` Tag; no caller touches `node:sqlite` directly.
* SQLite file is one `journal.sqlite` per journal directory <!-- D-001 --> D-001, WAL mode, `fence` + `owner_id` columns per `sessions` row for takeover invalidation.
* Pagination is a wire bound, not a context bound. Context fold stays budgeting model messages; Snapshot pagination bounds `JSON.stringify(SnapshotSchema.encode(snapshot))` UTF-8 bytes.
* `SessionStore` is the owner of snapshot emission and range validation. Heads do not invent windows - they request via `get-snapshot` and reassemble by concatenating windows in branch order.

Module comments will state for each target file what it owns, why it exists, and what it does not own.

### Observability

Phase 1 (SQLite) `required`: spans for `journal.open` / `journal.persistLine` / `journal.loadSession` with `sessionId`, `fence`, `ownerId`, corruption class on failure; structured diagnostics on open (file, action, corruption). Phase 2 (pagination) `required`: spans for `snapshot.emit` with `revision`, `leafEntryId`, `entryCount`, `encodedBytes`, `isPaginated`, `entryRange`; warning diagnostic at 256 KiB <!-- D-005 --> and pagination diagnostic at threshold. Failures correlate via `sessionId` + `revision`.

## 2. Phases

### Phase 1: SQLite Journal Layer

**Goal:** A third `Journal` layer passes the full conformance suite and makes an explicit `--journal-layer sqlite` (or dir-detected) selection without auto-migrating JSONL <!-- D-006 -->.

**Gate from previous:** RFC-06 reviewed, D-001..D-008 recorded.

#### M1: SQLite DDL and persistence core

- **Dependencies:** none
- **Effort:** M (3-7d)
- **Testing:** test-first
- **Observability:** required (open/persist spans + structured diagnostics)
- **Tasks:**
  1. Seams under test: `Journal` Tag via `JournalPersistence` (`initializeSession`, `persistLine`, `loadSession`), `DerivedSession` reconstruction
  2. RED: DDL creates `journal.sqlite` with `sessions(id, fence, owner_id)`, `entries(session_id, entry_id, parent_id, kind, payload_json, rowid)`, `records(...)`, indices, `journal_mode=WAL`, `synchronous=NORMAL`
  3. GREEN: Implement `packages/journal/src/sqlite.ts` + `sqlite/ddl.ts` implementing `JournalPersistence` over `node:sqlite` <!-- D-008 -->, one file per directory <!-- D-001 -->
  4. RED: `persistLine` transaction commits atomically, acknowledged only after durable write (WAL checkpoint semantics), `loadSession` rebuilds entries map + leaf via `leaf_moved` records
  5. GREEN: Wire `createJournalAdapter(initialState, sqlitePersistence)` path
  6. REFACTOR: Extract fencing and WAL helpers to `sqlite/fencing.ts`, add module comments owns/why/not-responsible

#### M2: Fencing, WAL durability, and failure taxonomy

- **Dependencies:** M1
- **Effort:** M
- **Testing:** test-first
- **Observability:** required (fence takeover spans, corruption class)
- **Tasks:**
  1. Seams under test: open/lease acquisition, write with `WHERE owner_id AND fence`, corruption paths
  2. RED: Second process takeover increments `fence`, stale writer's next `persistLine` fails typed `JournalError` (lease invalid), not silent
  3. GREEN: Implement open lease `UPDATE fence=fence+1, owner_id=:owner` / `INSERT`, and per-write fencing guard
  4. RED: Malformed JSON / schema mismatch on read fails `JournalError` `schema_mismatch`; acknowledged invariant violation (duplicate entry_id, impossible parent chain) opens as `JournalError` with named corruption class, never repaired
  5. GREEN: Add corruption detection on `loadSession`, matching JSONL taxonomy
  6. RED: Crash mid-transaction - uncommitted rows invisible after reopen (no torn tail truncation needed), acknowledged prefix intact
  7. GREEN: Ensure transactions `BEGIN IMMEDIATE ... COMMIT`, verify with in-process kill simulation
  8. REFACTOR: Document fsync / `wal_checkpoint(TRUNCATE)` policy in module comment

#### M3: Conformance and journal selection wiring

- **Dependencies:** M1, M2
- **Effort:** S (1-3d)
- **Testing:** test-first
- **Observability:** none (wiring, diagnostics already covered)
- **Tasks:**
  1. Seams under test: `conformance` suite parameterized by SQLite layer, CLI `--journal-layer` / dir detection
  2. RED: `packages/journal/src/conformance` run with `makeJournalSqlite()` fails until M1/M2 complete; JSONL and memory still green
  3. GREEN: Register conformance: `describeSqlite( makeSqlite )` alongside `describeMemory` / `describeJsonl`; all M3/M4 behaviors green - create, branchToLeaf, append entry/record, moveLeaf, readBranch isolation, leaf rebuild after close/reopen, two sessions isolated, migration chain
  4. RED: CLI selection - `POPEYE_JOURNAL_LAYER=sqlite` or presence of `journal.sqlite` selects SQLite layer; absent selects JSONL; explicit `popeye migrate` required for JSONL-to-SQLite bulk import <!-- D-006 -->
  5. GREEN: Wire `packages/cli/src/entry` journal factory: detect flag/env/file, construct correct `JournalPersistence`, document in README; no auto-migration path
  6. Verify: `pnpm check-boundaries` green, `pnpm test` full suite green, 10x flake run on SQLite conformance

### Gate 1->2

- [ ] SQLite layer passes full conformance suite plus fencing, WAL, crash tests
- [ ] No auto-migration: fresh JSONL dirs stay JSONL, `journal.sqlite` selection explicit
- [ ] `pnpm test` + `pnpm check-boundaries` + `pnpm typecheck` green
- [ ] Open/persist diagnostics visible in structured logs

### Phase 2: Bounded Snapshot Pagination

**Goal:** No Snapshot is delivered above the configured bound (default 1 MiB) except a single oversized Entry <!-- D-004 -->, every paginated Snapshot carries `entryRange` + true `leafEntryId` + `revision`, and `get-snapshot` range fetches are validated.

**Gate from previous:** SQLite gate passed.

#### M4: Bounded Snapshot emission in SessionStore

- **Dependencies:** Gate 1->2
- **Effort:** M
- **Testing:** test-first
- **Observability:** required (snapshot.emit spans, 256 KiB warning <!-- D-005 -->, pagination diagnostic)
- **Tasks:**
  1. Seams under test: `SessionStore.getSnapshot` / driver snapshot fold, `SnapshotSchema.encode` byte measurement, `EntryRange` flags
  2. RED: Harness from `snapshot-size-report.md` - 500 turns (~563 KiB) stays full Snapshot below threshold; 1,000 turns (~2,202 entries, ~1.1 MiB) emits paginated Snapshot - `entries` is leaf-anchored suffix under threshold, `entryRange` has `hasMoreBefore=true`, `leafEntryId` matches branch leaf, `revision` authoritative <!-- D-002 --><!-- D-003 -->
  3. GREEN: Implement threshold config `POPEYE_SNAPSHOT_PAGE_BYTES` with default 1,048,576 <!-- D-003 -->, validated as positive integer; size strategy estimate-then-verify - `entryCount * ~511` picks candidate window then `JSON.stringify(SnapshotSchema.encode(snapshot))` UTF-8 verify <!-- D-007 -->
  4. RED: Threshold configurable - set env to 10 KiB, 10-turn workload paginates early; invalid env value fails typed with diagnostic
  5. GREEN: Add env reading in `SessionStore` construction / factory, plumb through `packages/cli/src/entry` config
  6. RED: Single Entry over bound - craft a 2 MiB tool-result entry, expect Snapshot with that single Entry exceeding threshold, `entryRange` set, diagnostic names the oversized entry <!-- D-004 -->
  7. GREEN: Handle single-large-Entry branch: window is that Entry alone, still authoritative
  8. RED: 256 KiB warning - at ~500 turns Snapshot emits `snapshot.warning` diagnostic and `snapshot.bytes` span attribute but does not paginate <!-- D-005 -->
  9. GREEN: Wire warning emission alongside pagination logic
  10. REFACTOR: Extract `snapshot/pagination.ts` with window selection + byte measurement, module comment owns/why/not-responsible

#### M5: get-snapshot range addressing and validation

- **Dependencies:** M4
- **Effort:** S
- **Testing:** test-first
- **Observability:** required (range request spans, typed rejections)
- **Tasks:**
  1. Seams under test: `Command get-snapshot { afterEntryId, beforeEntryId }`, `Snapshot` `entryRange` round-trip, `SessionStore` range read
  2. RED: `get-snapshot { afterEntryId: A }` returns suffix window `A+1 .. leaf` with correct `hasMoreBefore/After`; `{ beforeEntryId: B }` returns prefix; `{ afterEntryId: A, beforeEntryId: B }` returns bounded slice `A+1 .. B-1`
  3. GREEN: Implement range slicing over branch order with indexed `entries` lookup, validate branch membership
  4. RED: Unknown `afterEntryId` / `beforeEntryId` rejects `JournalNotFound`; entry not on current branch rejects typed drift error (not silent empty window)
  5. GREEN: Add validation rejecting reversed range and respecting compaction windows (newest compaction on branch, summarized entries not needed)
  6. RED: `Progress` hints are not paginated; `get-snapshot` pagination does not affect `subscribe-progress`
  7. GREEN: Document that `entryRange` is optional and ignored by older decoders
  8. Verify: `packages/protocol/src/snapshot.test.ts` and `decoding.test.ts` cover `EntryRange` round-trip; older-decoder fixture ignores `entryRange`

#### M6: Heads reassembly and harness

- **Dependencies:** M4, M5
- **Effort:** S
- **Testing:** test-after (head wiring, harness verification - DOM/render assertions brittle test-first)
- **Prototyping:** none
- **Tasks:**
  1. Implement head reassembly: `RpcTransport` + `print/json` heads concatenate fetched windows in branch order when full-transcript rendering or export is needed, but treat each Snapshot as source of truth and never merge `Progress` into stored state
  2. Verify: Reproduce via harness mirroring `snapshot-size-report.md` - fixed and variable content workloads assert 1) 500-turn vs 1,000-turn pagination activation, 2) `leafEntryId`/`revision` preservation, 3) `get-snapshot` range round-trip through `SnapshotSchema`, 4) older decoder ignores `entryRange`, 5) reassembly concatenates windows to full branch; all harnesses stable across two runs
  3. Verify: `pnpm test` full suite green, snapshot pagination soak with 3 interleaved sessions and bounded snapshots keeps contracts

### Gate 2->Ready

- [ ] No Snapshot above configured bound except single-oversized-Entry case, all paginated Snapshots authoritative per window
- [ ] `get-snapshot` range validated typed, compaction-aware
- [ ] `estimate-then-verify` keeps Snapshot emission under bound without full-branch encode when below threshold
- [ ] `pnpm test` + `pnpm typecheck` + `pnpm lint` + `pnpm check-boundaries` green

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---|---|---|---|
| SQLite fencing diverges from adapter-core mailbox invariant | high | low | Fencing in persistence only; mailbox still serializes per session; conformance + fence-takeover test | kernel |
| Misconfigured threshold (too low/high) creates extra hops or defeats bound | medium | medium | Default 1 MiB per report; configurable but validated positive int; docs + harness at 10 KiB for tests | protocol |
| Byte measurement cost on every Snapshot | medium | medium | Estimate-then-verify <!-- D-007 --> avoids full encode when below bound | kernel |
| Single huge Entry still exceeds wire bound | low | low | Deliver anyway with diagnostic <!-- D-004 --> preserves authority; no truncation | protocol |
| Range validation O(branch) | low | medium | Indexed lookup but must check branch membership for correctness | journal |

## 4. Escape Hatches

1. **If SQLite fencing proves unstable with `node:sqlite` sync API under Effect fibers:** Ship SQLite without fence-takeover in v1 (single writer per process only), document fence as follow-up, gate 1->2 adjusted to single-writer conformance.
2. **If Snapshot encode cost still dominates:** Switch to incremental size accounting cached per branch mutation, fallback to verify on suffix window only.

## 5. Landing Strategy

| Field | Value |
|-------|-------|
| Merge target | `main` |
| Branch model | one branch `06-journal-scale` |
| PR cadence | PR per phase (Phase 1 SQLite, Phase 2 pagination) |
| Independent reviewer | codex review for substantive work, human |
| Ship mechanism | manual PR |

## 6. Progress Report Accounting

Progress report is at `.plans/06-journal-scale/progress-report.md` once CONSOLIDATE generates it. Until then this implementation.md plus plan.db are source of truth. Current cutoff is Phase 1 M1.

## 7. Validation Commands

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm check-boundaries
# plan-scoped
pnpm --filter @popeye/journal test -- conformance
POPEYE_SNAPSHOT_PAGE_BYTES=10240 pnpm test -- snapshot pagination harness
```

## 8. Decisions

Canonical: `plan.db` `query-decisions --plan 06-journal-scale`. Inline markers:

* D-001 per-directory `journal.sqlite` per journal directory
* D-002 hard activation at encoded >1 MiB, 256 KiB warning-only
* D-003 configurable via `POPEYE_SNAPSHOT_PAGE_BYTES`, default 1,048,576
* D-004 single large Entry delivered as one-entry Snapshot with diagnostic
* D-005 256 KiB warning as span + structured diagnostic
* D-006 no auto-migration, explicit flag/migrate command
* D-007 estimate-then-verify measurement
* D-008 `node:sqlite` built-in
