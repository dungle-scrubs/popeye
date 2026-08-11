# Snapshot-size measurement report

This report measures full-transcript Snapshot payloads for D-017. The harness drives the in-process Driver. It encodes each final Snapshot with `SnapshotSchema`. The byte count is the UTF-8 size of `JSON.stringify` on the encoded Snapshot.

## Recorded workload

- Turn counts: 1, 10, 50, 200, 500, 1,000.
- Fixed ASCII content: 160 bytes per user message, 640 bytes per final assistant message, and 320 bytes per tool result.
- Tool rounds: every 10th turn calls `measure-payload` before the final assistant message.
- Compaction: sessions with at least 50 turns compact once at the midpoint. The summary is 640 bytes. Full-transcript Snapshots retain all Entries.
- Normalization: Entry IDs and the Session ID keep their production 16-byte length but use deterministic values. The workload has no timestamps.

## Thresholds

- Soft warning: 262,144 bytes (256 KiB). This marks the point where repeated authoritative Snapshot delivery needs monitoring.
- Hard concern: 1,048,576 bytes (1 MiB). At this size, every update serializes and transfers a material full-transcript payload. Pagination must bound repeated delivery.
- These are engineering policy thresholds. They are not protocol or transport limits.

## Measurements

| Turns | Tool turns | Compacted | Entries | Encoded bytes | Bytes/entry | Threshold |
| ---: | ---: | :---: | ---: | ---: | ---: | :--- |
| 1 | 0 | no | 3 | 1,231 | 410.3 | below warning |
| 10 | 1 | no | 23 | 11,429 | 496.9 | below warning |
| 50 | 5 | yes | 112 | 57,290 | 511.5 | below warning |
| 200 | 20 | yes | 442 | 226,029 | 511.4 | below warning |
| 500 | 50 | yes | 1,102 | 563,440 | 511.3 | soft warning |
| 1,000 | 100 | yes | 2,202 | 1,125,791 | 511.3 | hard concern |

The curve grows monotonically for this recorded workload. Bytes per Entry remain close across the range, so Entry count is a useful early estimate. Content length still controls the final encoded size.

## Pagination go/no-go

**Decision: GO - activate reserved entry-id pagination before snapshots reach the hard threshold.**

The first recorded crossing is 1,000 turns, 2,202 entries, and 1099.4 KiB.

Activation threshold: 1,048,576 encoded bytes (1 MiB) for one Snapshot. The 256 KiB threshold remains a warning. It does not activate pagination by itself.

The reserved `EntryRange` addressing is sufficient for the next protocol step. Activation must return a bounded Entry window while preserving `leafEntryId`, revision, and full-Snapshot authority for that window.

## Limits

This measurement uses fixed content sizes. Production transcripts with larger assistant messages or tool results reach the byte thresholds at fewer turns. Re-run this harness when the Entry envelope or Snapshot schema changes.
