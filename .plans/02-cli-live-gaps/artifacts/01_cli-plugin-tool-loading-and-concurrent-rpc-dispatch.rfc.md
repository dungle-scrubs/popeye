---
number: 01
title: "CLI Plugin Tool Loading and Concurrent RPC Dispatch"
type: feature
status: Accepted
author: Kevin Frilot
date: 2026-08-11
---

# RFC-01: CLI Plugin Tool Loading and Concurrent RPC Dispatch

## Abstract

The shipped `popeye` command cannot expose Tools to the model and cannot process an
`abort` frame while an rpc Turn is running. Both gaps were found by the CLI
live-integration harness after plan `01-cli-entry` closed; both are composition
gaps, not missing machinery - discovery, Trust, generation loading, Capabilities,
and the kernel mailbox all exist and are tested. This RFC specifies how the CLI
composes the Plugin pipeline (with a do-not-get-in-the-way Trust posture), how
Plugin-contributed Tools reach the kernel ToolRegistry, and how the rpc Head
dispatches frames through per-Session ordered queues with control-frame bypass
so `abort` stays reachable mid-Turn.

## Introduction

### Problem statement

Two findings from the `01-cli-entry` ledger (findings 2 and 3):

1. **Tools never reach the model.** `run.ts` composes `ToolRegistryLive([])` - a
   permanently empty registry - and runs no Plugin discovery, Trust resolution,
   or generation loading. Plugin Commands work through `invoke-command`, but
   Plugin-contributed Tools are never adapted into the kernel ToolRegistry, so
   a real model driving the shipped binary has no hands.
2. **The rpc Head reads frames sequentially.** The frame loop
   (`rpc.ts`, `Stream.runForEach`) awaits each handler before reading the next
   frame. The `prompt` handler does not respond until the Turn settles, so an
   `abort` frame sits unread for the whole Turn it is meant to abort -
   abort-over-rpc is unreachable.

### Scope

In scope:

- CLI composition of the existing Plugin pipeline: two-phase discovery, the
  constant auto-trust decision over an in-memory TrustStore, generation
  loading, Contribution registration.
- The adapter from Tool Contributions to the kernel ToolRegistry, built
  per process after generation load, including duplicate-name shadowing and
  the self-declared Capability rule.
- Capability grant policy for CLI Sessions.
- Per-Session ordered frame dispatch in the rpc Head, with control-frame
  bypass and a serialized writer.
- Emission of the reserved `capabilityGrants` and `loadedGeneration` Snapshot
  fields so clients can audit the loaded runtime.

Out of scope (unchanged v1 deferrals or separate plans):

- Hot reload of Plugin generations in the CLI (machinery exists; no CLI
  trigger is added by this RFC, so one generation lives for the process
  lifetime).
- A TUI Head, npm-referenced Plugins, snapshot pagination.
- Any built-in Trust-enforcing or Tool-vetting Contribution (the hook points
  exist; shipping opinionated gate Plugins is future work).
- Kernel, journal, protocol, and plugins package behavior changes. This RFC
  composes existing package APIs; it does not modify them.
- Per-Session Tool visibility. <!-- D-006 --> The kernel
  `ToolRegistryService` is Session-less and the ai seam captures the Tool
  list at Layer construction, so Session-keyed visibility requires a kernel
  seam change deferred as named future work; v1 builds one per-process
  registry (see Design 3).

### Context

The design follows pi-coding-agent's posture: the host does not interpose
consent ceremony between the user and their project. Security boundaries that
plan `00-popeye-coding-agent` built (Trust prompting, Capability consent) become
opt-in extension surfaces rather than default friction. See Security
Considerations for the full inventory.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as
described in RFC 2119.

Domain terms (Session, Journal, Turn, Plugin, Contribution, Tool, Command,
Hook, Capability, Trust, Head, Progress, Snapshot) are used as defined in the
repository `CONTEXT.md`. Additional terms:

- **Generation**: one loaded set of Plugin instances produced by
  `loadGeneration`; in this RFC's scope the CLI loads exactly one generation
  per process.
