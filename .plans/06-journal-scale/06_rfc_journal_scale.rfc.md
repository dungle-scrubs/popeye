---
number: 06
title: "Journal scale - SQLite layer and bounded Snapshot pagination"
type: feature
status: Draft
author: Kevin Frilot
date: 2026-08-12
---

# RFC-06: Journal scale - SQLite layer and bounded Snapshot pagination

## Abstract

Headless v1 is complete with two `Journal` layers behind one `Effect` tag - memory and JSONL - and a protocol that reserves entry-range pagination. This RFC adds the two deferred v1 scale primitives: a SQLite `Journal` layer that makes large, long-lived sessions durable without JSONL quirks, and bounded `Snapshot` pagination that keeps the authoritative wire payload under the 1 MiB hard threshold measured in `snapshot-size-report.md`. SQLite is Phase 1, pagination is Phase 2; both reuse existing contracts and neither changes the journal's append-only semantics.

## Introduction

### Problem

Two deferred items block durability and scale before a TUI head makes sense:

1. JSONL is the only durable `Journal` layer. It truncates torn tails on open and passes the conformance suite, but it has no fencing for multi-process access, no indexed reads, and no transaction around a multi-line intent. Long sessions grow linearly - the snapshot-size harness shows 2,202 entries at ~1.1 MiB encoded for 1,000 turns - and every `Snapshot` delivery resends the full transcript.

2. `Snapshot` pagination is reserved in the schema `EntryRange` / `afterEntryId` / `beforeEntryId` plus `get-snapshot` range fields, but no code enforces a byte bound. Heads therefore have no way to stay under the 256 KiB warning / 1 MiB hard thresholds without dropping authority.

### Scope

In scope:

* A SQLite `Journal` layer implementing the existing `Journal` / `JournalPersistence` / `JournalAdapterState` surface from `packages/journal/src/adapter-core.ts` and passing the exported conformance suite. Single-writer mailbox and recovery semantics stay in `adapter-core` and `SessionStore`.
* DDL, lease fencing, and WAL durability for the layer.
* Bounded `Snapshot` pagination: enforcing the 1 MiB activation threshold, returning `entryRange` windows, `get-snapshot` range addressing, and head-side reassembly that preserves `leafEntryId`, `revision`, and snapshot authority.

Out of scope:

* A TUI head - deferred to a later plan; pagination makes the TUI viable but is not the TUI.
* npm-referenced plugin packages, trust-gate allowlist layer, vacuum/compaction export.
* Changing the journal's append-only rules, the failure taxonomy, or the protocol's snapshot-authoritative invariant.

### Context

Normative background: `CONTEXT.md` vocabulary, `docs/adr/0001-journal-is-the-only-representation.md`, `docs/research/pi-analysis.md` section 6 on pi's SQLite fenced leases, `packages/cli/test-fixtures/snapshot-size-report.md` thresholds, and the `Snapshot` / `EntryRange` schemas in `packages/protocol/src/snapshot.ts`. Plans `00` through `05` are at `complete` - journal foundations, conformance, JSONL, `SessionStore`, and kernel deepening are done. Decisions D-001..D-008 in the plan ledger bind this RFC and are cited inline where they govern.

## Terminology

Domain terms Session, Journal, Entry, Record, Branch, Leaf, Compaction, Snapshot, Context, Progress, Kernel, Turn, Plugin, Head, Protocol are defined in `CONTEXT.md` and normative. Added here:

* **Layer** - one `JournalPersistence` implementation behind `createJournalAdapter`.
* **Fence** - monotonic integer in SQLite that invalidates a stale writer on takeover.
* **Entry window** - a contiguous slice of the branch identified by `afterEntryId` / `beforeEntryId` with `hasMoreBefore` / `hasMoreAfter`.
* **Authority** - `Snapshot` is authoritative at `revision`; `Progress` is a disposable hint.

## Motivation

1. Durability before presentation. A TUI that renders `Snapshot` keeps the failure mode of every other head if the journal is not safely durable. SQLite gives transactional appends, indexed `readBranch` / `readRecords`, and fencing that JSONL cannot.

2. Bounded wire. Repeated full-transcript snapshots at 1 MiB dominate serialization and transport. Reserved pagination already exists in the protocol - activating it before the hard threshold is the decision recorded in the snapshot-size report.

3. Containment. SQLite is isolated behind `JournalPersistence` and validated by the conformance suite. Pagination is cross-cutting but bounded to `protocol`, kernel snapshot emission, and heads. Doing SQLite first keeps pagination's benefit after the journal can durably hold many entries.

## Design

