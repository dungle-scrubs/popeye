# 06-journal-scale - Spike Guide

## Assumptions

### A-001: node:sqlite WAL atomicity

- **Impact if false:** Need JSONL-style torn-tail handling or explicit fsync loop; M2 changes shape.
- **Experiment:** Open `journal.sqlite` with `journal_mode=WAL`, `synchronous=NORMAL`; `BEGIN IMMEDIATE; INSERT entry;` kill before `COMMIT` vs kill after `COMMIT` with `wal_checkpoint`. Verify uncommitted invisible, committed durable, no truncation needed.
- **Pass criteria:** Kill before commit leaves 0 rows, kill after commit leaves 1 row, both reopen clean with structured diagnostic, no file rewrite.
- **Effort:** 0.5d

### A-002: Bytes/entry estimate for pagination

- **Impact if false:** Estimate-then-verify needs loop that shrinks window until byte bound met, not single verify; M4 cost grows.
- **Experiment:** Harness from `snapshot-size-report.md` with fixed content (511 bytes/entry) and variable content (5 KiB tool result) at 500 and 1000 turns; measure `JSON.stringify(SnapshotSchema.encode(snapshot))` UTF-8 bytes and track `entryCount * 511` error.
- **Pass criteria:** For fixed content, `abs(estimate - actual) / actual < 10%` and single verify picks window < 1 MiB. For 5 KiB entry, estimate error bounded and loop finds window in <= 2 iterations.
- **Effort:** 0.5d

### A-003: Fence takeover without mailbox change

- **Impact if false:** Adapter-core serialization must change or fencing moves to exclusive `BEGIN EXCLUSIVE` lock.
- **Experiment:** Two `Journal` handles on one `journal.sqlite`; first writes, second opens and does `UPDATE sessions SET fence=fence+1, owner_id=:o2`; first's next `persistLine` with `WHERE owner_id=:o1 AND fence=:f1` fails typed `JournalError`; second writes succeed.
- **Pass criteria:** Stale writer fails typed, new writer succeeds, no data loss, mailbox not changed.
- **Effort:** 0.5d