- **Phase-1 sources**: user-global Plugins and CLI-passed paths resolving
  outside the project tree; loadable before any Trust decision.
- **Phase-2 sources**: project-local Plugins; loadable only after Trust
  resolves `trusted`.
- **Frame**: one LF-delimited JSON message on the rpc Head's stdin or stdout.
- **Control frame**: an inbound frame whose handler bypasses Session queues:
  `abort` and `interaction-response`.
- **Session queue**: the per-Session FIFO through which all non-control
  frames for one Session dispatch in stdin arrival order.
- **Serialized writer**: a HeadWriter whose whole-frame writes are mutually
  excluded so concurrent fibers cannot interleave bytes within one output
  frame.

## Motivation

popeye's pitch is durable, extensible coding-agent hosting, and the dogfood
rule says all behavior arrives through Plugins. A shipped CLI whose model
cannot call any Tool delivers neither. The rpc Head is the embedding surface
every future interactive Head (TUI, SDK, IDE) will sit on; a head contract
whose `abort` is unreachable mid-Turn is quietly false in the one mode that
exists to be driven programmatically. Closing both gaps is the difference
between "the kernel supports it" and "the shipped `popeye` command does it."

## Design

### 1. Plugin pipeline composition in the CLI

`run.ts` currently builds `ToolRegistryLive([])` and a static
`FirstPartyPluginHostLive`. It MUST instead compose the existing
`@popeye/plugins` pipeline at startup, before Head dispatch:

1. Build `PluginDiscoveryConfig` from the CLI environment: project path is
   the working directory; <!-- D-013 --> the user-global directory is
   `~/.popeye/plugins` (mirroring the hardcoded project-local
   `.popeye/plugins`); CLI-passed Plugin paths come from a new repeatable
   `--plugin <path>` flag (OPTIONAL; absent means no CLI sources).
2. Call `loadGeneration` with:
   - `trust: "trusted"` <!-- D-002 --> - the do-not-get-in-the-way posture.
     The CLI passes the constant, not a resolver.
   - <!-- D-008 --> a `TrustStoreMemory` layer: the auto-trust decision is
     re-resolved every run and never durably recorded. A persisted store
     would write `decidedBy: "user"` records no user made and would
     permanently pre-empt a future Trust-gate Contribution for unchanged
     digests. Digest computation and diagnostics still run; provenance
     stays accurate.
   - `grants`: see section 2.
   - Diagnostic sinks wired to the CLI's stderr logfmt logger (trust,
     registry, hook, and generation diagnostics MUST all be sinked; none may
     be silently dropped).
3. Register the first-party Plugins (`compactPlugin`, `sessionNamePlugin`)
   through the same registry as discovered Plugins. First-party Plugins MUST
   NOT bypass the registry (dogfood rule, unchanged).
4. <!-- D-011 --> The CLI MUST refuse to register a phase-2 (project-local)
   Plugin whose manifest name matches an already-loaded phase-1 Plugin,
   failing that Plugin's registration with a diagnostic naming both paths.
   Registration otherwise replaces same-name Plugins, which would let a
   project Plugin silently displace a user-global security-gate Plugin.
5. The loaded generation's ContributionRegistry and HookEmitter back the
   existing `PluginHost` service (`compactionGate`, `invokeCommand`),
   replacing the static registry `FirstPartyPluginHostLive` builds today.

<!-- D-010 --> Loading is fail-closed: `loadGeneration` fails as a whole if
any Plugin fails to import, construct, or register (this is the existing
library behavior - there is no per-Plugin skip). The CLI maps that failure to
`CliRunError` (`composition_failed`) with a diagnostic naming the file and
cause, and exits 2. `--no-project-plugins` is the escape hatch when a broken
project Plugin blocks unrelated work. Known limitation: a Plugin whose import
never settles (e.g. a hanging top-level `await`) hangs startup; an import
timeout requires a plugins-package change and is out of scope.

### 2. Capability grants

<!-- D-003 --> CLI Sessions auto-grant the union of manifest-required
Capabilities across all loaded Plugins:
`grants = createCapabilityGrants(sessionId, union(manifest.capabilities))`,
used everywhere the current code passes empty grants. There is no `--allow`
flag and no per-run consent step.

