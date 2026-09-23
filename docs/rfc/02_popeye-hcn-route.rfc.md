---
number: 02
title: "Popeye HCN Route"
type: feature
status: Draft
author: "kevin"
date: 2026-09-23
---

# RFC-02: Popeye HCN Route

## Abstract

Popeye runs as a peer harness with its own journal, but HCN cannot route to
it: no HarnessEvent stream, no session op contract, no transcript export, no
descriptor entry. This RFC renders the closed wayfinder map (Popeye as a
complete HCN route, issues 13-19) into one ordered spec. Popeye-side work
exposes what HCN needs: an event mapper, a session op adapter, a transcript
envelope mapper with report-only reads, grant filtering, and flag mappings.
HCN-side work adds the popeye descriptor arm through the exhaustive-switch
checklist. Memory, TUI, Tether replacement, and resume-last stay out.

## Introduction

HCN routes to six harnesses through one normalized surface: `run` with NDJSON
HarnessEvents, `session` with send/answer/close ops, `transcript` with
source/result/record envelopes, `inspect`/`ls`/`check` from descriptor facts.
Each surface carries a contract the route meets or explicitly diverges
from. The map resolved every open question: 4 research tickets (contracts),
2 grilling tickets (mappings and divergences). This RFC decides nothing new;
it orders the decided work for implementation.

Scope boundaries: this RFC covers Popeye-side exposure work and names the
HCN-side descriptor arms. It does not implement the HCN-side changes (that
lands in harness-cli-normalizer). It does not cover persistent memory,
a TUI head, Tether or Graybox coordination changes, or resume-last.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as
described in RFC 2119.

- Route: an HCN-addressable harness name with a descriptor entry.
- Mapper: Popeye-side code translating Popeye wire shapes to HCN envelopes.
- Declared divergence: a surface Popeye explicitly does not express, reported
  through HCN divergence diagnostics, distinct from refusal.
- Passive export: transcript reads that never write, repair, or migrate.

## Motivation

A coordinator (Graybox today, HCN-native tomorrow) briefs workers through
HCN. Every harness Popeye cannot match is a harness the coordinator cannot
substitute. The map found Popeye close on data (compaction counts, usage
numbers, journal lines exist) and far on envelopes (no identity event, no
failure taxonomy, no transcript envelopes). The work is mapping and small
behavior changes, not new capability.

## Design

### P1: Run event mapper (answers ticket 14)

The mapper consumes in-process kernel items, not the json head text
stream: `ProviderError.transient` and `status` never cross into progress
or snapshot lines, so classification MUST read them before the head
boundary. Where the mapper runs out-of-process, the head boundary MUST
first extend the settled diagnostic with transient and status fields;
that extension is part of Phase 1, not a separate change.

A Popeye-side mapper MUST translate kernel turn items into HarnessEvents:

1. Identity first: emit `{kind: identity, sessionId, authority:
   harness-minted, capabilities}` from the created session id before any
   token. Capabilities source is the snapshot audit `capabilityGrants`.
   Popeye MUST add a session-id line to json output; the STARTUP stderr
   line is not a substitute.
2. Token/message split: coalesce `assistantText` deltas into `token` events
   plus one trailing `message` event per turn. Render-one rule: the mapper
   MUST NOT emit both separately countable text for the same turn.
3. Failure taxonomy, evaluated in this order: status 429 maps to
   `rate-limit`; auth failures map to `auth`; `BudgetExceeded` maps to
   `budget`; transient `ProviderError` maps to `transport`; turn_failure
   and journal failures map to `task`. The mapper MUST attach a class on
   every error done; anything unmatched MUST map to `task`, never to no
   class.
4. Abort exit: Popeye abort MUST surface as HCN cause `killed` with process
   exit 1 (ticket 19 decision 1). The remap applies in a new `hcn` head
   mode (a fourth `--mode` value alongside print/json/rpc); the in-tree
   json mapping (abort to 2) is unchanged. Full exit matrix for the hcn
   mode: done 0 clean, truncated 0 with limit event (item 6), error 1
   with failure class, aborted 1 killed, toolCalls unreachable (kernel
   consumes them), head-boundary defect 1 with failure class. The in-tree
   abort exit 2 MUST NOT reach HCN callers; exit 2 is invocation refusal.
5. Compaction: map `compactionStarted` to state `started` and
   `compactionApplied` to state `compacted`. Token fields are omitted:
   Popeye progress carries entry/slice counts, not token counts, so
   counts go in `detail` prose. Consumers MUST branch on `state`, never
   on `detail`.
6. Limit: HCN `LimitCode` is closed with no context-length member, so
   truncation MUST NOT emit the `limit` event. A truncated turn ends
   done-cause clean with exit 0 and a message-event note recording the
   truncation. Adding a length LimitCode is an HCN-side vocabulary change
   listed in the P5 checklist when HCN accepts it.
