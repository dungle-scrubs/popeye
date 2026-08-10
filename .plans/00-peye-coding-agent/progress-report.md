# peye v1 - Progress Report

> Auto-generated from implementation plan. This is the canonical
> source of truth for what is done and what remains. Update this
> file as features are implemented - never mark a milestone complete
> until every current-cutoff checkbox under it is checked.

> Current focus: Phase 2 - Kernel, ai seam, driver head

## Phase 1: Foundations

### M1: Workspace scaffold
Source: `implementation.md` (M1); D-023, D-008

- [x] pnpm workspace builds five packages (`@peye/journal`, `@peye/kernel`, `@peye/plugins`, `@peye/protocol`, `@peye/cli`) via tsc project references
- [x] `pnpm lint` runs Biome across all packages
- [x] `pnpm test` runs vitest across all packages
- [x] Lefthook pre-commit runs lint + typecheck
- [x] Node engines field enforces >= 24
- [x] Import-boundary check fails CI when a head imports kernel internals
- [x] Import-boundary check fails CI when any module other than the ai seam imports `@earendil-works/pi-ai`
- [x] Import-boundary check fails CI when a feature module imports kernel internals (dogfood rule)
- [x] A deliberately violating fixture proves each boundary check fires

### M2: Failure taxonomy and versioned line codec
Source: `implementation.md` (M2); Normative Contracts (failure taxonomy)

- [x] Every taxonomy error (`ProviderError`, `ToolError`, `GateRejected`, `StaleRevision`, `PluginLoadError`, `JournalError`, `ProtocolError`, `BudgetExceeded`, `InteractionTimeout`) constructs with its declared fields and round-trips them
- [x] Encoded journal lines carry a schema version envelope
- [x] Decoding a current-version line yields the typed value
- [x] Decoding an older-version line runs its registered migration chain
- [x] A migration gap in the registry fails typed naming the missing version (enforced at codec creation, which is stronger than the original decode-time wording; M2 review)
- [x] Decoding malformed JSON or a schema mismatch fails typed, never throws

### M3: Journal service and in-memory layer
Source: `implementation.md` (M3); Normative Contracts (journal rules)

- [x] Creating a session appends a root entry and reports it as the leaf
- [x] Appending an entry parents it to the current leaf and moves the leaf
- [x] Appending a record does not move the entry leaf
- [x] Moving the leaf to an earlier entry appends a leaf-moved record (no rewrite)
- [x] Branch read returns the root-to-leaf entry path for the current leaf
- [x] Records never appear in branch-entry reads
- [x] Leaf position reconstructs from records alone after close/reopen
- [x] Two sessions in one journal directory stay isolated
- [x] Entry ids are unique and stable across reopen

### M4: JSONL journal layer
Source: `implementation.md` (M4); Normative Contracts (journal rules)

- [x] Appends are acknowledged only after durable write
- [x] A torn (partial) unacknowledged tail line is truncated on open and the journal opens clean
- [x] Acknowledged lines are byte-identical after any recovery
- [x] An acknowledged record sequence violating single-writer invariants opens as `JournalError` with a named corruption class
- [x] Corruption is never repaired silently (assert no file mutation on reject)
- [x] Open/recovery emits structured diagnostics (file, action taken, corruption class if any)
- [x] JSONL layer passes every M3 behavior via the shared interface

### M5: Journal conformance suite
Source: `implementation.md` (M5)

- [x] Conformance suite exports as a package export parameterized by a `Journal` layer
- [x] In-memory layer passes the full suite
- [x] JSONL layer passes the full suite
- [x] A deliberately broken fixture layer fails with actionable assertion output

### M6: Compaction semantics and context fold
Source: `implementation.md` (M6); Normative Contracts (journal rules)

- [x] Compaction entry records summarized span (first/last ids), summary, and retained-tail ids
- [x] Fold with a compaction on the branch uses summary + retained tail + later entries only
- [x] Fold never reads entries older than the newest compaction on the branch (assert access)
- [x] Compaction-of-compaction folds correctly (newer covers older)
- [x] A branch created from an entry inside a summarized span folds without the other branch's compaction
- [x] Non-model-visible entry kinds are excluded by the single visibility boundary and nowhere else
- [x] Fold respects the token budget parameter
- [x] Budget unfittable even after compaction yields `BudgetExceeded` with the options diagnostic
- [x] Fold of an empty session (root only) yields an empty message sequence