<!-- D-009 --> To keep the union from enabling cross-Plugin Capability
borrowing, the Tool adapter (section 3) MUST admit a Tool only when its
`requiredCapabilities` is a subset of its *own* Plugin's manifest
capabilities. A Tool that under-declares is skipped with a diagnostic naming
the Plugin and the missing manifest declaration. Capabilities remain:

- a Plugin-author contract (declare what your Tools need, or they stay
  unlisted);
- a diagnostic and audit surface (grant sets are logged at Session creation
  and emitted in Snapshots - see section 6) -

and are NOT a sandbox (see Security Considerations).

### 3. Tool adaptation into the kernel ToolRegistry

The kernel `ToolRegistryService` is `{ get(name), list() }`, synchronous and
Session-less, and the ai seam captures `list()` when the Provider Layer
builds. <!-- D-006 --> The adapter therefore builds ONE per-process registry
after generation load completes and before Driver composition:

- Resolve Tool Contributions from the loaded generation's
  ContributionRegistry via its grant-aware `list` with the process grant
  union (the registry's Capability filtering is the single Tool-visibility
  filter; the adapter MUST NOT re-implement it), then apply the
  self-declaration rule (D-009).
- Adapt each admitted `ToolContribution` to the kernel `Tool` shape (name,
  description, parameters Schema, execute, executionMode, replay,
  requiredCapabilities; the contribution's payload carries every field).
  Argument validation stays where it is today: the kernel Schema-validates
  before execution.
- <!-- D-007 --> Duplicate unqualified Tool names across Plugins are the
  adapter's to resolve - contribution keys are namespaced
  `plugin-name/thing`, so the ContributionRegistry never collides across
  Plugins and the kernel registry (keyed by bare name) is the first place
  the collision exists. Policy: closest scope wins - project-local shadows
  user-global shadows first-party; within one scope, manifest priority then
  lexical plugin-name order. Every shadowing MUST emit a diagnostic naming
  both Plugins and the surviving Tool. Shadowing MUST NOT be silent and
  MUST NOT fail startup.
- <!-- D-015 --> An empty adapted Tool set is valid degraded operation: the
  startup line reports the loaded Tool count, and a model Tool call against
  an unknown name remains a model-visible error result (existing kernel
  behavior). First-party Plugins contribute only Commands, so a Plugin-less
  project legitimately runs Tool-less.

Per-Session Tool visibility (differing grants per Session under one Driver)
is future work requiring a kernel seam change; it is out of scope (see
Scope).

### 4. Concurrent rpc dispatch

<!-- D-005 --> The rpc frame loop MUST only read, decode, and route. Routing
is per-Session ordered with control-frame bypass:

- **Session queues.** Every non-control frame for a Session dispatches
  through that Session's FIFO queue in stdin arrival order; a Session's
  handlers never overlap. Distinct Sessions dispatch concurrently.
  Sessionless commands (`create`, `list`) dispatch on their own queue in
  arrival order. This preserves command semantics (`set-model` then `prompt`
  applies the model first) without the kernel seeing reordered enqueues.
- **Control frames.** `abort` and `interaction-response` handlers fork
  immediately, bypassing the target Session's queue - that is what makes
  abort reachable while a `prompt` handler occupies the queue. An `abort`
  arriving before its target Turn has registered resolves as the existing
  `abortTurnNotAborted` result; the client observes it and MAY retry.
- **Bounds.** Session queues and the control-bypass fiber set are bounded
  with a generous default; exceeding a bound rejects the frame with a wire
  error diagnostic (mirroring the bounded-sliding posture Progress buffers
  already have). This closes the unbounded-fork surface.
- **Response-effect ordering.** Because a Session's handlers are sequential,
  a handler MUST complete its side effects (state installed in
  `attached`/`interactiveHeads`/`progressSubscriptions`, interactions
  attached) before writing its response frame; the next command for that
  Session then observes them. The pre-existing read-then-remove race in
  `interactions.respond` is closed by the respond path claiming the pending
  entry atomically (single `Ref.modify`).
- **Serialized writer.** All frame output (responses, Progress, interaction
  requests, wire errors) MUST pass through one serialized writer with
  whole-frame writes. Progress subscription fibers MUST use the same
  writer. Within one Session, response frames follow queue order; Progress
  interleaving with responses carries no ordering guarantee (unchanged -
  Progress is disposable hints).
- **Writer failure.** A `HeadWriteError` (stdout closed) MUST stop the read
  loop and terminate the Head through the existing boundary - a Head that
  cannot write MUST NOT keep executing commands invisibly.
- **EOF.** When stdin closes, the Head stops reading, interrupts its own
  waiting handler fibers, and runs the existing cleanup. Commands already
  accepted by the kernel mailbox settle on their own fibers (existing
  mailbox contract - caller interruption does not cancel accepted work);
  the process exits when Driver teardown completes. A long-running Turn
  therefore MAY delay exit; clients that need immediate teardown send
  `abort` first.

### 5. Flag surface

New OPTIONAL flags, following the documented pi-style surface:

- `--plugin <path>` (repeatable): additional Plugin source. Paths resolving
  inside the project tree are classified project-local (existing
  classification).
- `--no-project-plugins`: skip ALL project-local sources - phase-2 discovery
  and <!-- D-014 --> project-local `--plugin` paths alike. The flag means
  "no project code". It does not ask; it does not load.

`--help` output MUST document both flags. No Trust-related flag exists.

### 6. Snapshot audit fields

<!-- D-012 --> The protocol Snapshot schema already reserves
`capabilityGrants` and `loadedGeneration`; no Head emits them today, so
nothing can audit what the auto-trusted runtime loaded. The rpc and json
Heads MUST populate both fields from the loaded generation and the Session's
grant set. This is the observability half of the do-not-get-in-the-way trade:
the host never asks, so it MUST always tell.

## State Machine

No new states. The Turn state machine and Head exit codes are unchanged. The
rpc Head's frame handling changes from

```
read frame -> handle (await) -> read frame
```

to

```
read frame -> decode -> route:
  control frame (abort, interaction-response) -> fork (bounded)
  other frame -> enqueue on Session queue (bounded, FIFO, one worker per Session)
                  -> handler: effects, then response via serialized writer
stdin EOF    -> stop reading -> interrupt waiting handler fibers
             -> cleanup (detach heads, interrupt Progress fibers)
             -> Driver teardown settles accepted work -> exit
```

## Error Handling

Existing taxonomy only; no new error types.

- Plugin load failure (import, construct, register, phase-1 name collision):
  `CliRunError` (`composition_failed`) naming the file and cause; exit 2.
  <!-- D-010 --> Fail-closed; `--no-project-plugins` is the bypass.
- `TrustStoreError` / digest errors at startup: `CliRunError`
  (`composition_failed`), exit 2 - host defect, not a Plugin defect.
- Tool-name shadowing: NOT an error - diagnostic naming both Plugins
  (D-007). `DuplicateToolName` from the kernel registry is unreachable once
  the adapter shadows deterministically; if it fires anyway it is a defect
  and fails composition.
- rpc handler failures: wire error correlated by command `id` when one was
  given; the read loop and sibling Sessions are unaffected (unchanged
  `wireErrorFromFailure` mapping).
- rpc queue/bypass bound exceeded: wire error diagnostic naming the bound;
  the frame is rejected, the connection stays up.
- `abort` with no running Turn (including an abort that outraces its
  prompt): existing `abortTurnNotAborted` result; the client MAY retry.
- Writer failure (`HeadWriteError`): terminates the Head via the existing
  boundary; exit follows the existing exit-code contract.
- EOF with in-flight work: not an error; handler fibers are interrupted
  without emitting wire errors (there is no reader), accepted kernel work
  settles, exit code follows the existing contract.
- Tool execution failures: unchanged kernel behavior (error result Entry in
  call-order position; the model sees the error).

## Security Considerations

### Trust model

<!-- D-002 --> The default posture is pi-coding-agent's: running `popeye`
inside a project executes that project's Plugin code. Trust ceremony is not
the host's job; it is an extension surface. This is an explicit, recorded
trade: `cd untrusted-repo && popeye -p "..."` runs that repo's Plugins.

What remains structurally enforced (not removable by configuration):

- **Two-phase ordering.** Phase-1 (user-global, out-of-tree) Plugins load
  before any project code; phase-2 (project-local) code cannot influence its
  own admission. A CLI-passed path inside the project tree is classified
  project-local (existing hardening, retained). <!-- D-011 --> A phase-2
  Plugin cannot displace a phase-1 Plugin by reusing its name.
- **Accurate provenance.** <!-- D-008 --> Auto-trust is never durably
  recorded: the CLI's in-memory TrustStore means no `decidedBy: "user"`
  record exists that a user did not make, and a future Trust-gate
  Contribution sees accurate fresh state every run.
- **Fail-closed gates.** Gate Hook failures and timeouts reject, naming the
  Plugin (existing emitter semantics).
- **Boundary validation.** Tool arguments, Command arguments, and protocol
  frames are Schema-validated with excess-property errors; rpc frames are
  capped at 1 MiB; rpc Session queues and control bypass are bounded;
  secrets enter via environment only (`--api-key` stays rejected).

What becomes an opt-in Contribution (the extension surfaces already exist):

- **Trust enforcement**: the `trust` Hook point
  (`TrustDecisionProvenance: "hook"`) lets a phase-1 Plugin answer or veto
  Trust for phase-2 sources. An opinionated "ask me before loading project
  plugins" Plugin is expressible today, user-globally installed.
- **Tool vetting**: the `tool-call-gate` Hook point (FirstWins gate,
  fail-closed, 30s timeout) lets a Plugin veto individual Tool calls - the
  permission-prompt analog. It ships with no default contributor.
- **Compaction vetoes**: `compaction-gate` (already dogfooded by the compact
  Plugin).

### Stated limitations

- **Capabilities are visibility filtering, not sandboxing.** Plugin module
  code executes at import time regardless of any grant, and a Tool that
  omits `requiredCapabilities` can still do arbitrary work when executed.
  The self-declaration rule (D-009) polices listing, not runtime power.
- **Digests do not cover transitive imports.** A project Plugin importing a
  file outside the Plugin directories executes changed code under an
  unchanged digest; there is also a check-to-import interval. With the
  in-memory store this affects diagnostics only, not a persisted decision.

### Blast radius

Worst case in the default posture: a malicious repository's Plugin executes
arbitrary code with the user's OS privileges the moment `popeye` runs there.
That equals the risk of running that repository's own tooling (npm scripts,
Makefiles) and matches pi's posture. Mitigations available without changing
the posture: `--no-project-plugins`, or a user-global Trust-gate Plugin.
The rpc change keeps the existing input surface (stdin frames, validated,
1 MiB cap) and bounds all new concurrency; the audit fields (D-012) make the
loaded runtime observable to clients.

