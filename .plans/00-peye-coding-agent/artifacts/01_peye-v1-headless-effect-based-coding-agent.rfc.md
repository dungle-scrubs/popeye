---
number: 01
title: "peye v1: Headless Effect-Based Coding Agent"
type: feature
status: Accepted
author: Kevin Frilot
date: 2026-08-10
---

# RFC-01: peye v1: Headless Effect-Based Coding Agent

## Abstract

peye is a coding agent whose core is an append-only journal and whose only
mechanism for adding behavior is a plugin system expressive enough that
peye's own features are built with it. v1 is headless: the kernel, journal,
context fold, plugin system, and three wire heads (print, JSON, RPC), with
`@earendil-works/pi-ai` as the provider layer and Effect v3 as the
implementation substrate. The design adopts what the pi source analysis
(docs/research/pi-analysis.md) identified as pi's best decisions and
replaces its documented debts with structural guarantees: a single-writer
kernel per session, typed failure channels, declared hook semantics
instead of bespoke emitters, bounded concurrency with explicit overflow
policies, and one durable session representation.

## Introduction

### Problem

pi (earendil-works/pi) demonstrates that a small-core, self-extensible
coding agent is viable, but its own source records the cost of getting
there incrementally: two parallel agent architectures shipping in one
package, execution policy accumulated in a 3,342-line session class
coupled to the loop by mutation, five overlapping plugin-like surfaces,
and reliability properties (hook failure policy, conflict resolution,
backpressure) maintained by discipline rather than by types. pi's
harness-v2 design doc is the authors' own diagnosis; it is unfinished.

### Scope

In scope for v1:

- The **journal**: append-only entries and records; JSONL backend; session
  tree with branching, compaction, and crash recovery.
- The **kernel**: single-writer turn execution over pi-ai, with steering,
  follow-up, abort, tool execution, and retry/compaction policies composed
  around it.
- The **context** fold: branch entries + budget to model-visible messages.
- The **plugin system**: manifests, contributions (tools, commands, hooks,
  instruction fragments per <!-- D-019 --> D-019), capabilities, trust,
  hot reload; peye's own commands ship as plugins.
- The **protocol**, an in-process driver head (from Phase 2), and three
  wire heads: print, JSON, RPC (<!-- D-006 --> D-006).
- The **ai seam**: the single module importing pi-ai (<!-- D-001 -->
  D-001).

Out of scope for v1 (later plans):

- The TUI head; it will reuse `@earendil-works/pi-tui` (<!-- D-007 -->
  D-007). Renderer and theme contribution kinds arrive with it (D-019).
- SQLite journal backend. The `Journal` service and its conformance suite
  MUST make adding it possible without schema change; the backend itself
  is deferred.
- Concurrent operations per session (pi's "lanes"); the vocabulary term
  stays deliberately undefined until this enters scope (<!-- D-013 -->
  D-013).
- Compiled-binary distribution (<!-- D-008 --> D-008: Node + npm under
  `@dungle-scrubs`).
- npm-referenced plugin packages: fast-follow after v1 (<!-- D-018 -->
  D-018); v1 discovery is directories and explicit paths.
- Sub-agent orchestration, MCP client support, provider OAuth flows
  beyond what pi-ai provides.

### Context

Normative background: `CONTEXT.md` (the vocabulary, per <!-- D-009 -->
D-009..D-013) and `docs/research/pi-analysis.md` (source analysis of pi
0.84.1). Decisions D-001..D-027 in the plan ledger bind this RFC and are
cited inline where they govern.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD
NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted
as described in RFC 2119.

Domain terms (Session, Journal, Entry, Record, Branch, Leaf, Compaction,
Snapshot, Context, Progress, Kernel, Turn, Steering, Follow-up, Provider,
Plugin, Contribution, Hook, Capability, Tool, Command, Trust, Head,
Protocol) are defined in `CONTEXT.md`, which is normative
(<!-- D-010 --> D-010..D-013). The word "event" MUST NOT appear in peye
code, documentation, or type names; pi's and pi-ai's own names are exempt
when quoting or interfacing with those systems.

Protocol-level terms this RFC adds:

- **Phase**: the kernel state exposed in a snapshot (`idle`,
  `assembling`, `streaming`, `executing`, `settling`).
- **Stop reason**: why an assistant entry ended (`done`, `toolCalls`,
  `aborted`, `error`), persisted on the entry.
- **Attach / detach**: a head connecting to / disconnecting from a
  session's protocol surface; resuming a session is `resume` (create,
  branch, fork, resume being the session lifecycle).