## Phase 2: Kernel, ai seam, driver head

### M7: Single-writer mailbox and session lifecycle
Source: `implementation.md` (M7); D-016

- [x] All mutating commands for a session execute on one fiber in dequeue order
- [x] Concurrent commands from two callers serialize with no interleaving anomalies (stress test)
- [x] `expectedRevision` mismatch rejects with typed `StaleRevision` and does not queue
- [x] Matching `expectedRevision` proceeds; omitted `expectedRevision` proceeds
- [x] create/resume/list session commands work against the journal
- [x] Resuming a session restores leaf position and revision from the journal
- [x] Protocol command spans include sessionId and revision

### M8: Turn execution against fake provider
Source: `implementation.md` (M8); Normative Contracts (state machine)

- [x] Tool-free turn walks IDLE→ASSEMBLING→STREAMING→SETTLING→IDLE with well-formed entries
- [x] Phase transitions surface as structured progress
- [x] Assistant text/thinking deltas stream as progress during STREAMING
- [x] Final assistant entry persists with stop reason `done`
- [x] Provider failure after retries exhausted persists an error entry with stop reason `error` and settles (no throw)
- [x] Abort mid-stream persists the partial assistant entry with stop reason `aborted`
- [x] Every terminal path (done/failed/aborted) leaves a well-formed entry sequence (fixture-verified)
- [x] Turn spans carry sessionId + turn ordinal + entry ids

### M9: Tool execution
Source: `implementation.md` (M9); D-016

- [x] Tool batch runs with bounded concurrency (default 4, configurable)
- [x] A tool declaring sequential execution forces its whole batch sequential
- [x] Result entries append in call order under adversarial completion order
- [x] Completion order is visible only as progress
- [x] A failed tool yields an error result entry in its call-order position without blocking others
- [x] Tool arguments are Schema-validated before execution; invalid arguments become an error result the model sees
- [x] Interrupting a tool runs its Scope finalizers
- [x] Abort during a batch interrupts running tools and persists a coherent entry sequence

### M10: Steering, follow-up, abort semantics
Source: `implementation.md` (M10); Normative Contracts (state machine)

- [ ] `steer` during EXECUTING drains after the tool batch, before the next provider request
- [ ] `steer` during a tool-free turn drains at SETTLING (never lost)
- [ ] `prompt` during a running turn never throws; delivery mode `steer` steers, default queues as follow-up
- [ ] Follow-up opens the next turn after settle
- [ ] Abort discards queued steering and retains follow-ups
- [ ] Steering while IDLE is rejected as phase-invalid (steering requires a running turn)

### M11: Records and crash recovery
Source: `implementation.md` (M11); D-022

- [ ] Operation-started records carry intent and pre-provisioned result entry ids
- [ ] Recovery is a pure function of a bounded record slice (no journal scan beyond it)
- [ ] Kill after tool start with `replay: never` recovers to a synthesized interrupted-error result entry using the pre-provisioned id
- [ ] Kill after tool start with `replay: safe` re-executes the tool on recovery
- [ ] Recovery is idempotent: running it twice produces no duplicate entries
- [ ] Impossible record sequences reject with a named corruption class
- [ ] Recovery reports state what was found and what action was taken
- [ ] A recovered session accepts new prompts normally

### M12: ai seam
Source: `implementation.md` (M12); D-001, D-014, D-026; spike A-001

- [ ] Recorded pi-ai stream fixtures (text/thinking/toolcall interleavings) pass through the wrap order-faithfully
- [ ] Terminal error fixture converts to typed `ProviderError`, never a throw
- [ ] `ProviderError.transient` assigned via pi-ai's `isRetryableAssistantError`
- [ ] Terminal aborted fixture settles with stop reason `aborted`
- [ ] Fiber interruption fires the per-request `AbortController` and pi-ai receives the signal
- [ ] Interrupted request persists stop reason `aborted`
- [ ] Idle timeout on a stalled stream yields a transient `ProviderError`
- [ ] Provider request spans include attempt number and classifier verdict on failure
- [ ] No pi-ai type appears in any seam-external signature (lint-checked)
- [ ] `@earendil-works/pi-ai` is exact-pinned; the contract suite fails on a mutated fixture (drift detection proven)
- [ ] Live smoke: one real provider call completes a turn (gate 2→3 evidence)

### M13: Retry and overflow policies
Source: `implementation.md` (M13); Normative Contracts