### Injection resistance

Unchanged: Tool results and Plugin instruction fragments enter model Context
as content, and the Context fold's visibility rules exclude
non-model-visible Entries. This RFC adds no new model-visible channel.

## Alternatives Considered

1. **Fail-closed Trust with a `--trust` flag.** Attractive as the
   conservative default and the original plan-00 intent. Rejected <!-- D-002 -->:
   it interposes host ceremony pi users do not have, punishes the common case
   (your own repos) to theoretically protect the rare one, and the same
   boundary is expressible as an opt-in phase-1 Contribution without any host
   flag.
2. **`--allow` Capability consent flag.** Rejected <!-- D-003 -->: a coding
   agent whose every real run needs `--allow shell,fs-write` has friction as
   its default; Capability machinery stays valuable as author contract and
   diagnostics without being a second consent gate.
3. **Fork every rpc frame onto its own fiber.** The review's original
   direction (superseded decision D-004). Rejected <!-- D-005 -->: stdin
   order is lost before the mailbox (`set-model`/`prompt` reorder), protocol
   `id`s are optional so correlation cannot carry command semantics, fibers
   are unbounded, and every state-installing handler grows a
   response-before-effect race. Per-Session queues keep one ordering rule
   and confine concurrency to where it pays (across Sessions, and control
   frames).
