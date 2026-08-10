---
status: accepted
---

# The journal is the only durable session representation

peye's session state is an append-only journal of entries (conversation
tree) and records (operation journal); snapshots and model context are
pure folds of a branch, and streamed progress is a hint that is never
folded into state. We chose this after a full source analysis of pi
0.84.1, whose shipped stack maintains agent state, persistence, and wire
payloads as separate structures kept consistent by pointer identity and
in-place mutation - the debt its own unfinished harness-v2 design was
written to cure. Branching, compaction, crash recovery, replay, and
test fixtures all become operations on the one representation instead of
sibling features.

## Considered options

- pi's shipped shape (mutable agent state + separate session file +
  wire DTOs): rejected; it is the debt being designed away.
- Single item type with a visibility flag instead of entries + records:
  rejected; conversation items and operation items have different
  lifecycles, validation rules, and readers.

## Consequences

- The current leaf position must itself be journaled (a leaf-moved
  record), or it would not survive restart.
- Nothing acknowledged is ever rewritten; recovery truncates only
  unacknowledged torn tails and rejects (never repairs) corrupted
  record sequences.
- Heads may drop or miss progress with no correctness cost; they re-read
  the snapshot.