- [ ] Transient `ProviderError` retries on exponential backoff up to the configured cap
- [ ] Permanent `ProviderError` never retries
- [ ] Retry exhaustion persists an error entry and settles the turn
- [ ] Context overflow triggers compact-then-retry exactly once per turn
- [ ] Compaction summarization requests are bounded slices (never the full overflowing context)
- [ ] Unsummarizable overflow yields `BudgetExceeded` with the options diagnostic
- [ ] Retry and compaction-trigger diagnostics surface as structured progress

### M14: Driver head
Source: `implementation.md` (M14); D-021

- [ ] Driver exposes every kernel primitive in-process (create/resume/list, attach/detach, prompt, steer, abort, snapshot, subscribe, branch/fork, set model, set thinking level)
- [ ] Scripted session (prompt → tool turn → steer → abort → branch) passes asserting snapshots and journal content
- [ ] Snapshot revision increments monotonically across the script
- [ ] Progress subscription delivers deltas during the script
- [ ] The scripted session is captured as the canonical recorded-journal fixture

## Phase 3: Plugin system

### M15: Manifests, registries, capabilities
Source: `implementation.md` (M15); D-019; Normative Contracts (plugin rules)

- [ ] Manifest Schema validates name, version, capabilities; invalid manifest is `PluginLoadError` naming the cause
- [ ] Contribution keys are namespaced `plugin-name/thing`
- [ ] Duplicate key resolves by declared priority with a diagnostic naming both plugins
- [ ] Capability grants are per session
- [ ] A tool requiring an ungranted capability is unavailable (not listed to the model) with a diagnostic
- [ ] A manifest-required ungranted capability fails the plugin load with a message naming the capability
- [ ] Grant set is visible in the snapshot
- [ ] All four v1 contribution kinds register (tools, commands, hooks, instruction fragments)
- [ ] Registering an unknown contribution kind fails typed (registry admits new kinds by extension, not silently)

### M16: Generic hook emitter
Source: `implementation.md` (M16); D-020; Normative Contracts (hook points)

- [ ] All twelve hook points execute through one generic emitter driven by declared semantics (no per-point emitter code)
- [ ] Chain composes contributions in priority order, each seeing the previous output
- [ ] FirstWins stops at the first decisive result
- [ ] Accumulate merges field-wise across contributions
- [ ] Tap contributions run on their own fibers
- [ ] Gate (FirstWins) contribution failure rejects (fail closed) naming the plugin
- [ ] Gate timeout (default 30s) is a rejection
- [ ] Chain/Accumulate contribution failure skips that contribution with a diagnostic (fail open)
- [ ] Tap failure is logged and dropped
- [ ] Tap queues are bounded sliding (drop-oldest) with a dropped-count diagnostic
- [ ] A deliberately slow tap does not extend turn latency (clocked test)
- [ ] Hook spans name the point, plugin, and outcome

### M17: Trust with digest binding
Source: `implementation.md` (M17); D-015

- [ ] Phase 1 loads only user-global and out-of-tree CLI plugins before any trust decision
- [ ] Untrusted project: no project-local plugin code executes (asserted via canary)
- [ ] A CLI-passed path resolving inside the project tree is classified project-local and cannot answer trust
- [ ] Trust decision records a content digest of project plugin files
- [ ] Unchanged digest: no re-prompt on subsequent loads
- [ ] Changed digest: re-prompt with a summary of changed files
- [ ] Trust decisions emit structured diagnostics (digest, scope, decision)
- [ ] Phase 2 reuses phase-1 plugin instances (no double-build)

### M18: Plugin loading and hot reload
Source: `implementation.md` (M18); D-027; spikes A-002/A-003

- [ ] Plugin `.ts` files load via native `import()` of absolute `file:` URLs (no loader dependency)
- [ ] Annotations, `import type`, generics, host-package imports, and relative sibling imports all load
- [ ] `enum`/`namespace` in a plugin fails load with a clear diagnostic naming the file and construct
- [ ] Reload re-imports via query-string cache busting with fresh module state
- [ ] Reload swaps the generation Ref; work started after the swap uses the new generation only
- [ ] In-flight turns finish on the old generation (drain barrier)
- [ ] Old generation Scope closes exactly once, after the last in-flight turn settles
- [ ] Reload is a mailbox command (cannot interleave mid-gate)
- [ ] Generation-swap diagnostics report old/new ids, drain duration, closed resources
- [ ] Race stress (100+ iterations) passes in CI

