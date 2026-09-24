# Popeye journal to HCN transcript mapping contract (RFC-02 P3)

Reader-arm contract for `harness-cli-normalizer`. It maps popeye journal
files to HCN source/result/record envelopes. No popeye-side export
surface exists by design: HCN reads the journal directly.

Normative HCN shapes: `ResultEnvelope`, `SourceEnvelope`, `RecordEnvelope`
in `harness-cli-normalizer/src/knowledge/transcript/wire.ts`.
Normative popeye shapes: `JournalHeader`, `EntryLine`, `RecordLine` in
`packages/journal/src/journal.ts` and `packages/journal/src/shapes.ts`.

## Source file

One session is one file: `<sessionId>.jsonl` under the journal directory.
Line 1 is the header (`type journal_header`, `format popeye_journal`,
`version 1`). Remaining lines are `entry` or `record` lines, each carrying
its `sessionId`, which MUST equal the header sessionId.

The passive export read is `Journal.readExport` (`packages/journal/src/journal.ts`):
header, acknowledged lines in durable order, `sizeBytes` from file stat,
and `incompleteTail` when the final line is unterminated. It never writes.
Popeye-native reads keep the repair path (`recovered_torn_tail`).

## Session envelope

The reader emits two HCN shapes from the export read: listing rows
(`cwd`, `lastWriteAt`, `startedAt`, `mode`, `readable`, `blocked` per
the HCN listing rules) and the `SourceEnvelope` below.

- `selection`: `{ kind: "file", value: <path> }`. `--id` resolution is out
  of scope: popeye session ids are file stems, not native conversation ids.
- `conversation.nativeId`: the header sessionId.
- `sources[0]`: `{ key: "source-0", kind: "file", location: <path>,
  formatId: "popeye_journal", formatVersion: "1" }`.
- `nativeHeaders[0]`: `{ sourceKey: "source-0", original: <header line> }`.
- `cwd`: null (unmarked scope). No journal line carries a workspace.
- `lastWriteAt`: file mtime. `sizeBytes`: from `readExport.sizeBytes`.
  `startedAt`: null. `mode`, `readable`, `blocked`: per HCN listing rules.

## Record envelopes

One envelope per acknowledged line. `sourceKey` is `source-0`.
`position` is `{ sourceKey: "source-0", unit: "entry-index",
value: <0-based line ordinal> }`. `originalKind` is `saved-record`.
`original` is the raw journal line. `nativeId` is the entry or record id.

Normalized kind and role:

| journal line | normalized kind | role |
|---|---|---|
| entry kind `message`, payload role `user` | message | user |
| entry kind `message`, payload role `assistant` | message | assistant |
| entry kind `message`, payload role `toolResult` | tool-result | tool |
| entry kind `compaction` | compaction | null |
| record any kind | metadata | null |
| entry kind `session_root` | metadata | null |

`timestamp` is always null: journal lines carry no timestamps.
`parent-entry` relationship follows `parentId` (`state none` when null).
Tool-result entries carry a `tool-call` relationship on `toolCallId`.
Compaction entries carry `first-kept-entry` from the first retained tail
id, or `state none` when `retainedTailIds` is empty. All other
relationships are `unknown`.

Parts: message content maps to one text part with the payload path as
`originalPath`. Assistant `toolCalls` map to tool-call parts. Compaction
`summary` maps to one text part. Record payloads map to no parts
(`contentStatus` n/a: metadata kind carries the original only).

## Coverage

- `history`: complete. Every retained entry is in the file.
- `branches`: limited. `leaf_moved` records mark branch points, but only
  the current branch prefix is a live view; superseded branches are unknown.
- `original-records`: limited. Entry payloads are preserved verbatim in
  `original`, but there is no native id beyond the popeye id.
- `embedded-content`: unavailable. Journal payloads are text only.

Refusals for unaccepted limits MUST carry `requiredAcceptedLimits`
naming the missing opt-ins, per the HCN refusal shape.

## Bookmarks

Bookmark envelope: base64url JSON
`{ bookmarkVersion: 1, methodId: "popeye-journal", conversationId,
digest, offset, entries }`. `offset` is the byte offset of the next
unread line; `entries` is the count of envelopes returned. `digest` is
the hex sha256 of the first `offset` bytes of the file. Continuation
recomputes the digest over the first `offset` bytes of the current file
and revalidates: mismatch refuses with
`fresh-read-required`. No digest, no continuation.

## Torn tail

A torn tail reports `incompleteTail` with the
position of the first torn byte and consistency `method validated-prefix`.
Popeye's `ExportRead.incompleteTail` is the boolean input to that HCN
`ResultEnvelope.incompleteTail` object: true means the reader emits the
object with position and reason, false means null.
The intact prefix stays in the result. The export never rewrites the file.

A `JournalJsonl` layer built with `suppressRepair: true` skips torn-tail
repair and temporary-file cleanup at open, so pre-torn tails report
instead of healing. The default layer keeps native repair.
