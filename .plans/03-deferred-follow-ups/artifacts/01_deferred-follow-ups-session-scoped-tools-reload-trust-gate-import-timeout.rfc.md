---
number: 01
title: "Deferred Follow-Ups: Session-Scoped Tools, Reload, Trust Gate, Import Timeout"
type: feature
status: Accepted
author: Kevin Frilot
date: 2026-08-11
---

# RFC-01: Deferred Follow-Ups: Session-Scoped Tools, Reload, Trust Gate, Import Timeout

## Abstract

Plan `02-cli-live-gaps` shipped with five recorded deferrals: per-Session Tool
visibility, a Plugin import timeout, opinionated trust-gate and tool-vetting
Plugins, a hot-reload trigger, and accepted test-hardening residuals. This RFC
specifies all five as one plan. The load-bearing changes are Turn-level
generation leasing in the kernel (which makes both Session-scoped Tools and
hot reload sound) and a Plugin-initiated interaction seam (which the gate
Plugins need and the protocol already carries on the wire). The default
`peye` posture is unchanged throughout: the gate Plugins are opt-in installs.

## Introduction

### Problem statement

Five deferrals from `02-cli-live-gaps` (its ledger D-006, D-010, D-025, and
Deferred follow-up section):

1. **Per-Session Tool visibility.** `ToolRegistryService` is Session-less and
   the ai seam captures `list()` once at Layer build, so every Session in one
   process sees the same Tools.
2. **Hot reload has no trigger and no consumer.** `makePluginRuntime` (swap,
   drain barrier, old-generation close) exists and is race-tested, but the
   CLI composes plugins through a one-shot `loadGeneration` and freezes its
   Tool registry, host services, grants, and audit fields at startup.
3. **Trust enforcement and Tool vetting are extension surfaces with no
   extensions,** and a gate Plugin that wants to ask the user cannot: nothing
   lets Plugin code initiate the protocol's interaction requests, no
   plugin-identity channel exists for attribution, and nothing at runtime
   emits `tool-call-gate`.