### M19: First-party plugins (dogfood proof)
Source: `implementation.md` (M19); D-005, D-021

- [ ] Compact command ships as a plugin using only the public plugin API
- [ ] Session-naming command ships as a plugin using only the public plugin API
- [ ] Both invoke through the driver head via invoke-command
- [ ] Import-boundary CI proves neither touches kernel internals
- [ ] Compact plugin's gate hook can veto or replace a compaction
- [ ] Plugin-author API surface documented from these two implementations

## Phase 4: Wire protocol and heads

### M20: Protocol schemas
Source: `implementation.md` (M20); D-017, D-021

- [ ] Schema frames exist for every kernel primitive and invoke-command
- [ ] Snapshot schema carries full transcript, phase, revision, model, thinking level, capability grants, loaded generation
- [ ] Entry-id addressing is present in the schema (pagination reserved)
- [ ] Interaction request frames carry id, kind (select/confirm/input), timeout, and declared fallback
- [ ] Malformed frames decode to typed `ProtocolError`
- [ ] The protocol package has zero kernel imports (package graph verified)

### M21: print and json heads
Source: `implementation.md` (M21)

- [ ] print head emits final assistant text only, exit 0 on stop reason `done`
- [ ] print head exits non-zero on stop reasons `error` and `aborted`
- [ ] json head emits one JSON item per line (progress and snapshots), pacing output by awaiting stdout
- [ ] Golden transcripts for scripted sessions are stable, including error and abort exits

### M22: rpc head
Source: `implementation.md` (M22); Normative Contracts (protocol rules)

- [ ] Strict LF-only framing; U+2028/U+2029 inside JSON strings pass through as content (adversarial fixtures)
- [ ] attach/detach lifecycle works; snapshots normalize `attached` per connection
- [ ] invoke-command routes plugin commands end-to-end
- [ ] Interaction request round-trips to an attached interactive head
- [ ] Interaction timeout resolves the declared fallback and reports `InteractionTimeout` to the plugin
- [ ] Head detach mid-interaction resolves the fallback
- [ ] A newly attaching head receives current snapshot plus pending interaction requests
- [ ] Per-subscriber progress buffers are bounded sliding; a slow subscriber drops progress but snapshots remain correct (drop counts reported)
- [ ] Frame errors emit typed `ProtocolError` diagnostics without killing the session
- [ ] An external process completes a full tool-using session via rpc (gate 4→5 evidence)

### M23: Snapshot-size measurement
Source: `implementation.md` (M23); D-017

- [ ] Snapshot payload sizes measured across recorded long sessions
- [ ] Report written to plan artifacts with thresholds comparison
- [ ] Pagination go/no-go recorded as a plan decision

## Phase 5: Verification hardening

### M24: Crash-simulation suite
Source: `implementation.md` (M24); D-022

- [ ] Kill-at-boundary matrix covers append ack, record write, tool start, tool end, generation swap
- [ ] Every cell recovers to a well-formed journal
- [ ] `replay: never` cells synthesize interrupted results; `replay: safe` cells re-execute
- [ ] Recovery reports match expected outcomes per cell
- [ ] Suite runs in CI from a clean checkout

### M25: Conformance publication and docs
Source: `implementation.md` (M25)

- [ ] Journal conformance suite published as a package export
- [ ] ai-seam contract suite published as a package export
- [ ] Recorded-journal fixture harness documented
- [ ] Plugin-author guide covers manifest, contributions, hooks, capabilities, prohibited syntax, reload semantics
- [ ] README opens with the problem peye solves
- [ ] Clean-room `pnpm add` consumer runs both published suites green

## Deferred follow-up

Source: RFC-01 Scope (archived); D-006, D-007, D-018, D-019

- [ ] TUI head plan (pi-tui reuse, renderer/theme contribution kinds, multi-head arbitration - RFC OQ1)
- [ ] SQLite journal backend (conformance suite is the contract)
- [ ] npm-referenced plugin packages (D-018 fast-follow)
- [ ] Model-requestable instruction fragments (D-024 fast-follow)
- [ ] Public release hardening (npm OIDC, supply-chain setup) via prepare-public-release

## Superseded/obsolete checklist debt

(none)

## Summary
- Total features: 177
- Completed: 67
- Remaining: 110
- Current cutoff blockers: 110
- Accepted/deferred follow-up: 11
- Superseded/obsolete checklist debt: 0