### Module topology

No new package. SQLite lives in `packages/journal` alongside `memory.ts` and `jsonl.ts` behind the same `Journal` tag:

```
packages/journal/src/
  adapter-core.ts   -- shared validation, serialization, cache (unchanged)
  journal.ts        -- Journal Tag, DerivedSession, branchToLeaf
  memory.ts         -- existing Layer
  jsonl.ts          -- existing Layer
  sqlite.ts         -- new Layer (this plan)
  sqlite-*.ts       -- DDL / fencing helpers (co-located)
  conformance/      -- suite, parameterized by Journal layer
```

Paginated snapshots touch:

```
packages/protocol/src/snapshot.ts   -- EntryRange already there
packages/protocol/src/commands.ts   -- get-snapshot range already there
packages/kernel/src/sessions.ts     -- via SessionStore, range reads
packages/cli/src/heads/*            -- bounded emission / reassembly
```

Dependency rules from v1 remain: `protocol` has no kernel dependency, only `packages/journal/src/*` may import `node:sqlite` <!-- D-008 --> D-008, only the ai seam imports `pi-ai`.

### Phase 1: SQLite Journal Layer

#### Persistence shape

Reuse `adapter-core.createJournalAdapter`. SQLite implements `JournalPersistence`:

* `initializeSession(sessionId, rootEntry)` - insert root entry in a transaction.
* `persistLine(sessionId, line)` - append one `JournalLine` in a transaction, fsync via WAL checkpoint semantics, then ack.
* `loadSession(sessionId)` - reconstruct `DerivedSession` from ordered rows, applying `leaf_moved` records to compute `leaf`.
* No direct `Journal` method owns fencing - fencing is a property of the SQLite persistence and its open operation.

#### Schema

One SQLite file per journal directory <!-- D-001 --> D-001 - `journal.sqlite` at the journal directory root - DDL has three canonical tables plus derived caches only if proven necessary:

* `sessions(id TEXT PRIMARY KEY, fence INTEGER NOT NULL, owner_id TEXT NOT NULL, created_at INTEGER)`
* `entries(session_id TEXT, entry_id TEXT, parent_id TEXT, kind TEXT, payload_json TEXT, rowid INTEGER PRIMARY KEY AUTOINCREMENT, UNIQUE(session_id, entry_id))`
* `records(session_id TEXT, record_id TEXT, kind TEXT, payload_json TEXT, rowid INTEGER PRIMARY KEY AUTOINCREMENT, UNIQUE(session_id, record_id))`

Secondary index `entries(session_id, rowid)` and `records(session_id, rowid)` preserve insertion order. No content is rewritten. Payloads are stored as JSON text validated by the existing `Schema` codecs on read.

If a derived cache is added later, DDL comments mark canonical vs derived tables per pi analysis.

#### Fencing and WAL

* Open takes a lease: `UPDATE sessions SET fence = fence + 1, owner_id = :owner WHERE id = :id` if row exists, otherwise `INSERT`. Subsequent writes include `WHERE owner_id = :owner AND fence = :fence` - a stale owner cannot resume after a takeover.
* `journal_mode = WAL`, `synchronous = NORMAL` with explicit `fsync` on commit via `sqlite` checkpoint or `PRAGMA wal_checkpoint(TRUNCATE)` policy documented in the module. The layer is acknowledged only after durable write, same contract as JSONL `ack`.
* Torn tail handling is unnecessary - SQLite transactions are atomic. Crash recovery loads the last committed prefix. No file truncation.

#### Failure and corruption

* Malformed JSON or schema mismatch on read fails typed `JournalError` - never throws.
* An acknowledged record sequence violating single-writer invariants - for example duplicate `entry_id` or impossible parent chain - opens as `JournalError` with a named corruption class, matching JSONL behavior. Never repaired silently.
* Structured diagnostics on open - file, action taken, corruption class if any.

#### Conformance

The exported conformance suite is the contract. SQLite MUST pass every M3/M4 behavior - create, append entry, append record, move leaf via `leaf_moved` record, branch read, record isolation, leaf reconstruct from records after close/reopen, two sessions isolated, duplicate ids stable, migration chain, and budget-unfittable paths when exercised through `Journal`.

### Phase 2: Bounded Snapshot pagination

#### Thresholds

From `snapshot-size-report.md`:

* soft warning 262,144 bytes (256 KiB) - monitoring only, does not activate pagination <!-- D-005 --> D-005
* hard concern 1,048,576 bytes (1 MiB) - activation threshold for one encoded `Snapshot` <!-- D-002 --> D-002 <!-- D-003 --> D-003

