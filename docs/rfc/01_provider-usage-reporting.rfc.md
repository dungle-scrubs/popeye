---
number: 01
title: "Provider Usage Reporting"
type: feature
status: Implemented
author: "kevin"
date: 2026-09-23
---

# RFC-01: Provider Usage Reporting

## Abstract

The kernel Provider seam discards the token usage and context window that
pi-ai reports on every terminal stream event. The turn loop therefore cannot
measure prompt size against the model window. This RFC specifies usage
reporting through the seam: each terminal provider item carries measured input
tokens, the window in tokens, and the source of each number. A later pressure
gate reads these items. This RFC covers measurement only. It specifies no gate,
no trim, and no idle fold.

## Introduction

The turn loop folds branch context against a fixed 32_000-char budget
(`packages/kernel/src/turn-orchestrator.ts`, `DEFAULT_CONTEXT_BUDGET`). The
fold uses `content.length`, not tokens. It never reads the model window. A
turn at 80 percent of the window that consumes 30 percent more in one round
has no handler: the provider rejects the request, and the turn settles as a
bare `provider_error` with the raw upstream message.

pi-ai already reports what the loop needs. Terminal `done` events carry a full
`AssistantMessage` with `usage.input`, `usage.output`, `usage.cacheRead`,
`usage.cacheWrite`, and `usage.totalTokens`. Terminal `error` events carry an
`AssistantMessage` with usage as measured before failure. The request model
carries `contextWindow`. The seam mapping (`packages/kernel/src/ai/seam.ts`,
`mapStreamItem`) drops all of it.

This RFC answers the astra-high review of the usage-seam design scope
(`.scratch/usage-seam-review/report-astra.md`). All five review findings are
folded in below, one line per point in Alternatives Considered and the
normative sections.

Scope boundaries: this RFC covers usage measurement and its delivery to the
turn loop. It does not cover the pressure gate, tool-result trim, threshold
trigger, idle fold, snapshot or protocol changes, or journal writes. Usage
stays turn-local and dies with the turn.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as
described in RFC 2119.

- Prompt occupancy: the total tokens the provider measured for the prompt,
  defined as `usage.input + usage.cacheRead + usage.cacheWrite`. Cached
  tokens occupy context. They MUST count.
- Window: the model context window in tokens. 0 means unknown. An unknown
  window MUST disable every downstream gate.
- Measured usage: numbers taken from pi-ai terminal events (`event.message`
  on `done`, `event.error` on `error`).
- Estimated usage: assembled-request chars divided by 4, used only when
  measured usage is unavailable.
- Provenance: whether a reported number is measured or estimated, and for
  the window whether it is trusted model metadata or a fallback default.

## Motivation

Three consumers need measured usage, in order:

1. The pressure gate (next RFC): force a final tool-less answer when the
   prompt crosses a fraction of the window, instead of opening tool calls
   that push past 100 percent.
2. Overflow diagnostics: settle a provider overflow with measured input,
   window, and step, instead of a raw upstream string.
3. The threshold trigger (later): compact at 80 percent of the window in
   idle time, instead of compacting only when the fold already fails.

Without this RFC, each consumer re-derives size from chars. That duplicates
the estimate in three places and disagrees with the provider wherever caching
or tokenization diverges from chars/4.

## Design

### ProviderUsage type

In `packages/kernel/src/provider.ts`:

```ts
export const ProviderUsageSchema = Schema.Struct({
  inputTokens: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  contextWindowTokens: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  source: Schema.Literal("provider", "estimate"),
});
```

- `inputTokens` is prompt occupancy: measured input plus cache read plus
  cache write. The seam MUST sum all three. Reporting uncached input alone
  as size is a defect (review finding 1).
- `contextWindowTokens` is 0 when no trusted window exists. See window
  provenance below.
- `source` records measured vs estimated. Gates MUST NOT treat an estimate
  as a measurement for window learning.