- **Interaction request**: a kernel-initiated blocking request to a head
  (select, confirm, input) with a timeout and a typed fallback.
- **Generation**: one loaded plugin set; hot reload replaces the current
  generation.

## Motivation

Three properties motivate a new implementation rather than contribution
to pi:

1. **One representation.** pi maintains agent state, session persistence,
   and wire payloads as separate structures kept consistent by pointer
   identity and in-place mutation. An append-only journal with folds
   eliminates the consistency obligations rather than managing them
   (<!-- D-004 --> D-004).
2. **Structural reliability.** The reliability defects found in the pi
   analysis (an unguarded emitter, unbounded queues, unbounded parallel
   tool batches, prose-matching scattered across layers) become
   properties Effect encodes in types or primitives: typed failure
   channels, `Schedule` retries, `Scope`-bound cleanup, bounded queues
   with declared overflow policies (<!-- D-002 --> D-002). Provider
   error classification remains prose-based at bottom - pi-ai exposes no
   structured category to stream consumers - but it is confined to the ai
   seam and delegated to the classifier pi-ai itself maintains
   (<!-- D-014 --> D-014).
3. **An enforceable dogfood rule.** pi's plugin-like API is proven
   expressive (its examples implement plan mode, subagents, sandboxing)
   but pi core does not use it, so nothing prevents divergence. peye
   inverts this: the plugin API is load-bearing for peye's own features
   from day one (<!-- D-005 --> D-005).

## Design

### Module topology

```
        +--------------------------------------------------+
        |                     heads                        |
        |   driver (in-process) · print · json · rpc       |
        +-----------------------+--------------------------+
                                | protocol (commands in;
                                |  snapshots + progress out;
                                |  interaction requests)
        +-----------------------v--------------------------+
        |                    kernel                        |
        |  single-writer per session · turns · steering    |
        |  policies composed around it: retry, compaction  |
        +---+----------------+----------------+------------+
            |                |                |
        +---v----+      +----v-----+     +----v-----+
        | journal|      | plugins  |     | ai seam  |
        | entries|      | registry |     | (pi-ai)  |
        | records|      | hooks    |     +----------+
        +--------+      | caps     |
                        +----------+
```

Dependency rules:

- Heads MUST depend only on the protocol. The kernel MUST NOT depend on
  any head.
- Only the ai seam MUST contain imports of `@earendil-works/pi-ai`; every
  other module MUST NOT import it.
- Feature code (commands, compaction policy, the skills-equivalent) MUST
  use the public plugin API. CI MUST fail if a feature module imports
  kernel internals (D-005).

### Journal

The journal is the only durable representation of a session (D-004).

- Entries and records MUST be validated by Effect `Schema` on read and
  write; every line carries a schema version, and reading an older
  version MUST migrate through explicit, tested migration functions.
- Creating a session appends a root entry, so an empty session has a
  defined representation: its leaf is the root entry, and branch or
  compaction commands against it are valid no-ops or typed rejections as
  each command specifies.
- Entries form a tree via `parentId`. The current leaf position is
  itself durable: moving the leaf appends a leaf-moved record, so the
  journal alone reconstructs the session's position after restart.
- Append-only means: once an appended line is acknowledged, it is never
  rewritten or deleted. An unacknowledged partial tail line from a
  crashed append is not part of the journal; on open it MUST be detected
  and the file recovered to its valid prefix. This truncation of
  never-acknowledged bytes does not violate append-only. By contrast,
  acknowledged record sequences that violate single-writer invariants
  are corruption: recovery MUST reject them with a `JournalError` naming
  the corruption class, never repair them.
- Compaction is an entry recording the summarized span (first and last
  summarized entry ids), the summary, and the ids of the retained tail.
  A newer compaction MAY cover an older compaction entry (summarizing
  the summary). The context fold uses the newest compaction on the
  current branch: its summary, its retained tail, then entries after it;
  it MUST NOT need entries older than that compaction. Because a
  compaction is an entry on one branch, other branches are unaffected,
  and branching to an entry inside a summarized span simply yields a
  branch without that compaction on its path.