4. **Fork only long-running rpc commands (`prompt`, `invoke-command`).**
   Rejected: two dispatch paths, and `invoke-command` duration is
   Plugin-dependent so the "long" set is unknowable.
5. **Session-keyed dynamic ToolRegistry.** The review's first design.
   Rejected <!-- D-006 --> for v1: the kernel interface is Session-less and
   the ai seam captures the Tool list at Layer build; faking per-Session
   visibility above a Session-less seam would be a lie. Deferred as named
   future work alongside a kernel seam change.
6. **Persisting the auto-trust decision in `TrustStoreLive`.** Rejected
   <!-- D-008 -->: it fabricates user provenance and permanently pre-empts a
   future Trust-gate Contribution for unchanged digests.
7. **Interactive TTY Trust prompt in print mode.** Rejected: v1 Heads are
   documented non-interactive; a prompt contradicts the shipped contract and
   still needs a headless answer anyway.

## Implementation Plan

Phased for the follow-on DECOMPOSE stage; order is tool loading first, rpc
second (independent, but tool loading is the product-defining gap):

1. **Phase 1 - Plugin pipeline in the CLI.** Discovery config
   (`~/.popeye/plugins`, `--plugin`, `--no-project-plugins`),
   `loadGeneration` with `trust: "trusted"` over `TrustStoreMemory`,
   first-party Plugins through the same registry, phase-1 displacement
   guard, fail-closed load mapping, diagnostics sinked. Verified by unit
   tests plus the live harness loading a fixture project Plugin.