Byte count is UTF-8 size of `JSON.stringify` on `SnapshotSchema.encode`. The layer that enforces the bound MUST measure the same encoding; `Bytes/entry` is ~511 for the fixed-content harness, so entry count is a useful early estimate but the bound is on encoded bytes. Threshold is configurable via `POPEYE_SNAPSHOT_PAGE_BYTES` with default 1,048,576 <!-- D-003 --> D-003; estimate-then-verify is the measurement strategy <!-- D-007 --> D-007.

#### Snapshot change

`Snapshot` already has:

```ts
entries: Entry[]
entryRange?: { afterEntryId, beforeEntryId, hasMoreAfter, hasMoreBefore }
leafEntryId: EntryId
revision: number
```

Pagination keeps snapshot authority: a paginated `Snapshot` is authoritative for its window at `revision` and carries the true `leafEntryId` even when the leaf entry is outside the window. `hasMoreBefore` / `hasMoreAfter` signal that the branch extends beyond the window.

Kernel `SessionStore.getSnapshot` or the driver snapshot fold gains range-aware emission:

* default - if encoded size <= threshold, emit the full branch as today
* bounded - if encoded size would exceed threshold, emit the suffix window that fits under threshold, anchored at the leaf <!-- D-003 --> D-003, with `entryRange` set and `entries` being the window. Earlier windows are available via `get-snapshot { afterEntryId, beforeEntryId }`. If a single Entry alone exceeds the bound, deliver it anyway as a one-entry Snapshot with diagnostic <!-- D-004 --> D-004.

No snapshot is ever delivered above the threshold except the single-large-Entry case. The 256 KiB warning is exposed as both span attribute and structured diagnostic <!-- D-005 --> D-005, not as a pagination trigger.

#### Command and head behavior

`get-snapshot` already carries `afterEntryId` / `beforeEntryId`. Semantics:

* absent range means leaf-anchored bounded window as above
* `afterEntryId` / `beforeEntryId` request a specific window in branch order, validated against the branch - unknown entry id rejects typed `JournalNotFound`, non-branch entry rejects typed.
* `subscribe-progress` and `Progress` stay ephemeral hints - they are not paginated.

Heads reassemble by concatenating windows in branch order when they need the full transcript for rendering or export, but they MUST treat each `Snapshot` as the source of truth for its window and MUST NOT merge `Progress` into stored state.

#### Interaction with compaction and context

Compaction is an `Entry` on the branch, so windowing respects it: a window that starts inside a summarized span does not need entries older than the newest compaction on that branch, matching the context fold rule. The `Context` fold already budgets model messages - snapshot pagination is a wire bound, not a context bound.

## Alternatives considered

* **Extend JSONL with an index file** - rejected; still needs fencing and indexed range reads, which SQLite provides.
* **Compress snapshots instead of paginating** - compression is orthogonal; it does not bound repeated delivery of a large transcript and hides the authority boundary.
* **Paginate before SQLite** - would improve wire even on JSONL, but the larger durability win and the fencing needed for long-lived sessions come from SQLite; ordering SQLite first makes pagination's test surface more realistic.
* **New pagination protocol** - rejected; `EntryRange` + `get-snapshot` range are sufficient, and the plan stays compatible with older decoders that ignore `entryRange`.

## Risks

* SQLite writer lease fencing must not change `adapter-core`'s single-writer mailbox invariant - fencing is persistence-local, mailbox serialization stays.
* Measuring encoded bytes on every snapshot fold could be expensive - mitigate by estimate-then-verify <!-- D-007 --> D-007.
* Range window validation must remain O(branch length) worst case - mitigate with indexed lookup, but correctness requires branch existence check.

## Testing

* SQLite layer passes the full journal conformance suite as a parameterized run, plus SQLite-specific tests for WAL durability, fence takeover, and crash-recovery atomicity.
* Pagination has a harness mirroring `snapshot-size-report.md`: fixed and variable content workloads asserting that 1) snapshots at 500 turns stay below warning, at 1,000 turns paginate, 2) `entryRange` flags and `leafEntryId` are correct, 3) `get-snapshot` range round-trips through `SnapshotSchema`, 4) older decoders ignore `entryRange`.

## Rollout

Phases ship separately - SQLite behind a `--journal-layer sqlite` or directory-detected selection that does not affect existing JSONL journals <!-- D-006 --> D-006, pagination as an additive `entryRange` that older decoders ignore. Neither change requires journal file migration.

## Open questions

None - D-001, D-005, and D-006 resolved the placement and warning-surface questions; remaining work is decomposition.