- Records journal operations (D-022): an operation-started record
  carries the intent and pre-provisioned result entry ids so recovery is
  idempotent; tool-started records carry a replay policy (`never` |
  `safe`). Recovery MUST be a pure function of a bounded record slice.
- The `Journal` service is a `Context.Tag`; v1 ships the JSONL layer plus
  an in-memory layer for tests. A conformance suite over the service
  interface is the backend contract; any future backend MUST pass it.

### Kernel

The kernel runs turns. Its durable output is entries and records; its
transient output is progress.

- **Single writer** (<!-- D-016 --> D-016): all mutating commands for a
  session (prompt, steer, abort, branch, fork, plugin-contributed
  commands) serialize through one per-session mailbox processed by one
  fiber. Linearization holds by construction: there is exactly one
  interleaving, and it is the order the mailbox dequeued. Mutating
  commands MAY carry `expectedRevision`; a mismatch MUST produce a typed
  `StaleRevision` rejection, not a queue.
- A turn: assemble context (fold), stream the assistant response through
  the ai seam, execute tool calls, append entries, repeat while the model
  requests tools, then settle.
- Tool batches run with bounded concurrency (default 4, configurable); a
  tool declaring sequential execution forces its batch sequential (pi's
  rule, kept). Tool result entries MUST append in call order regardless
  of completion order; completion order is visible only as progress
  (D-016). A failed tool becomes an error result entry in its call-order
  position; it does not block other results.
- Every tool execution runs in its own `Scope`; interruption MUST run
  the tool's finalizers. Abort is fiber interruption, not a checked flag.
- **Steering and follow-up**: `steer` targets the running turn and is
  drained at the next safe point - after the current tool batch, and
  again at settling if the assistant produced no tool calls, so queued
  steering MUST NOT be lost on a tool-free turn. `prompt` while a turn
  runs MUST NOT throw; the command carries a delivery mode choosing
  steering or follow-up (default follow-up). Abort discards queued
  steering (it belonged to the aborted turn) and retains follow-ups.
- Retry is a `Schedule` around the provider call, inside the streaming
  phase. Retryability comes from `ProviderError.transient`, assigned at
  the ai seam (D-014). Exhaustion appends an error entry and the turn
  settles.
- Context-overflow recovery (compact then retry once) is a policy layer
  composed around the kernel. Compaction summarization requests MUST
  operate on bounded slices of the branch, never requiring the full
  overflowing context in one provider request; if even bounded
  summarization cannot fit, the turn fails with `BudgetExceeded` and a
  diagnostic naming the options (branch, manual truncation).
- **Latency bounds**: gate hooks and interaction requests have timeouts
  (D-020; defaults 30s and head-configurable respectively). Tools have
  no default timeout but MUST be interruptible; abort always works. The
  ai seam applies a configurable idle timeout to provider streams,
  yielding a transient `ProviderError`. Every turn therefore reaches a
  terminal entry sequence in bounded time once the user aborts.
- The kernel MUST be runnable with a fake provider layer and the
  in-memory journal layer; recorded journals are test fixtures.

### Context

`(branch entries, budget) -> model messages` as a pure fold, with one
boundary function deciding what the model sees (pi's `convertToLlm`
boundary, kept). The fold's input is branch entries only - records never
enter it by construction (D-013). Entry kinds that are not model-visible
are excluded here and only here. Compaction summarization is the one
effectful part and lives beside the fold, not inside it.

### AI seam

The only module that knows pi-ai exists.