2. **Phase 2 - Tool adaptation and audit surface.** Per-process adapter
   (grant-aware list, self-declaration rule, closest-scope shadowing,
   Tool-count startup line), manifest-union grants, Snapshot
   `capabilityGrants`/`loadedGeneration` emission. Verified end-to-end: a
   fixture Plugin Tool called by the fake provider through the shipped bin,
   and a live-harness model Turn calling a real Tool.
3. **Phase 3 - rpc per-Session dispatch.** Serialized writer, Session
   queues with bounds, control-frame bypass, response-after-effect ordering,
   atomic interaction claim, writer-failure termination, EOF semantics.
   Verified by an rpc harness test that aborts mid-Turn and by adversarial
   interleaving tests on the writer and queues.

Each phase lands green through the full local gate
(`build`, `typecheck`, `lint`, `test`, `check-boundaries`); the two ledger
findings in `01-cli-entry/plan.db` are resolved when their respective phases
merge.

## Open Questions

None. The three questions raised in the draft were resolved during review:
user-global directory <!-- D-013 --> `~/.popeye/plugins`; `--no-project-plugins`
<!-- D-014 --> also skips project-local `--plugin` paths; rpc concurrency
<!-- D-005 --> is bounded per-Session queues, closing the backpressure
question.

## References

### Normative

- `CONTEXT.md` - ubiquitous language this RFC's terms are drawn from.
- `.plans/01-cli-entry/plan.db` findings 2 and 3 - the gaps this RFC closes.
- The decisions ledger in `.plans/02-cli-live-gaps/plan.db` - the recorded
  posture and mechanism choices this RFC specifies (D-004 is superseded by
  D-005; landing decisions recorded at DECOMPOSE live there too).
- `packages/plugins/src/generation.ts` (`LoadGenerationOptions`),
  `trust.ts` (`TrustStoreMemory`), `discovery.ts`, `sources.ts`,
  `registry.ts` - the pipeline being composed.
- `packages/kernel/src/tool.ts` (`ToolRegistryService`, `Tool`) - the
  adaptation target.
- `packages/cli/src/entry/run.ts`, `packages/cli/src/heads/rpc.ts`,
  `packages/cli/src/compose.ts` - the composition sites this RFC changes.

### Informative

- `docs/research/pi-analysis.md` - source review behind the pi-posture
  precedent.
- `docs/plugin-authoring.md` - the Plugin-author contract Capabilities belong
  to.
- `docs/adr/0001-journal-is-the-only-representation.md` - why Heads trust
  Snapshots, background for treating Progress interleaving as unordered.