4. **A hanging Plugin import hangs startup** (02's D-010 known limitation).
5. **Accepted test residuals** (02's D-025).

### Scope

In scope:

- Kernel: Turn-level generation leasing; a Session-keyed `ToolRegistry`
  contract consumed by the turn loop, the ai seam, and `sessions.ts`
  recovery; contract-suite updates.
- Plugins package (all additive): a checkout/release lease primitive on
  `makePluginRuntime`; `importTimeoutMillis` on `LoadGenerationOptions`; the
  `PluginInteractions` service; a current-plugin identity set around
  contribution execution; an optional `sessionId` on the `tool-call-gate`
  input.
- Protocol (additive only): an optional `pluginName` field on interaction
  request frames; an optional `sessionId` already exists where needed.
  Older Heads ignore unknown optional fields; no existing frame changes.
- CLI: `makePluginRuntime` as the composition root; Session-keyed Tool
  resolution; the `/reload` first-party Command backed by a host control
  service; `RpcInteractions` wired to `PluginInteractions` (with a null
  Layer for print/json Heads that resolves every request's fallback
  immediately); the opt-in trust-gate and tool-vetting Plugins as linkable
  modules; `tool-call-gate` emission in the Tool adapter.
- Test hardening per 02's D-025 list.

Out of scope:

- A TUI Head (separate plan; it consumes this plan's seams).
- npm-referenced Plugin packages.
- Startup-interactive trust <!-- D-007 -->: at startup composition no
  interactive Head can exist yet, so the interactive trust path applies at
  reload time only in this plan; the TUI plan owns interactive startup.
- Changing the default posture. One stated carve-out <!-- D-010 -->: a
  default run gains the `/reload` Command (operational, not consent
  ceremony); everything else behaves exactly as today, and the gate Plugins
  never load unless the user installs them.
- Journal changes; non-additive protocol changes; print/json output-format
  changes.

### Context

Follows 02's decisions: auto-trust (02/D-002), capabilities as author
contract (02/D-003, 02/D-009), per-Session visibility named future work
(02/D-006), import timeout named limitation (02/D-010), residuals accepted
(02/D-025). This plan's ledger D-002..D-010 records the design choices,
including the review-driven revisions (D-005..D-010).

## Terminology

The key words MUST, MUST NOT, SHOULD, and MAY in this document are to be
interpreted as described in RFC 2119.

Domain terms per `CONTEXT.md`. Additional terms:

- **Generation**: one loaded set of Plugin instances (manifest + registered
  Contributions) produced by composition; `makePluginRuntime` routes work to
  the current generation and closes old ones after drain.
- **Generation lease**: a checkout that keeps a generation's resources open
  until released; the drain barrier is the mechanism that delays a
  generation's close until every lease on it is released.
- **Session Tool view**: the Tool list one Session exposes to the model,
  resolved from a leased generation and that Session's Capability grants.
- **Source stages**: discovery's stage-1 sources (user-global, out-of-tree)
  and stage-2 sources (project-local) - the loader's two-stage admission
  from plan 00 (named phase-1/phase-2 there; renamed here to avoid
  colliding with this plan's delivery phases).
- **PluginInteractions**: the capability-gated service through which Plugin
  code initiates interaction requests and awaits a response or the declared
  fallback.
- **Opt-in Plugin**: a first-party Plugin shipped as a linkable module that
  loads only when the user places or symlinks it into a Plugin source
  directory; never loaded by default. The trust gate and tool vetting are
  Opt-in Plugins; `/reload` is not (it is in the default set).

## Motivation

The TUI head - the next major plan - needs all of this: differing grants per
Session, reload during a live session, and interactive trust/vetting
prompts. Landing these now means the TUI plan builds on contracts instead of
compromises. The import timeout and test hardening close known robustness
debts while the area is warm.

## Design

### 1. Turn-level generation leasing (kernel + plugins)

<!-- D-005 --> One binding rule: **a Turn checks out its generation at Turn
open and holds the lease until the Turn settles.**

- `makePluginRuntime` gains an additive lease primitive:
  `checkout: Effect<GenerationLease, never, Scope>` where the lease exposes
  the generation and releases via its Scope. `use`/`useSerialized` remain
  and are re-expressed over checkout.
- Every provider request inside the Turn - the first request, tool-loop
  recursion, steering recursion, and transient retries - resolves Tools
  from the leased generation. One Turn never mixes generations.
- Compaction summarization requests carry NO Tool declarations (they
  summarize; they do not act). This is a behavior statement, not a change:
  the compaction path MUST NOT resolve a Tool view.
- Follow-ups bind at their own Turn open. A reload therefore takes effect
  at Turn boundaries: Turns opened after the swap use the new generation.
- Recovery caveat (documented, accepted): Tool identity in Records is by
  name; a crash recovered after a reload that redefined a same-named Tool
  replays against the new definition. Operators changing Tool semantics
  under a stable name across a crash boundary own that risk.

### 2. Session-keyed Tool contract (kernel)

- `ToolRegistryService` becomes `{ view(sessionId): Effect<SessionToolView> }`
  with `SessionToolView = { get(name), list() }` over `RegisteredTool`.
  `ToolRegistryLive(tools)` remains as the degenerate same-view constructor
  so existing kernel tests and simple hosts keep working.
- Consumers that migrate: the turn loop (resolves the view from the Turn's
  leased generation), the ai seam (`streamAssistant` receives the resolved
  declarations per request instead of capturing `list()` at Layer build;
  seam-internal signature, no pi-ai leak), and `sessions.ts` recovery
  (`availableToolNames` via `view(sessionId)`). `tool-batch.ts` is
  unaffected (it consumes the service contextually).
- Seam contract suite gains fixtures proving two Sessions with different
  views produce different provider `tools` arrays in one process.

### 3. CLI composition root and grants

- The CLI replaces its one-shot `loadGeneration` composition with
  `makePluginRuntime`. Registry, emitter, `PluginHost` services, Session
  Tool views, the grant union, and the Snapshot audit fields ALL resolve
  through the runtime's current generation at use time <!-- D-006 -->.
- Recomposition (startup and reload alike) is one function: discovery from
  the same options, generation load, displacement/collision guards,
  first-party registration - so a swapped generation always contains the
  first-party set (including `/reload` itself).
- Grants recompute at swap: Sessions' grant sets are the NEW generation's
  manifest union from their next Turn open; the Snapshot audit fields
  report the change. (CLI grants stay a union per 02/D-003; the contract
  is per-Session, the CLI policy is uniform.)

### 4. Import timeout (plugins)

- `LoadGenerationOptions.importTimeoutMillis` (default 30_000). A module
  import or factory invocation exceeding it fails that load with a typed
  `PluginLoadError` naming the file and the bound.
- Stated plainly: the timeout bounds COMPOSITION LATENCY only. Native ESM
  imports are not cancellable; a timed-out import's side effects may still
  run later, and repeated reload attempts (cache-busted specifiers)
  accumulate module registry entries. Neither startup fail-closed semantics
  (02/D-010) nor reload containment claims exceed this.

### 5. PluginInteractions seam

<!-- D-009 -->

- New service in `@pop-eye/plugins`:
  `PluginInteractions.request(request) -> Effect<InteractionResolution>`.
  The emitter sets a current-plugin identity (FiberRef) around every
  contribution execution; `request` reads it and stamps the originating
  Plugin name. Requests MAY carry a `sessionId` when the calling context
  has one (the `tool-call-gate` input gains an additive optional
  `sessionId`; the trust Hook has none and its requests are routed
  session-less to any attached interactive Head).
- Protocol: interaction request frames gain an additive optional
  `pluginName` so Heads can attribute prompts. Older Heads ignore it.
- Capability-gated on the Session's grants like every Capability
  <!-- D-010 -->; without a grant, `request` resolves the declared fallback
  with a diagnostic naming the missing grant (fail to fallback, never fail
  the Hook). Stated plainly: under the CLI's union policy (02/D-003) a
  Plugin declaring `interaction` is thereby granted it - declaration is
  sufficient in the CLI by policy, and the manifest plus Snapshot audit
  fields are where that power is visible.
- Timeout layering: a gate-raised interaction MUST use a timeout that fits
  inside the emitter's 30s Hook timeout with margin (gate Plugins default
  to 25s), so the interaction fallback - not the Hook timeout - decides
  the outcome. `RpcInteractions.request` gains interruption finalizers
  that remove the pending entry, so an interrupted request can neither
  deliver a stale prompt on a later attach nor block its id.
- CLI wiring: rpc mode provides the live Layer over `RpcInteractions`
  (attached interactive Heads receive requests; pending requests deliver
  on attach; timeout resolves the fallback). print/json modes - and
  startup composition in every mode <!-- D-007 --> - provide the null
  Layer: every request resolves its fallback immediately. No stalls in
  headless runs, ever.

### 6. Opt-in gate Plugins

- Shipped under `@pop-eye/cli` as linkable modules (documented: symlink or
  copy into `~/.peye/plugins/`). Never in the default set.
- **Trust gate** (contributes to the `trust` Hook point): on
  `prompt_required`/`reprompt_required` raises a confirm interaction
  (project path, digest, change summary; timeout 25s; fallback
  `untrusted`) <!-- D-002 -->. At startup the null PluginInteractions
  resolves that fallback immediately: with the gate installed, unknown
  project code is denied fast and headless-safe. At reload over rpc with
  an interactive Head attached, the Head answers. Fail closed on timeout,
  detach, and missing grant.
- **Tool vetting** (contributes to `tool-call-gate`): raises a select
  (allow once / allow for session / reject; timeout 25s; fallback reject)
  per Tool call. Session memory lives in Plugin state and is
  generation-scoped: a reload forgets prior allows (documented; the
  fail-closed direction).
- **Emission path** <!-- D-008 -->: the CLI Tool adapter emits
  `tool-call-gate` around `execute` - after `tool_started` progress, before
  the Tool runs. A rejection becomes a model-visible error Tool result in
  the call's journal position (the same shape as any failed Tool), never a
  Turn failure. No contributor installed → the emitter's FirstWins default
  allows (existing semantics; zero cost in the default run).

### 7. `/reload` Command and generation swap

<!-- D-003, D-006 -->

- A first-party `reload` Command contribution in the DEFAULT set (the
  stated posture carve-out). Its execute calls a CLI host control service
  injected through the Command execution context; the swap itself runs on
  a host fiber OUTSIDE any generation lease, so the Command cannot
  deadlock on the lease it was invoked under.
- Swap sequence: recompose (Design 3's one function, same options as
  startup) → new generation serves Turn opens → drain barrier waits for
  old-generation leases (in-flight Turns) → old generation closes. The
  Command's result reports old/new generation ids and Plugin/Tool count
  deltas; Snapshot audit fields reflect the new generation.
- Failure containment: a failed recomposition (bad Plugin, name collision,
  import timeout) leaves the current generation serving and returns the
  typed error as the Command result. A drain that exceeds the drain
  timeout (default 120s) fails the reload the same way - both generations
  stay alive until the drain actually completes; nothing is force-closed.
- Concurrency: a `/reload` while a swap or drain is in progress rejects
  with a typed busy error (resolves prior Open Question 2).
- Trust on reload: recomposition re-enters the trust flow. With the gate
  installed and no interactive answer, stage-2 sources resolve untrusted
  and the NEW generation loads without project Plugins - a successful swap
  with reduced content, reported in the Command result's counts and the
  audit fields (this is the gate doing its job, distinct from a failed
  reload).

### 8. Test hardening (02/D-025)

- rpc soak captures raw stdout bytes and asserts frame integrity on byte
  boundaries; ordering assertions move to provider-start order per
  Session; loose assertions tightened.
- Deterministic kernel test: abort delivered between provider retry
  attempts (attempt 1 fails transient, abort lands during backoff) asserts
  one provider start, stop reason `aborted`, Session usable afterward.

## State Machine

Generation lifecycle in the CLI runtime:

```
serving(A) --/reload--> composing(B)
  composing fails (load error, collision, import timeout) -> serving(A) + typed error result
  composing succeeds -> swapped: Turn opens lease B; draining(A)
    all A leases released -> A closes -> serving(B)
    drain timeout (120s) -> reload reports failure; A and B both live until
                            A's leases actually release; new Turns stay on B
  /reload during composing|draining -> typed busy rejection
```

Turn binding: lease checked out at Turn open, released at settle; every
provider request and Tool execution in the Turn uses that lease's
generation; compaction requests carry no Tools; follow-ups lease at their
own Turn open.

## Error Handling

Existing taxonomy plus two additive typed errors in the plugins package
(import timeout as a `PluginLoadError` cause; reload-busy as a typed
Command error).

- Import timeout: `PluginLoadError` naming file and bound. Startup:
  fail-closed exit 2 (unchanged). Reload: contained failure, current
  generation serves.
- Reload failure (any recomposition error): typed error as the Command
  result; serving generation untouched; diagnostics name the failing
  Plugin.
- Drain timeout: reload reports failure; no force-close; both generations
  live until leases release; a diagnostic reports the sessions holding
  leases.
- Reload while busy: typed busy rejection.
- `PluginInteractions` without a grant: fallback resolution + diagnostic.
- Interaction timeout / Head detach / interrupted request: declared
  fallback; pending entry removed by finalizer; existing
  `InteractionTimeout` reporting unchanged.
- Trust-gate fallback denial: stage-2 sources excluded as an explicit
  untrusted decision (existing path); on reload this is a SUCCESSFUL swap
  with reduced content, reported as such.
- Vetting rejection: model-visible error Tool result in call order;
  never a Turn failure.
- Session view resolution failure: fails that provider request as a turn
  error (existing taxonomy), never the process.

## Security Considerations

- **Default posture unchanged** except the stated `/reload` carve-out. No
  default-run consent ceremony; the gate Plugins are Opt-in Plugins;
  `PluginInteractions` in a default run resolves fallbacks immediately
  (null Layer) or requires an attached interactive Head (rpc).
- **The gates have teeth where they can.** Trust gate: startup and
  headless deny unknown project code immediately; reload-time prompts are
  answerable over rpc. Vetting: unconfirmed Tool calls reject. All
  fail-closed on timeout, detach, interruption, and missing grant.
- **Attribution.** Interaction requests carry the originating Plugin name
  (stamped by the emitter's identity FiberRef, not self-reported), so
  Heads can attribute prompts and a malicious Plugin cannot impersonate
  another. The social-engineering surface of Plugin-initiated prompts is
  bounded by the `interaction` Capability being visible in manifests and
  audit fields - and by the stated CLI policy that declaration suffices
  (02/D-003's union), which is consent-by-install, same as every Plugin
  power.
- **Reload is same-user, same-config.** Recomposition uses the startup
  options; `--no-project-plugins` is honored on every recomposition;
  `/reload` cannot widen sources.
- **Import timeout is latency defense, not sandboxing** (Design 4's
  statement governs).
- **Blast radius unchanged** from 02: installing a Plugin remains the
  consent boundary; nothing here executes code that would not already
  execute.

## Alternatives Considered

1. **Config-file allowlist for the trust gate.** Rejected <!-- D-002 -->
   for v1: a new file format to own; can layer into the same Plugin later.
2. **File-watcher or SIGHUP reload.** Rejected <!-- D-003 -->: watcher
   lifecycle/debounce complexity; signals invisible to rpc Heads.
3. **Defer the kernel seam again.** Rejected <!-- D-004 -->: reload needs
   dynamic Tool resolution regardless; the TUI needs per-Session grants.
4. **Attempt-level generation pinning.** The draft design; rejected
   <!-- D-005 -->: a tool-loop Turn would mix generations mid-Turn,
   breaking Tool identity continuity in the journal and recovery.
5. **Deferred stage-2 loading for startup-interactive trust.** Honest but
   a two-stage composition rework the TUI plan is better placed to own;
   rejected for this plan <!-- D-007 -->.
6. **Enabling the gate Plugins by default.** Rejected: reverses 02/D-002.
7. **A kernel-owned vetting prompt.** Rejected: dogfood rule - vetting is
   expressible as a contribution, so it must be one.

## Implementation Plan

Delivery phases (independent PRs to `main`, cross-family review each):

1. **Phase 1 - Leasing and Session-scoped Tools.** Plugins lease
   primitive; kernel registry contract, turn-loop leasing, seam
   per-request declarations, `sessions.ts` migration; contract suites;
   CLI Session-keyed resolution (still one startup generation).
2. **Phase 2 - Composition root and reload.** CLI on `makePluginRuntime`;
   the one recomposition function; `/reload` Command + host control
   service; grant recompute; audit-field refresh; drain-timeout and busy
   semantics; race/drain tests.
3. **Phase 3 - Interactions and gates.** Import timeout; identity
   FiberRef; `PluginInteractions` + grants gating + null/live Layers;
   additive protocol field; `tool-call-gate` emission in the adapter;
   opt-in trust-gate and vetting Plugins; scripted-interactive-head tests
   over rpc; live-harness reload and gate cases.
4. **Phase 4 - Hardening.** 02/D-025 items.

## Open Questions

None. The draft's two questions were resolved during review: attribution
is an additive protocol field <!-- D-009 --> (no reusable field exists);
concurrent `/reload` rejects with a typed busy error <!-- D-006 -->.

## References

### Normative

- This plan's decisions ledger (`.plans/03-deferred-follow-ups/plan.db`).
- `.plans/02-cli-live-gaps/plan.db` - inherited decisions (02/D-002,
  D-003, D-006, D-009, D-010, D-025).
- `packages/kernel/src/tool.ts`, `turn.ts`, `ai/seam.ts`, `sessions.ts` -
  Session-scoping and leasing surfaces.
- `packages/plugins/src/generation.ts` (`makePluginRuntime`), `loader.ts`,
  `hook-points.ts`, `emitter.ts`, `capability.ts` - plugins surfaces.
- `packages/protocol/src/interactions.ts` - the additive field.
- `packages/cli/src/plugins/pipeline.ts`, `tools/adapter.ts`,
  `heads/rpc.ts`, `compose.ts`, `entry/run.ts` - CLI surfaces.

### Informative

- `CONTEXT.md`; `docs/plugin-authoring.md`; archived RFCs under
  `.plans/02-cli-live-gaps/artifacts/`.