- Wraps `AssistantMessageEventStream` (pi-ai's name, exempt here) into an
  Effect `Stream` once; pi-ai's never-throw contract makes this
  mechanical (spike-validated).
- Cancellation is request-level (<!-- D-026 --> D-026): the seam owns an
  `AbortController` per provider request and wires fiber interruption to
  pi-ai's `signal` option; the stream type itself exposes no cancellation
  hook.
- Maps pi-ai failures into `ProviderError` at this boundary, assigning
  `transient` by delegating to pi-ai's exported
  `isRetryableAssistantError` classifier (D-014). Prose-matching exists
  and is acknowledged; it is confined to this seam and maintained
  upstream. No pi-ai type crosses the seam.
- Model listing, thinking-level clamping, cache retention, and auth
  resolution delegate to pi-ai; peye adds no provider logic. Plugins do
  not contribute providers (D-019); custom endpoints are pi-ai model
  configuration.
- The dependency is pinned to an exact version of `@earendil-works/pi-ai`
  (0.84.x at time of writing). Version bumps MUST pass the seam's
  contract test suite (recorded stream fixtures covering ordering, error
  encoding, and settlement) before landing; behavioral drift in the 0.x
  dependency is caught at the seam, not downstream.

### Plugin system

One primitive (<!-- D-003 --> D-003). A plugin is a manifest plus a build
function returning contributions.

- **Manifest**: Schema-validated; declares name, version, and required
  capabilities. v1 contribution kinds: tools, commands, hooks,
  instruction fragments (D-019); the registry design MUST admit new
  kinds (renderers, themes) without core changes.
- **Capabilities** (honesty first, per review): capabilities are a
  declaration, visibility, and granting mechanism - they gate which
  contributions are available and make a plugin's powers reviewable.
  They are NOT an enforcement boundary against malicious code: a trusted
  plugin's build function runs with process authority regardless of its
  declarations. Trust decides whether code runs; capabilities decide
  what a well-behaved plugin's contributions may do. Grants are per
  session (per `CONTEXT.md`). A contribution requiring an ungranted
  capability is unavailable, with a diagnostic; a manifest MAY mark a
  capability `required`, making load fail instead, with a message naming
  the capability.
- **Contributions** are namespaced (`plugin-name/thing`). A key conflict
  (two registrations of the same key) resolves by declared priority with
  a diagnostic - one rule for all kinds. Multiple contributions at one
  hook point are not conflicts; they compose by that point's declared
  merge semantics.
- **Hooks** declare, in their type: the hook point, the merge semantics
  (`Chain` | `FirstWins` | `Accumulate` | `Tap`), and the failure policy
  (D-020): gate points (FirstWins) fail closed, and a gate timeout is a
  rejection; Chain and Accumulate contributions fail open - the failing
  contribution is skipped with a diagnostic; Tap failures are logged and
  dropped. One generic emitter executes all hook points from these
  declarations; per-point bespoke emitters MUST NOT exist.
- **Tap hooks** run on their own fibers behind bounded sliding queues
  (drop-oldest, with a dropped-count diagnostic): taps observe hints, so
  dropping is correct and a slow tap cannot slow the turn.
- **Hook points** (initial set, extensible): context (Chain), provider
  request (Chain), input transform (Chain), input handling (FirstWins),
  tool call gate (FirstWins), tool result (Accumulate), resource
  discovery (Accumulate), compaction gate (FirstWins), trust
  (FirstWins), turn lifecycle (Tap), progress (Tap), session lifecycle
  (Tap).
- **Trust** (<!-- D-015 --> D-015): two-phase load. Phase 1 builds
  user-global plugins and CLI-specified plugins that resolve outside the
  project tree; they answer the trust question. Any plugin path
  resolving inside the project tree is project-local, loads only in
  phase 2, and MUST NOT answer trust - a project cannot approve itself.
  The trust decision records a content digest of the project's plugin
  files; on change, peye re-prompts with a summary of what changed.
  Project-local plugin code MUST NOT execute before the trust decision.
- **Hot reload**: the current generation lives behind a `Ref`. Reload
  builds the new generation, swaps the ref for subsequent work, and
  closes the old generation's `Scope` only after in-flight turns settle
  (a drain barrier). Reload is itself a mailbox command, so it cannot
  interleave with a running gate hook (D-016). Scope finalizers release
  every subscription and resource; stale-instance bugs are prevented by
  scope closure, not assertion stubs.
- **State**: plugins persist state as entries (session-tree residency,
  pi's design, kept) so branch switches yield correct per-branch state.
- **Discovery**: project (`.peye/plugins/`), user-global, and explicit
  paths (D-018). pi's five surfaces do not exist: a skill, theme, or
  template is a plugin whose contributions are of one kind.
- **Loading** (<!-- D-027 --> D-027): plugin modules load through native
  Node 24 type stripping (absolute `file:` URL dynamic import, with
  query-string cache busting for reload); `enum` and `namespace` are
  prohibited plugin syntax, rejected with a load-time diagnostic. No
  loader dependency.

### Protocol and heads

- Snapshot-authoritative (pi's protocol design, kept): every mutating
  command returns a full snapshot with a monotonic revision; progress is
  streamed separately and MUST NOT be folded into head state. v1
  snapshots carry the full transcript (<!-- D-017 --> D-017); the
  protocol reserves revision + entry-id addressing so pagination can be
  added without breaking heads, with the decision instrumented by a
  Phase 4 measurement.
- **Kernel primitives** (<!-- D-021 --> D-021): create/resume/list,
  attach/detach, prompt (with delivery mode), steer, abort, get
  snapshot, subscribe progress, branch/fork, set model, set thinking
  level. **Plugin-contributed commands** (compact, session naming, and
  everything after) ride a generic invoke-command message; this is how
  the surface grows without core changes - the failure mode of pi's
  9-vs-38 protocol gap.
- **Interaction requests**: kernel-initiated select/confirm/input,
  addressed to the head attached with interactive capability; each has a
  timeout and a typed fallback the requesting plugin declares. On head
  detach or timeout the fallback resolves. A newly attaching head
  receives the current snapshot and any pending interaction requests.
  Fire-and-forget surfaces (notify, status) degrade to no-ops in heads
  that lack them, and the degradation is visible to the requesting
  plugin (pi's no-op rule, kept as protocol degradation).
- Per-subscriber progress buffers are bounded and sliding (drop-oldest);
  snapshots make dropped progress harmless.
- Heads in v1: **driver** (in-process, Phase 2; how tests and the SDK
  drive the kernel, and the surface plugin commands are exercised on
  before wire heads exist), **print** (final text, exit code from stop
  reason), **json** (one JSON progress/snapshot item per line; output
  paced by awaiting stdout), **rpc** (long-lived stdio, newline-
  delimited JSON, strict LF framing - pi's U+2028/U+2029 lesson, whose
  documentation is normative for head authors).
- Owner transfer, multi-head focus arbitration, and reconnect semantics
  beyond the rules above are deferred to the TUI-head plan (Open
  Question 1) - but the protocol invariants they will rely on (snapshot
  authority, revision monotonicity, interaction-request addressing) are
  fixed here.

### Effect discipline

- One `runPromiseExit` boundary per head entry point; interior code
  returns `Effect`/`Stream` values.
- All failures are `Data.TaggedError` classes in the failure channel;
  `throw` inside the graph is a review-rejectable defect.
- Services are `Context.Tag` + `Layer` (v3 stable idiom, D-002); tests
  provide fakes through the same seams.
- `Schema` at every trust boundary: journal lines, plugin manifests,
  protocol frames, tool arguments.

## State Machine

Turn lifecycle (kernel-internal; exposed to heads as the snapshot
`phase`):

```
IDLE       -> ASSEMBLING  (on: prompt command | queued follow-up)
ASSEMBLING -> STREAMING   (on: context fold complete)
ASSEMBLING -> SETTLING    (on: BudgetExceeded; error entry appended)
STREAMING  -> EXECUTING   (on: assistant entry ends, stop reason toolCalls)
STREAMING  -> SETTLING    (on: assistant entry ends, stop reason done;
                           or retries exhausted, stop reason error -
                           error entry appended)
EXECUTING  -> ASSEMBLING  (on: tool batch complete; queued steering
                           drained here)
SETTLING   -> ASSEMBLING  (on: queued steering or follow-up present;
                           steering drained here on tool-free turns)
SETTLING   -> IDLE        (on: no queued user input; turn settled)
any        -> SETTLING    (on: abort; fiber interrupted, partial
                           assistant entry persisted with stop reason
                           aborted, queued steering discarded)
any        -> IDLE        (on: JournalError; session unusable, typed
                           error to attached heads)
```

- Retries live inside STREAMING (the `Schedule` wraps the provider
  call); SETTLING only drains queues and finalizes.
- `GateRejected` and `ToolError` are not turn failures: each becomes an
  error tool-result entry in call-order position during EXECUTING, and
  the model sees it next turn.
- Terminal state of every turn - done, failed, or aborted - MUST be a
  well-formed entry sequence in the journal (pi's failure-quartet rule,
  made structural).
- Protocol commands invalid for the current phase MUST be rejected with
  a typed error, not queued. `prompt` is never phase-invalid (it queues
  by delivery mode); `StaleRevision` is the rejection for revision
  mismatches (D-016).

## Error Handling

Tagged failure taxonomy (initial; each a `Data.TaggedError`):

```
ProviderError      (seam-assigned; transient: boolean via pi-ai's
                    classifier (D-014); message preserved for diagnosis)
ToolError          (tool failed; becomes an error result entry the model
                    sees; never aborts the batch)
GateRejected       (a FirstWins hook blocked a tool call or command;
                    names the plugin and reason; gate timeout produces it)
StaleRevision      (expectedRevision mismatch on a mutating command)
PluginLoadError    (manifest invalid, required capability ungranted,
                    build failed; names the plugin and cause)
JournalError       (acknowledged-content corruption with named class,
                    migration failure; torn tails are NOT errors - they
                    are recovered on open per the Journal section)
ProtocolError      (malformed frame, phase-invalid command)
BudgetExceeded     (context cannot fit even after bounded compaction;
                    carries the options diagnostic)
InteractionTimeout (interaction request expired; resolved by the
                    declared fallback, reported to the plugin)
```

- Retry policy: `Schedule` with exponential backoff; retry only
  transient `ProviderError`s; max attempts configurable; exhaustion
  settles the turn with an error entry.
- Hook failure policies are per merge class (D-020) and declared in the
  hook point's type; there is no hook point with undeclared failure or
  latency behavior.
- Journal corruption on open: recover unacknowledged torn tails; reject
  acknowledged-content corruption with the named class; never silently
  repair records (harness-v2 rule, kept).

## Security Considerations

- **Trust boundary 1: project-local code.** Project plugins execute
  arbitrary code with process authority. The controls: two-phase load
  (no project-local execution before the trust decision), content-digest
  binding with re-prompt on change, and the project-local classification
  of any CLI-passed path inside the project tree (D-015). Trust - not
  capabilities - is the control against malicious plugins.
- **Trust boundary 2: model output.** Tool arguments are
  Schema-validated before execution; prompt injection is an accepted
  residual risk for a local agent (pi's stated position, adopted),
  mitigated by capability-gated tool availability and gate hooks, not by
  claimed in-process sandboxing.
- **Isolation is an OS concern.** peye MUST NOT claim an in-process
  permission sandbox. Real isolation (containers, micro-VMs) is
  established around the peye process from outside. A plugin MAY
  integrate an external isolation boundary (as pi's gondolin does), but
  the boundary lives outside the process, and the integrating plugin
  itself runs with process authority before that boundary exists -
  which is why trust, not capability declarations, gates its loading.
- **Secrets.** Provider auth is pi-ai's concern; peye MUST NOT persist
  credentials in the journal and MUST NOT write request headers to any
  diagnostic output. Journal files contain conversation content and code;
  they are as sensitive as the repository itself.
- **Blast radius.** Worst case is what the launching user can do.
  Capability grants narrow what well-behaved plugins' contributions can
  reach, and the grant set is visible in the snapshot; malicious-code
  risk is bounded by trust plus OS-level isolation, and the RFC says so
  rather than implying more.
- **Supply chain.** Exact-pinned dependencies (including the pi-ai exact
  pin), minimal dependency count, `--ignore-scripts` posture, npm OIDC
  trusted publishing (pi's hygiene, adopted; concrete setup lands with
  the public-release step).

## Alternatives Considered

1. **Contribute harness-v2 to pi instead of building peye.** Attractive:
   the diagnosis and design doc already exist there. Rejected: the goals
   include Effect as substrate and a single plugin primitive - rewrites
   of pi's core contracts, not contributions - and pi's contribution
   posture is closed to non-trivial external PRs.
2. **Rebuild the provider layer natively in Effect.** Rejected (D-001):
   pi-ai's provider/compat/catalog machinery is the best-engineered part
   of pi, its never-throw contract makes wrapping cheap, and 40
   providers of compat data is not differentiating work. Accepted
   consequence (D-014): error classification stays prose-based at the
   seam.
3. **Callback-registration plugin API (pi's shape) instead of declared
   hook semantics.** Rejected: pi's ~350 lines of bespoke emitters
   produced exactly the asymmetry defects the analysis found; declared
   semantics plus one generic emitter make composition rules data.
4. **Ink/React for the eventual TUI.** Rejected (D-007): heavy
   dependency tree, different rendering paradigm; pi-tui's pure-render
   contract is proven and separately published.
5. **Bun compiled binary in v1.** Rejected (D-008): plugin loading from
   a compiled binary forced pi into virtual-module machinery; npm
   distribution defers that complexity until it pays.
6. **Single Entry type with a visibility flag instead of Entry +
   Record.** Rejected (D-013): conversation items and operation items
   have different lifecycles, validation rules, and readers.
7. **Lease-based multi-head ownership (pi-client's model).** Considered
   for the write contract; rejected for v1 (D-016) in favor of the
   single-writer mailbox plus `expectedRevision`: linearization by
   construction with less machinery, and leases can layer on later
   without protocol breakage.

## Implementation Plan

Phases (dependency-ordered; milestones belong to DECOMPOSE):

1. **Foundations**: repo scaffold (pnpm workspace, tsc, Biome, Lefthook),
   failure taxonomy, Schema-first journal - JSONL and in-memory layers,
   tree, root entry, leaf-moved records, torn-tail recovery, records
   with pre-provisioned ids and replay policy (D-022), compaction span
   semantics - conformance suite, context fold. Verifiable entirely by
   tests; no provider needed.
2. **Kernel + ai seam + driver head**: single-writer mailbox, turn
   execution against a fake provider layer, then the pi-ai seam with its
   contract fixtures; tool execution (bounded concurrency, call-order
   results, scoped interruption); steering/follow-up/abort; retry and
   overflow policies; crash recovery over records (D-022). The
   in-process driver head drives all of it (D-021).
3. **Plugin system**: manifests, registries, generic hook emitter,
   capabilities, trust with digest binding (D-015), hot reload with
   drain barrier; first-party plugins for compact and session naming
   exercised through the driver head (the dogfood proof, D-005).
4. **Wire protocol + heads**: snapshot/progress protocol, print and json
   heads, then rpc; plugin-contributed commands over invoke-command;
   snapshot-size measurement informing pagination (D-017).
5. **Verification hardening**: crash-simulation suites over the Phase
   1-2 recovery contracts, conformance suites published, recorded-
   journal fixture harness, docs.

Go/no-go between phases: each phase's public contracts are covered by
its conformance/fixture tests before the next begins.

## Open Questions

(Former questions on package layout and instruction-fragment triggering
were resolved at DECOMPOSE: <!-- D-023 --> D-023 pnpm workspace with
five packages; <!-- D-024 --> D-024 explicit-only fragments in v1.)

1. **Multi-head UI arbitration.** Which head answers interaction
   requests when several attach with interactive capability, and what
   owner-transfer/reconnect semantics does the TUI need? Deferred to the
   TUI-head plan; the protocol invariants it builds on are fixed in this
   RFC.
2. **Compaction default policy.** Threshold-triggered auto-compaction on
   by default (pi's behavior) vs manual-plus-overflow-only until the
   policy is proven? Journal shape is identical either way. Decide
   during Phase 2 with recorded-journal fixtures.

## References

**Normative**

- [CONTEXT.md](../../CONTEXT.md) - the vocabulary this RFC is written in
- [docs/research/pi-analysis.md](../../docs/research/pi-analysis.md) -
  source analysis; the keep/replace claims this RFC builds on
- [Effect v3 documentation](https://effect.website/docs) - Stream,
  Schedule, Scope, Layer, Schema semantics referenced throughout

**Informative**

- [earendil-works/pi](https://github.com/earendil-works/pi) - the studied
  system, including `packages/agent/docs/harness-v2.md` and
  `docs/rpc.md` (framing lessons for head authors)
- [@earendil-works/pi-ai on npm](https://www.npmjs.com/package/@earendil-works/pi-ai) -
  the provider dependency (exact-pinned, 0.84.x at time of writing)
- Plan ledger decisions D-001..D-027
  (`.plans/00-peye-coding-agent/plan.db`)
- Review round 1 report
  (`.plans/00-peye-coding-agent/artifacts/rfc-01-review-round-1.md`)
- Spike report (`.plans/00-peye-coding-agent/spike-report.md`)