`AssistantItem` `done` gains `usage?: ProviderUsage`. `ProviderError` gains
`usage?: ProviderUsage`. Both are OPTIONAL and additive. Existing fixtures
MUST stay green.

### Measurement precedence

For each terminal event, the seam MUST apply this order:

1. Read measured usage from the terminal event (`event.message.usage` on
   `done`, `event.error.usage` on `error`).
2. Validate: all components finite, non-negative integers. A malformed
   component degrades the whole report to step 3. It MUST NOT throw inside
   the stream map.
3. Absent or malformed measured usage on a nonempty request falls back to
   the assembled-context estimate (chars/4), marked `source: "estimate"`.
   A reported zero on a nonempty request MUST be treated as absent, because
   pi-ai zero-initializes usage before wire usage arrives (review finding 2).
4. The larger of measured occupancy and estimate wins, per request. The
   comparison scope is one request. A maximum across requests MUST NOT
   persist, or stale pre-compaction usage survives (reviewer coverage gap).

### Window provenance

The request model `contextWindow` MUST carry provenance from model
resolution. Fabricated base-URL models default to 128_000
(`seam.ts`, `resolveModel`). That default is operational, not trusted.

- A window from registry metadata or an explicit layer option is trusted.
  Report it.
- A window from the fabricated default with no explicit configuration is
  untrusted. Report `contextWindowTokens: 0` (review finding 3).
- pi-ai needs its own operational default for request shaping. That default
  MUST stay inside the seam. It MUST NOT cross into the reported item.

### Overflow window learning

On provider overflow, the seam MAY parse the window from the provider message
to self-heal a stale model window. The parser MUST use recognized formats
with separate captures for required input and window. It MUST reject
ambiguous matches and leave the window unchanged. A naive
number-before-tokens rule learns the input count as the limit (review
finding 4: `prompt is too long: 213462 tokens > 200000 maximum` selects
213462, but the limit is 200000).

Learned windows tighten only, are keyed per model, and MUST be validated
(positive safe integer, smaller than the current stored window) before
storing. Estimates MUST NOT feed window learning.

### Turn-loop consumption

`consume` in `turn-orchestrator.ts` stores the terminal usage in a per-turn
Ref. The Ref MUST reset per provider request so absent usage cannot reuse a
prior request numbers (review finding 5). No gate reads the Ref in this RFC.
Settle paths attach measured numbers to the diagnostic detail string.

The error path MUST be specified for all three terminal variants: `done`,
`error`, and `aborted` (which maps to `done` with stop reason `aborted`).
Usage attaches before `ProviderError` emits and survives retry handling to
the final settlement.

## State Machine

Not applicable. This RFC adds data to existing stream items. It adds no
states.

## Error Handling

- E001 - Malformed upstream usage (severity: info). Recovery: degrade to
  estimate or absence. The stream map MUST NOT fail for usage reasons.
  Escalation: none. A diagnostic MAY note the degradation.
- E002 - Unknown window (severity: info). Recovery: report 0. All gates
  stay off. Escalation: none.
- E003 - Ambiguous overflow message (severity: info). Recovery: leave the
  learned window unchanged. Escalation: none.
- E004 - Provider overflow with measured usage (severity: warning).
  Recovery: the turn settles `provider_error` with input tokens, window,
  and step in the diagnostic detail. Escalation: the head renders the
  numbers; the user branches or starts a new session.

Existing `ProviderError` transient classification is unchanged. Usage
attaches to errors; it creates no new failure variant.

## Security Considerations

- Trust boundary: pi-ai terminal events are the boundary. Usage numbers are
  validated there (finite, non-negative, safe integers). The loop trusts the
  typed item without re-validating.
- Untrusted numbers MUST NOT drive destructive action in this RFC. They
  drive nothing; gates come later. Window learning tightens only and
  validates before storing, so a hostile or corrupt message cannot widen
  the window.