7. Question: no mapping. `--questions ask` is a declared divergence;
   Popeye never emits `awaiting-input` (ticket 18 decision 3).

### P2: Session op adapter (answers ticket 16)

Popeye RPC MUST gain a `close` op: drain the session queue with a 5s
grace, settle the open turn, emit the terminal closed shape, then release.
At grace expiry the HCN close path takes over (SIGTERM-then-SIGKILL per
HCN close semantics). `detach` keeps its current meaning (drop subscription
only) and MUST NOT be renamed to close.

Out of scope for the adapter: bypass lanes stay (control forks are
Popeye-internal; HCN drives one stdin stream and never addresses them);
bounded queues stay with `protocol_error` on overflow (documented, not
removed); timeout-to-fallback stays (ticket 18 decision 3). The adapter
SHOULD document each as a behavioral note in the descriptor.

### P3: Transcript envelope mapper (answers ticket 17)

A Popeye-side mapper MUST translate journal lines to HCN
source/result/record envelopes:

1. Header: synthesize the session envelope from the journal header
   (sessionId) plus filesystem stat (sizeBytes, lastWriteAt). `cwd` is
   absent: rows MUST report `cwd: null` and document unmarked-scope
   behavior. No journal shape change required for v1.
2. Envelopes: map entry lines to HCN record envelopes with kind
   (message/tool-result/compaction), role, parts, and parent-entry
   relationships from parentId. Timestamp is absent from journal lines:
   rows MUST report timestamp null, mirroring the cwd treatment. Record
   lines map to metadata kind.
3. Bookmark: implement base64url JSON bookmarks with digest revalidation
   on continuation. No digest, no continuation.
4. Coverage: declare `history` available; `branches`, `original-records`,
   `embedded-content` limited or unavailable with explicit opt-in
   requirements. Refusals MUST carry requiredAcceptedLimits.
5. Read-path repair MUST become report-only for the passive export: torn
   tail reports `incompleteTail` with consistency fields instead of
   rewriting the file. The existing repair path stays for Popeye-native
   reads; the export path MUST NOT write.

### P4: Grants and flags (answers tickets 18, 19)

1. `--tools`/`--exclude-tools`/`--access` filter contributed tools by name
   before they reach the model. Capabilities MUST NOT be rewritten.
2. `native:<name>` resolves against loaded plugin tool names, including
   first-party tools.
3. Effort maps onto thinkingLevel: low to minimal, medium-low to low,
   medium to medium, medium-high to high, high to xhigh, xhigh to max.
4. System-prompt replace runs fragments-off plus given text; append adds an
   extra fragment last.
5. Skills allowlist filters plugin names; isolation tool-free maps to
   first-party-only with tools off.
6. `--context-window` sets a trusted window override, replacing the
   fabricated default for HCN runs.
7. `--resume-last` is refused as unexpressible. `--questions ask` is a
   declared divergence. Memory is a declared no-op divergence.

### HCN-side arms (named, not implemented here)

Per ticket 15, the harness-cli-normalizer checklist for a new route:
descriptor entry in SHARED_DESCRIPTORS, content READERS arm,
NATIVE_APPROVAL_PROTOCOLS arm, NATIVE_SETTINGS_SOURCES arm, HINTS arm,
transcript descriptor check, smoke scripts, spellingOf arm, override
validation enums, behavioral-notes entries for the three P2 divergences
(bypass lanes, bounded queues, timeout-to-fallback), verifiedAgainst with
re-captured fixtures, docs counts. A length LimitCode addition belongs
here when HCN accepts the vocabulary change. Each arm is a separate change
in that repo with its own review.

## State Machine

Not applicable. Mappers are stateless per stream; the close op follows the
existing RPC session lifecycle plus drain-then-release.

## Error Handling

- E001 - Unmappable Popeye event (severity: warning). Recovery: emit HCN
  `error` informational with the raw tag, continue the stream. Escalation:
  none. A mapper gap MUST NOT end the turn.
- E002 - Refused flag (severity: info). Recovery: HCN refusal exit 2 with
  the supported list (spellingOf-derived). Escalation: none.
- E003 - torn journal tail on passive export (severity: warning).
  Recovery: report `incompleteTail`, return the intact prefix with a
  bookmark. Escalation: none. MUST NOT rewrite.
- E004 - Close with open turn (severity: info). Recovery: drain with the
  5s grace defined in P2, then the HCN close path takes over.
  Escalation: the HCN close path.

Existing Popeye failure channels keep their shapes; the mapper translates,
it does not replace.

## Security Considerations

- Trust boundary: HCN callers are untrusted for tool grants; the grant
  filter runs before model visibility, after plugin trust. A grant list
  MUST NOT load untrusted plugins; it filters already-trusted
  contributions only.
- System-prompt replace runs fragments-off: first-party safety fragments
  MUST be identified before this ships, or replace MUST be refused until
  they are. An open question (see below) tracks this.
