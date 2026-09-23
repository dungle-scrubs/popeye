# RFC Review: RFC-01 - popeye v1: Headless Effect-Based Coding Agent

Round 1. Reviewers: structural validator (script), internal consistency
(opus-5), source alignment vs pi/pi-ai (sonnet-5), adversarial (GPT via
Codex, cross-family). Compiled 2026-08-10.

## Structural Validation

Passed. 0 errors, 0 warnings.

## Source Alignment (1 defect, 3 areas verified accurate)

A1 (**defect, high**). The RFC claims pi-ai exposes typed failure data
(status/category/retryAfter) so retryability is "never decided by matching
provider prose". False: pi-ai's consumer-facing error surface is
`AssistantMessage.errorMessage` (prose) + diagnostics with name/message/
stack/code only; pi-ai's own exported classifier `isRetryableAssistantError`
is ~25 regexes over that prose, and pi-ai's authors treat the prose as the
canonical classification input (bedrock keeps `errorMessage` byte-identical
for it). The typed status/retry-after path is internal transport retry and
never reaches stream consumers.

Verified accurate: never-throw stream contract; thinking/cache/auth
delegation; harness-v2 record semantics (pre-provisioned ids, replay
policy, torn-tail recovery, reject-not-repair); snapshot-authoritative
protocol + revision; strict-LF framing citation; all Effect v3 API names
(Schema lives in `effect`, not deprecated `@effect/schema`).

## Internal Consistency (26 findings)

State machine: no failure edges (retry exhaustion, BudgetExceeded,
GateRejected, ToolError, JournalError unreachable in the diagram);
retries placed in two different states; steering-at-IDLE contradicts the
steering definition (that case is follow-up); steering can be lost on a
tool-free turn (drain point doesn't exist on that path). (C1-C6)

Undefined/conflicting types: kernel-to-head blocking requests are a third
message direction the protocol definition excludes; `attach` undefined /
`resume` missing; `follow-up`, `delivery mode`, `phase`, `stop reason`
load-bearing but undefined; `prompt`-during-turn vs reject-invalid-command
rules cover the same case oppositely; "Chain with handled short-circuit"
is a fifth merge semantics outside the enumerated set. (C7-C11)

Vocabulary violations: banned word "event" in Alternatives 3; _Avoid_
aliases used: log, engine (x3), runtime (x3), handler, extension (x2),
cursor, action. (C12-C13)

Normative conflicts: hook failure policy mandated for all points but
declared only for gate/tap (Chain/Accumulate undefined); "exactly one
conflict rule" contradicts per-point merge semantics and namespacing;
tap-hook "MUST NOT slow the turn" contradicts bounded-queue backpressure
with no overflow policy; capability granularity differs between RFC
(load-time, per plugin) and CONTEXT.md (per session, per tool); "MAY
import pi-ai" states an exclusivity rule permissively; isolation both
"composes from outside" and "SHOULD be a plugin"; torn-tail both
recoverable and an error class, recover-vs-reject boundary unstated.
(C14-C20)

Scope/ledger conflicts: providers listed as a contribution kind
(contradicts D-001, CONTEXT.md, and the ai seam); compact/set-model both
core protocol commands and dogfood-proof plugins, and Phase 3 ships
command plugins before any head exists to invoke them; context fold
treats records as excludable entries (contradicts D-013); snapshot shape
both asserted ("full snapshot") and open (OQ2); npm distribution both
"later" and "v1 or fast-follow?" (OQ3); themes/renderers have no in-scope
consumer in a headless v1. D-002, D-006, D-009..D-012 claimed binding but
never cited. (C21-C26)

## Adversarial Review (20 findings; 15 high, 5 medium)

High: no expected-revision/compare-and-append contract for concurrent
heads (X1); leaf not derivable from journal after restart (X2); empty
session/zero-entry branch unrepresentable (X3); torn-tail truncation vs
append-only wording (X4); tool replay idempotence impossible for
side-effecting tools without a durable completion boundary (X5); crash
recovery deferred to Phase 5 but its contracts bind Phases 1-2 (X6); no
linearization rule for steering/abort/branch-switch racing a tool batch
(X7); hot reload can close an active tool's scope, and a gate plugin can
close its own scope mid-gate (X8); trust bound to path not content - git
pull swaps code under an old approval (X9); CLI-specified project-path
plugin can approve its own project (X10); capabilities described as a
control that arbitrary trusted code bypasses (X11); compaction lacks
span/ancestry/nesting semantics - compaction-of-compaction and branches
into retained ranges undefined (X12); overflow recovery assumes
compaction fits when source material may not (X13); scope-pin is not a
version pin, and behavioral drift crosses the seam even if types don't
(X14); protocol has no owner-transfer/reconnect/in-flight-request rules a
future TUI will need (X15).

Medium: tool-result ordering (completion vs call order) unspecified (X16);
conflict-rule/merge-semantics contradiction (X17, dupes C15); bounded
queues without overflow policy (X18, dupes C16); unbounded gate/tool/UI
latency - no timeouts, session can never settle (X19); isolation-as-plugin
runs unisolated before creating its boundary (X20, dupes C19).

## Summary

- Errors: 0 structural
- Inconsistencies: 26
- Alignment defects: 1 (provider error classification)
- Adversarial: 20 (15 high / 5 medium), ~4 overlapping consistency findings

Assessment: the architecture survives; no reviewer challenged the journal/
fold/plugin/seam decomposition itself. The findings concentrate in (a)
underspecified concurrency and ordering contracts, (b) journal edge
semantics, (c) trust/capability honesty, (d) one false claim about pi-ai's
error surface, and (e) vocabulary discipline the RFC itself declares
normative.