- Blast radius: a wrong usage number misleads a future gate into forcing an
  early final answer or compacting early. It cannot delete history, widen a
  window, or leak data. Usage never enters entries, snapshots, or the wire.
- Data sensitivity: usage carries counts only. No prompt text, no tool
  arguments, no credentials.
- Injection resistance: overflow messages are parsed with recognized-format
  captures, not executed. Ambiguous input is rejected, not interpreted.

## Alternatives Considered

- Uncached input as size: report `usage.input` alone. Rejected: pi-ai
  defines `input` exclusive of cache read and write, so cached prompts
  underreport (review finding 1).
- Zero means zero: treat reported zero usage as measured. Rejected: pi-ai
  zero-initializes usage, erasing the absent-vs-zero distinction (review
  finding 2).
- Fabricated window as known: copy `requestModel.contextWindow` always.
  Rejected: the 128_000 default would enable gates on an unknown window
  (review finding 3).
- Naive overflow regex: first number before "tokens" is the limit.
  Rejected: it learns the input count, 213462, instead of the limit,
  200000 (review finding 4).
- Done-path only: specify extraction on `done` and leave the error branch
  to the existing `ProviderError`. Rejected: overflow takes the error
  branch, so the settled diagnostic would lack the numbers the RFC exists
  to deliver (review finding 5).
- Per-delta usage: report usage on every stream item. Rejected: pi-ai
  carries usage on terminal events only. There is nothing to report
  mid-stream without inventing it.

## Implementation Plan

Phase 1, seam types: add `ProviderUsageSchema`, extend `done` and
`ProviderError`. Verify: `pnpm build`, existing fixtures green.

Phase 2, seam mapping: measured read, validation, estimate fallback,
larger-wins per request, window provenance, overflow parser with
recognized formats. Verify: new unit tests (scripted usage passes
through; absent yields estimate; malformed degrades; unknown window is
0; error path attaches usage), plus `typecheck`, `lint`, `test`,
`check-boundaries`.

Phase 3, turn consumption: per-request Ref, reset behavior, settle
diagnostic detail. Verify: fake-provider turn carries usage to
settlement; crash matrix green; usage never journaled.

Phase 4, live check: one turn against LM Studio. Record reported input
and window against the assembled estimate in the task ledger.

Go/no-go between phases: prior phase tests green. Rollback per phase:
revert the additive fields; the seam returns to discarding usage.

## Open Questions

All resolved. See Decisions.

## Decisions

1. Estimate counting boundary: full assembled request (system text,
   messages, tool declarations, tool arguments), chars/4. Content-only
   undercounts the tool-heavy prompts that overflow. Exact divisor
   settled against live LM Studio numbers in Phase 4. Decided by kevin,
   2026-09-23.
2. Fold budget: keep 32_000 chars, accrue usage in parallel. No behavior
   change in this RFC. The fold converts once the pressure gate proves the
   numbers. Decided by kevin, 2026-09-23.
3. Learned-window store: layer-local memory. A learned window re-learns on
   the next overflow for that model. No journal shape. Decided by kevin,
   2026-09-23.

## References

Normative:

- [packages/kernel/src/provider.ts](../packages/kernel/src/provider.ts) - seam interface under change
- [packages/kernel/src/ai/seam.ts](../packages/kernel/src/ai/seam.ts) - pi-ai mapping under change
- [packages/kernel/src/errors.ts](../packages/kernel/src/errors.ts) - error shapes under change
- [pi-ai overflow patterns](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/src/utils/overflow.ts) - recognized overflow formats
- [pi-ai usage mapping](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/src/api/openai-completions.ts) - input/cache split, zero-init

Informative:

- [.scratch/usage-seam-review/report-astra.md](../.scratch/usage-seam-review/report-astra.md) - the review this RFC answers
- [Belay compaction controller](/tmp/belay-look/apps/agent-host/src/agent/compaction-controller.ts) - larger-of-reported-and-estimate precedent
- [CONTEXT.md](../CONTEXT.md) - ubiquitous language
