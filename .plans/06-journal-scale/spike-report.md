# 06-journal-scale - Spike Report

## A-001: node:sqlite WAL atomicity

**Status:** pass
**Evidence:** `node:sqlite DatabaseSync` with `PRAGMA journal_mode=WAL`, `synchronous=1` (NORMAL): `BEGIN IMMEDIATE; INSERT` uncommitted row invisible to second handle (0 rows), after `COMMIT` visible (1 row). No torn tail, no truncation. Matches JSONL ack contract without file rewrite.

## A-002: Bytes/entry estimate for pagination

**Status:** pass
**Evidence:** Report harness at 511 bytes/entry: 500 turns 1102 entries error 0.1% vs 563,440 actual, 1000 turns 2202 entries error 0.1% vs 1,125,791 actual. 1-turn error 24.5% at small branch but single verify corrects. For variable 5 KiB tool result, estimate error bounded and loop finds window in <= 2 iterations per M4 spec.

## A-003: Fence takeover without mailbox change

**Status:** pass
**Evidence:** Simulated `UPDATE fence=fence+1, owner_id=:o2` takeover increments fence 1->2. Stale writer with `WHERE owner=o1 AND fence=1` fails, fresh writer with `o2,2` succeeds. No adapter-core change needed; fencing stays persistence-local.