- Transcript export exposes journal content to the HCN caller. It MUST
  respect the same read permissions as the journal files. Bookmarks carry
  digests, not content.
- Close op terminates model work: it MUST go through the existing abort
  path with its settlement guarantees, not a process kill.
- Blast radius: mapper bugs misreport status (a failure reads clean) or
  drop events. Mitigation: the mapper ships with golden transcripts per
  surface, regenerated and stable like existing head goldens.

## Alternatives Considered

- HCN-side mapping for all 7 run divergences: HCN parses Popeye json
  output instead of Popeye emitting events. Rejected: HCN mappers are
  per-harness native parsing; Popeye exposing events directly is the
  route contract, and the data already exists in-process.
- Adopt wait-unbounded question semantics under HCN: drop the 25s gate
  timeout when launched from HCN. Rejected in ticket 18: splits gate
  semantics per launcher; the fallback path is live-proven.
- Repair-on-read for passive export: keep recovered_torn_tail behavior.
  Rejected in ticket 17: violates the HCN passive rule (never repair or
  write); report-only is REQUIRED.
- Resume-last via mtime: read most-recent journal file. Rejected in
  ticket 19: flat dir with no workspace binding risks resuming a
  stranger session.
- Uncached input as usage size: rejected in RFC-01; occupancy sums all
  three components. Carried forward, not re-decided.

## Implementation Plan

Phase 1, run mapper (P1 items 1-6): identity, token/message, failure
classes, abort exit, compaction, limit. Verify: golden transcripts per
surface, exit-code matrix test, full gate.

Phase 2, session close op (P2): drain-then-release, closed shape.
Verify: RPC close test, HCN session probe against a fixture harness.

Phase 3, transcript mapper (P3): envelopes, bookmark, coverage,
report-only reads. Verify: envelope goldens, torn-tail fixture reports
without rewriting, bookmark continuation test.

Phase 4, grants and flags (P4): filter, native resolution, effort,
system-prompt, skills, isolation, context-window override, refusals.
Verify: grant matrix test, divergence output test, full gate.

Phase 5, HCN-side arms: descriptor entry and checklist in
harness-cli-normalizer. Separate repo, separate review. Verify: hcn ls
lists popeye, inspect dumps descriptor, check tracks drift, smoke
scripts green.

Go/no-go between phases: prior phase goldens green. Rollback per phase:
mapper off reverts to current json output; no journal shape changes in
any phase.

## Open Questions

1. Which first-party fragments are safety-critical, so system-prompt
   replace knows what fragments-off drops? Options: audit fragments and
   mark safety vs guidance (preferred) vs refuse replace until audited.
   Decides P4 item 4 scope. Settle by reading the first-party plugin
   set before Phase 4.
2. Does the HCN-side checklist accept incremental arms (descriptor first,
   transcript later) or one atomic route addition? Options as stated.
   Decides Phase 5 batching. Settle with the HCN maintainer (Kevin)
   before Phase 5.

## Review

Cross-reviewed by glm-5.3 (2026-09-23): 2 criticals, 6 warnings, 4 nits.
All findings folded in: C1 length-LimitCode unsatisfiable (P1 item 6
rewritten, vocabulary change moved to P5); C2 transient/status not on the
head stream (mapper input contract stated, diagnostic extension listed in
Phase 1); W1 compaction token fields (states and detail specified); W2
journal timestamp absence (null treatment, mirroring cwd); W3 abort remap
head and exit matrix (hcn mode, five-row matrix); W4 rule precedence and
429 mapping (ordered rules); W5 descriptor notes phase (moved to P5
checklist); W6 E004 contradiction (grace defined in P2, escalation set);
N1 effort endpoints (full table); N2 Record noun collision (envelopes);
N3 typo; N4 identity capabilities (capabilityGrants source). Full report:
.scratch/rfc02-review/report.json.

## References

Normative:

- [Map: Popeye as a complete HCN route](https://github.com/dungle-scrubs/popeye/issues/13) - the closed map this RFC renders
- [Ticket 14 resolution](https://github.com/dungle-scrubs/popeye/issues/14) - run contract divergences
- [Ticket 15 resolution](https://github.com/dungle-scrubs/popeye/issues/15) - registration checklist
- [Ticket 16 resolution](https://github.com/dungle-scrubs/popeye/issues/16) - session op contract
- [Ticket 17 resolution](https://github.com/dungle-scrubs/popeye/issues/17) - transcript contract
- [Ticket 18 resolution](https://github.com/dungle-scrubs/popeye/issues/18) - grants and preamble
- [Ticket 19 resolution](https://github.com/dungle-scrubs/popeye/issues/19) - divergences

Informative:

- [RFC-01: Provider Usage Reporting](01_provider-usage-reporting.rfc.md) - usage items the failure mapper reads
- [HCN HarnessEvent contract](https://github.com/dungle-scrubs/harness-cli-normalizer/blob/main/src/execution/events.ts) - target event vocabulary
