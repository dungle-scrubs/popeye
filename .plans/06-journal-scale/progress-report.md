# 06-journal-scale - Progress Report

> Auto-generated from implementation plan. This is the canonical
> source of truth for what is done and what remains. Update this
> file as features are implemented - never mark a milestone complete
> until every current-cutoff checkbox under it is checked.

> Current focus: Phase 2 - Bounded Snapshot Pagination (M4/M5/M6 complete - ready for review)

## Phase 1: SQLite Journal Layer

### M1: SQLite DDL and persistence core
Source: `implementation.md` (M1); D-001, D-008

- [x] `packages/journal/src/sqlite.ts` exists and exports a `JournalPersistence` over `node:sqlite` <!-- D-008 -->
- [x] `sqlite/ddl.ts` creates `journal.sqlite` per journal directory <!-- D-001 --> with `sessions`, `entries`, `records` tables, rowid indices, `journal_mode=WAL`, `synchronous=NORMAL`
- [x] `persistLine` for one `JournalLine` runs in `BEGIN IMMEDIATE ... COMMIT` and ack only after durable commit
- [x] `loadSession` rebuilds `DerivedSession` - entries map keyed by `entryId`, records array, leaf via `leaf_moved` records, `branchToLeaf` matches JSONL
- [x] `initializeSession` inserts root entry in a transaction, `listSessions` enumerates from `sessions` table
- [x] `createJournalAdapter(initialState, sqlitePersistence)` constructs a `Journal` Tag with shared mailbox still serializing per session
- [x] Module comments state owns / why / not-responsible for `sqlite.ts` and helpers; no caller imports `node:sqlite` outside `packages/journal/src/sqlite*`

### M2: Fencing, WAL durability, and failure taxonomy

Source: `implementation.md` (M2)

- [x] Open acquires lease: `UPDATE sessions SET fence=fence+1, owner_id=:owner` or `INSERT` with `fence=1`; stored per session row
- [x] Every `persistLine` includes `WHERE owner_id = :owner AND fence = :fence` guard - stale writer fails typed `JournalError` with fencing corruption class
- [x] Second handle takeover test - first writer succeeds, second opens and bumps fence, first's next write fails typed, second's next write succeeds
- [x] Malformed JSON or schema mismatch on read fails `JournalError` `schema_mismatch`, never throws
- [x] Acknowledged invariant violation - duplicate `entry_id` / `record_id`, impossible parent chain via `compactionValidationIssue` - opens as `JournalError` with named corruption class, never repaired
- [x] Crash mid-transaction test - `BEGIN IMMEDIATE; INSERT` without `COMMIT` leaves 0 rows visible after reopen; committed prefix intact; no file truncation
- [x] Open emits structured diagnostic - file, `journal_mode`, action taken, corruption class if any - and spans carry `sessionId`, `fence`, `ownerId`
- [x] WAL policy documented: `journal_mode=WAL`, `synchronous=NORMAL`, `wal_checkpoint(TRUNCATE)` point named in module

### M3: Conformance and journal selection wiring

Source: `implementation.md` (M3); D-006

- [x] SQLite layer passes the exported `conformance` suite via `describeSqlite(makeSqlite)` alongside memory/JSONL - all M3/M4 behaviors green
- [x] CLI selection - env `PEYE_JOURNAL_LAYER=sqlite` or existence of `journal.sqlite` in `--session-dir` selects SQLite; otherwise JSONL; no auto-migration <!-- D-006 -->
- [x] `peye migrate` (or documented script) bulk-imports acknowledged JSONL lines into `journal.sqlite` when explicitly invoked; existing JSONL dirs untouched by default open
- [x] `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm check-boundaries` green; 10x flake on SQLite conformance + fencing tests

## Phase 2: Bounded Snapshot Pagination

### M4: Bounded Snapshot emission in SessionStore

Source: `implementation.md` (M4); D-002, D-003, D-004, D-005, D-007

- [x] `SessionStore.getSnapshot` (or driver snapshot fold) enforces encoded byte bound - default `1,048,576` bytes <!-- D-002 --> configurable via `PEYE_SNAPSHOT_PAGE_BYTES` <!-- D-003 --> with validation as positive integer
- [x] Size strategy is estimate-then-verify <!-- D-007 --> - `entryCount * ~511` picks leaf-anchored suffix candidate, then `JSON.stringify(SnapshotSchema.encode(snapshot))` UTF-8 size verifies under bound
- [x] When bound exceeded, emitted Snapshot is leaf-anchored suffix window under bound with `entryRange { afterEntryId, hasMoreBefore:true, ... }`, true `leafEntryId` and `revision` preserved
- [x] Configurable threshold harness - `PEYE_SNAPSHOT_PAGE_BYTES=10240` makes 10-turn workload paginate early; invalid env value fails typed
- [x] Single large Entry over bound delivered as one-entry Snapshot exceeding bound, with diagnostic naming the oversized entry <!-- D-004 -->
- [x] 256 KiB warning path - at ~563 KiB (500 turns fixture) Snapshot emits span attribute `snapshot.bytes` and structured diagnostic `snapshotWarning` but does not paginate <!-- D-005 -->
- [x] Pagination and warning logic lives in `snapshot/pagination.ts` or co-located module with owns/why/not-responsible comment; spans carry `revision`, `leafEntryId`, `entryCount`, `encodedBytes`, `isPaginated`, `entryRange`

### M5: get-snapshot range addressing and validation

Source: `implementation.md` (M5)

- [x] `get-snapshot { afterEntryId: A }` returns suffix `A+1 .. leaf` with correct `hasMoreBefore/After`; `{ beforeEntryId: B }` returns prefix; `{ afterEntryId: A, beforeEntryId: B }` returns slice `A+1 .. B-1`
- [x] Unknown `afterEntryId`/`beforeEntryId` rejects `JournalNotFound`; entry not on current branch rejects typed branch-membership error - never empty window
- [x] Reversed range (`firstIndex >= lastIndex`) rejects typed
- [x] Compaction-aware slicing - window that would require entries older than newest compaction on branch respects summarization; branch without that compaction unaffected
- [x] `EntryRange` round-trips through `SnapshotSchema` and `CommandSchema`; older decoder fixture ignoring `entryRange` stays green
- [x] `Progress` hints not paginated - `get-snapshot` pagination does not affect `subscribe-progress`

### M6: Heads reassembly and harness

Source: `implementation.md` (M6)

- [x] Heads (`rpc`, `print`, `json`) concatenate fetched windows in branch order when full transcript needed, but treat each Snapshot as authoritative per window and never merge `Progress` into stored state
- [x] Harness mirroring `snapshot-size-report.md` - fixed and variable content workloads assert 1) 500-turn stays below warning vs 1,000-turn paginates, 2) `leafEntryId`/`revision` preservation, 3) `get-snapshot` range round-trip, 4) older decoder ignores `entryRange`, 5) reassembly to full branch - stable across two runs
- [x] Soak: 3 interleaved sessions with bounded Snapshots, dropped subscriber, oversized frame keeps existing contracts

## Deferred follow-up

Source: `implementation.md` (Deferred)

- [ ] SQLite vacuum / export compaction
- [ ] npm-referenced Plugin packages
- [ ] Trust-gate allowlist layer
- [ ] TUI head (reserved)

## Summary

- Total features: 35
- Completed: 35
- Remaining: 0
- Current cutoff blockers: 0
- Accepted/deferred follow-up: 4
- Superseded/obsolete checklist debt: 0
