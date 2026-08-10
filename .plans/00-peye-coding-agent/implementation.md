# peye v1 - Implementation Plan

Vocabulary: `CONTEXT.md` (normative). Ledger: D-001..D-027. Design
rationale and alternatives: archived RFC-01
(`artifacts/01_peye-v1-headless-effect-based-coding-agent.rfc.md`);
this document is self-contained for execution.

## ⚠️ Execution Protocol

A progress report exists at
`.plans/00-peye-coding-agent/progress-report.md`. It lists every
verifiable behavior for every milestone as a checkbox.

**Mandatory rules for all agents working on this plan:**

1. Before starting a milestone, run `plan-db check-progress --plan
   "00-peye-coding-agent"` and read its section in the progress
   report - those current-cutoff checkboxes are your spec
2. Check each box as you complete the feature, not at the end
3. A milestone is NOT done until every current-cutoff checkbox under
   it is checked
4. If you find features missing from the report, add them first
5. Never declare a phase complete without updating the current focus
   marker and Summary
6. Deferred follow-up and superseded/obsolete checklist debt must not
   be counted as current blockers
7. Fully deferred/tabled sections must be moved under Deferred
   follow-up; empty active sections must not remain between
   completed/current sections
8. `FP-<number>` references must be backed by real progress-report
   sections and checkboxes, not merely named

## Architecture

An append-only **journal** (entries + records) is the only durable
session representation <!-- D-004 -->; snapshots and model context are
pure folds of a branch; **progress** is a hint heads render but never
fold into state. A policy-free **kernel** runs turns behind a
per-session single-writer mailbox <!-- D-016 -->; retry, compaction, and
overflow recovery compose around it. One **ai seam** imports
`@earendil-works/pi-ai` (exact-pinned) <!-- D-001 --> and maps its prose
failures into `ProviderError` via pi-ai's own exported classifier
<!-- D-014 -->. A single **plugin** primitive <!-- D-003 --> carries all
behavior additions - including peye's own features <!-- D-005 --> - as
contributions (tools, commands, hooks, instruction fragments
<!-- D-019 -->) with declared hook merge semantics and failure policies
<!-- D-020 -->. Heads consume a snapshot-authoritative **protocol**
<!-- D-017 -->; kernel primitives and plugin-contributed commands are
split per <!-- D-021 -->. Implementation substrate is Effect v3 stable
core <!-- D-002 --> on Node 24+, npm-published <!-- D-008 -->.

```
heads: driver · print · json · rpc     (TUI later, pi-tui, D-007)
          |  protocol: commands in; snapshots+progress out;
          |            interaction requests
        kernel (single-writer/session; turns; steering)
        /            |              \
   journal        plugins         ai seam -> @earendil-works/pi-ai
 entries+records  registry/hooks/caps/trust
```

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Journal is append-only; acknowledged lines never rewritten | Leaf position must be a record; torn tails truncated on open; corruption rejected, never repaired |
| The word "event" is banned outside the ai seam <!-- D-010 --> | API names, docs, and progress vocabulary reviewed against CONTEXT.md |
| Only the ai seam imports pi-ai | Enforced by package graph <!-- D-023 --> + CI import lint |
| Dogfood rule <!-- D-005 --> | compact + session naming ship as plugins in Phase 3; CI fails on feature imports of kernel internals |
| Effect v3 stable only <!-- D-002 --> | No `@effect/platform` pre-stable deps in core packages; `Schema` from `effect` |
| Node 24+, pnpm workspace <!-- D-023 --> | Five packages: `@peye/journal`, `@peye/kernel`, `@peye/plugins`, `@peye/protocol`, `@peye/cli` |
| Instruction fragments explicit-only in v1 <!-- D-024 --> | Fold composition has no model-requestable discovery surface yet |

### Boundaries

- `@peye/journal`: entries, records, tree, folds' input surface, JSONL +
  in-memory layers, conformance suite. Owns schema versions/migrations.
- `@peye/kernel`: mailbox, turn execution, tool running, steering/
  follow-up/abort, retry/compaction/overflow policies, crash recovery,
  context fold, ai seam (sole pi-ai importer), driver head (test/SDK
  surface).
- `@peye/plugins`: manifests, registries, generic hook emitter,
  capabilities, trust, generations/hot reload, plugin loading.
- `@peye/protocol`: frame schemas, snapshot/progress types, command
  unions, interaction requests. No runtime deps on kernel.
- `@peye/cli`: wire heads (print, json, rpc), config, entry point.
  Depends on protocol (and kernel only for in-process hosting, via a
  single composition module).

New target files get module-level comments stating what the module owns
and why it exists (per-package `src/` seams are named in milestones).

### Normative Contracts (consolidated from RFC-01)

**Turn state machine** (kernel-internal; snapshot `phase` mirrors it):

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

Retries live inside STREAMING (`Schedule` around the provider call).
`GateRejected`/`ToolError` become error tool-result entries in
call-order position - never turn failures. Every turn, including failed
and aborted, terminates as a well-formed entry sequence. Phase-invalid
commands get typed rejections, never queues; `prompt` is never
phase-invalid (delivery mode queues it).

**Failure taxonomy** (each a `Data.TaggedError`): `ProviderError`
(seam-assigned, `transient` via pi-ai's classifier <!-- D-014 -->),
`ToolError`, `GateRejected`, `StaleRevision` <!-- D-016 -->,
`PluginLoadError`, `JournalError` (acknowledged-content corruption with
named class; torn tails are recovered, not errors), `ProtocolError`,
`BudgetExceeded` (carries options diagnostic), `InteractionTimeout`
(resolved by declared fallback).

**Journal rules**: append-only = acknowledged lines never rewritten;
unacknowledged torn tails truncated on open; session creation appends a
root entry; leaf position is durable via leaf-moved records; compaction
entries record summarized span + summary + retained-tail ids, newest
compaction on the branch governs the fold, compaction-of-compaction
allowed; operation records carry pre-provisioned result entry ids and
tool replay policy (`never` -> synthesized interrupted error result on
recovery; `safe` -> re-execute) <!-- D-022 -->.

**Hook points and semantics** <!-- D-020 -->: context (Chain), provider
request (Chain), input transform (Chain), input handling (FirstWins),
tool call gate (FirstWins), tool result (Accumulate), resource
discovery (Accumulate), compaction gate (FirstWins), trust (FirstWins),
turn lifecycle (Tap), progress (Tap), session lifecycle (Tap). Gates
fail closed with a 30s default timeout (timeout = rejection);
Chain/Accumulate contributions fail open (skipped + diagnostic); Taps
run on own fibers behind bounded sliding queues (drop-oldest + count
diagnostic). One generic emitter; no per-point bespoke emitters.

**Plugin rules**: manifest Schema-validated; namespaced keys
(`plugin/thing`); key conflicts resolve by declared priority with
diagnostic; capability grants are per session - ungranted makes the
contribution unavailable (or fails load if manifest-required);
capabilities are declaration/visibility, NOT an enforcement boundary -
trust is the control. Trust: two-phase load, project-tree paths are
project-local and cannot answer trust, content digest recorded and
re-prompted on change <!-- D-015 -->. Loading: native type stripping,
`file:` URL import, query-string cache busting; `enum`/`namespace`
rejected with diagnostic <!-- D-027 -->. Reload: generation `Ref` swap
+ drain barrier before old-`Scope` close; reload is a mailbox command.
Plugin state persists as entries (per-branch correctness on fork).

**Protocol rules**: snapshots authoritative with monotonic revision;
progress never folded into head state; full-transcript snapshots in v1
with entry-id addressing reserved <!-- D-017 -->; kernel primitives vs
plugin-contributed commands over invoke-command <!-- D-021 -->;
interaction requests carry timeout + declared fallback, resolve on
detach/timeout, and pending ones are delivered to newly attaching
heads; rpc framing is strict LF-only (U+2028/U+2029 are content, never
delimiters).

**Security posture**: no in-process sandbox claims; isolation is
OS-level, composed from outside; no credentials in the journal; no
request headers in diagnostics; prompt injection accepted residual risk
mitigated by capability-gated availability and gate hooks.

### Observability

Runtime work carries first-class observability (spans + structured
failure payloads + a user-visible inspection surface):

- Spans: turn, provider request (with retry attempt), tool execution,
  hook point execution (plugin-named), journal open/recovery, generation
  swap, protocol command.
- Correlation: sessionId + turn ordinal + entry ids appear on every span
  and diagnostic; plugin-originated failures always name the plugin.
- Inspection: the snapshot exposes phase, revision, capability grants,
  and loaded generation; diagnostics (dropped-progress counts, skipped
  hook contributions, gate timeouts) surface as structured progress
  items a head can render or a fixture can assert.
- Postmortem: recorded journals + the crash-sim suite double as the
  export format; provider request/response bodies are never logged
  (headers never, per RFC Security).

---

## Spike Learnings (validated 2026-08-10; see spike-report.md)

- A-001 (fail, resolved): wrap fidelity proven; cancellation is a
  request-level bridge - the seam owns an `AbortController` per request
  and wires fiber interruption to pi-ai's `signal` option
  <!-- D-026 -->. In M12.
- A-002 (pass): native Node 24 `import()` of plugin `.ts` by absolute
  `file:` URL; hot reload via query-string cache busting; `enum` and
  `namespace` prohibited in plugin syntax. No loader dependency
  <!-- D-027 -->. In M18.
- A-003 (pass): the M18 drain design validated verbatim under 120-run
  race stress (`Scope.make` + `Layer.buildWithScope` + `Ref` +
  `Deferred`).

---

## Phases

### Phase 1: Foundations

**Goal:** The journal, failure taxonomy, and context fold exist, fully
tested, with no provider or kernel.

**Gate from previous:** none (greenfield).

#### M1: Workspace scaffold

- **Dependencies:** none
- **Effort:** S
- **Testing:** test-after (toolchain config; verified by build/lint/test
  runs, not unit tests)
- **Tasks:**
  1. pnpm workspace with the five packages <!-- D-023 -->, tsc project
     refs, Biome, Lefthook, vitest, Node 24 engines field.
  2. CI: build, lint, test, plus the import-boundary check (heads only
     import protocol; only the ai seam imports pi-ai; feature modules
     do not import kernel internals <!-- D-005 -->).
  3. Verify: clean `pnpm build && pnpm lint && pnpm test` and a failing
     fixture proves the boundary check fires.

#### M2: Failure taxonomy and versioned line codec

- **Dependencies:** M1
- **Effort:** S
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: tagged error constructors; `Schema`-versioned
     line codec (encode/decode/migrate).
  2. RED: decode of a v1 line after a v2 schema change without a
     migration fails with the typed migration error.
  3. GREEN: version envelope + explicit migration function registry.
  4. RED: every RFC error tag constructs and round-trips its fields.
  5. GREEN: taxonomy module.
  6. REFACTOR: one error-module per package boundary re-exporting the
     shared taxonomy.

#### M3: Journal service and in-memory layer

- **Dependencies:** M2
- **Effort:** M
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: `Journal` `Context.Tag` interface - append entry/
     record, read branch, move leaf (as record), session create with
     root entry.
  2. RED: creating a session yields a defined leaf (root entry).
  3. GREEN: in-memory layer.
  4. RED: leaf position survives close/reopen purely from records.
  5. GREEN: leaf-moved records; branch resolution.
  6. RED: records never appear in branch-entry reads (fold input
     surface) <!-- D-013 -->.
  7. GREEN + REFACTOR.

#### M4: JSONL journal layer

- **Dependencies:** M3
- **Effort:** M
- **Testing:** test-first
- **Observability:** required (structured journal open/recovery
  diagnostics with named corruption classes)
- **Tasks:**
  1. Seams under test: same `Journal` interface over files; acknowledged-
     append semantics.
  2. RED: torn tail (partial last line) recovers to valid prefix on
     open; nothing acknowledged is altered.
  3. GREEN: atomic append + ack protocol + open-time recovery.
  4. RED: acknowledged record sequence violating single-writer
     invariants opens as `JournalError` with named class - never
     repaired.
  5. GREEN: validation on open.
  6. REFACTOR: extract shared tree/validation logic used by both layers.

#### M5: Journal conformance suite

- **Dependencies:** M4
- **Effort:** S
- **Testing:** test-first (the suite is the deliverable)
- **Tasks:**
  1. Package the M3/M4 behavioral tests as an exported conformance suite
     parameterized by layer.
  2. RED→GREEN: both shipped layers pass; a deliberately broken layer
     fixture fails with actionable output.

#### M6: Compaction semantics and context fold

- **Dependencies:** M3
- **Effort:** M
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: compaction entry (span, summary, retained tail);
     pure fold `(branch entries, budget) -> messages` with the single
     model-visibility boundary.
  2. RED: fold with newest compaction never reads older entries;
     compaction-of-compaction covered; branch into a summarized span
     folds without the other branch's compaction.
  3. GREEN: fold + coverage rules.
  4. RED: budget exceeded even after compaction yields `BudgetExceeded`
     with options diagnostic.
  5. GREEN + REFACTOR.

### Gate 1→2

- [ ] Conformance suite passes both journal layers
- [ ] Fold property tests (visibility boundary, compaction coverage)
      pass
- [ ] Import-boundary CI check enforced and demonstrated

### Phase 2: Kernel, ai seam, driver head

**Goal:** A full turn with tools runs against a fake provider and
against one real provider through pi-ai, driven in-process, with crash
recovery.

**Gate from previous:** Gate 1→2.

#### M7: Single-writer mailbox and session lifecycle

- **Dependencies:** M3
- **Effort:** M
- **Testing:** test-first
- **Observability:** required (protocol command spans; StaleRevision
  diagnostics)
- **Tasks:**
  1. Seams under test: per-session mailbox (one fiber, one
     interleaving) <!-- D-016 -->; create/resume/list;
     `expectedRevision`.
  2. RED: concurrent mutating commands from two callers serialize;
     interleaving equals dequeue order.
  3. GREEN: mailbox.
  4. RED: stale `expectedRevision` gets typed `StaleRevision`, never
     queues.
  5. GREEN + REFACTOR.

#### M8: Turn execution against fake provider

- **Dependencies:** M6, M7
- **Effort:** L
- **Testing:** test-first
- **Observability:** required (turn spans; phase transitions as
  structured progress)
- **Tasks:**
  1. Seams under test: turn state machine (RFC State Machine section);
     entry append points; stop reasons; progress stream.
  2. RED: tool-free turn: IDLE→ASSEMBLING→STREAMING→SETTLING→IDLE with
     well-formed entries.
  3. GREEN: minimal engine of the state machine over the fake provider
     layer.
  4. RED: provider failure after retries exhausted settles with error
     entry (never a throw).
  5. GREEN. 6. RED: abort mid-stream persists partial assistant entry,
     stop reason aborted. 7. GREEN + REFACTOR.

#### M9: Tool execution

- **Dependencies:** M8
- **Effort:** M
- **Testing:** test-first
- **Observability:** required (tool spans; call-order vs completion
  diagnostics)
- **Tasks:**
  1. Seams under test: bounded-concurrency batch runner; per-tool
     `Scope`; sequential flag; call-order result entries
     <!-- D-016 -->.
  2. RED: results append in call order under adversarial completion
     order; failed tool yields error result entry in position.
  3. GREEN. 4. RED: interruption runs tool finalizers.
  5. GREEN + REFACTOR.

#### M10: Steering, follow-up, abort semantics

- **Dependencies:** M9
- **Effort:** M
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: queues + drain points (post-batch; settling on
     tool-free turns); delivery modes; abort discard rules.
  2. RED: steering never lost on a tool-free turn.
  3. GREEN. 4. RED: abort discards steering, retains follow-ups.
  5. GREEN + REFACTOR.

#### M11: Records and crash recovery

- **Dependencies:** M8
- **Effort:** L
- **Testing:** test-first
- **Observability:** required (recovery reports: operation found,
  action taken, synthesized entries)
- **Tasks:**
  1. Seams under test: operation records with pre-provisioned ids;
     recovery as pure function of a bounded record slice
     <!-- D-022 -->.
  2. RED: kill-after-tool-start recovers to synthesized interrupted
     error result for `replay: never`; re-executes for `replay: safe`.
  3. GREEN. 4. RED: recovery of impossible record sequences rejects
     with named corruption class. 5. GREEN + REFACTOR.

#### M12: ai seam

- **Dependencies:** M8
- **Effort:** M
- **Testing:** test-first
- **Observability:** required (provider request spans with attempt
  numbers; classifier verdict on failures; abort-bridge firing)
- **Tasks:**
  1. Seams under test: `Provider` service wrapping pi-ai
     <!-- D-001 -->; `ProviderError` mapping via
     `isRetryableAssistantError` <!-- D-014 -->; idle timeout; the
     cancellation bridge (per-request `AbortController` wired to fiber
     interruption via pi-ai's `signal` option - spike A-001
     resolution).
  2. RED: recorded pi-ai stream fixtures (ordering, error encoding,
     settlement) pass through the wrap byte-faithfully.
  3. GREEN: seam per spike A-001 findings.
  4. RED: interrupting the consuming fiber aborts the underlying
     request (observed via the signal) and the turn persists stop
     reason aborted.
  5. GREEN. 6. RED: version-bump contract suite fails on a mutated
     fixture (proves drift detection). 7. GREEN + REFACTOR. Exact-pin
     recorded in package.json.

#### M13: Retry and overflow policies

- **Dependencies:** M12
- **Effort:** S
- **Testing:** test-first
- **Observability:** required (retry schedule + compaction-trigger
  diagnostics)
- **Tasks:**
  1. Seams under test: `Schedule` policy (transient-only, backoff,
     cap); overflow compact-then-retry-once with bounded summarization
     requests.
  2. RED: permanent errors never retry; transient exhaust into error
     entry. 3. GREEN.
  4. RED: overflow with unsummarizable context yields `BudgetExceeded`
     diagnostic. 5. GREEN + REFACTOR.

#### M14: Driver head

- **Dependencies:** M10, M13
- **Effort:** S
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: in-process protocol surface <!-- D-021 -->
     (commands, snapshots, progress subscription) used by every
     downstream test.
  2. RED: full scripted session (prompt, steer, tool, abort, branch)
     via driver only, asserting snapshots and journal.
  3. GREEN + REFACTOR: this scripted session becomes the canonical
     recorded-journal fixture.

### Gate 2→3

- [ ] Recorded-journal fixture of a full tool-using turn (fake
      provider) is stable and replayable
- [ ] Live smoke test against one real provider through pi-ai passes
- [ ] Crash-sim: kill at every record boundary in the fixture recovers
      per D-022

### Phase 3: Plugin system

**Goal:** All behavior addition flows through plugins; compact and
session naming are plugins; trust and reload work.

**Gate from previous:** Gate 2→3.

#### M15: Manifests, registries, capabilities

- **Dependencies:** M14
- **Effort:** M
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: Schema manifests; namespaced keys; priority
     conflict rule with diagnostic; per-session grants; availability
     rules (required capability fails load; tool-level makes tool
     unavailable) <!-- D-019 -->.
  2. RED/GREEN pairs per rule; REFACTOR into registry core.

#### M16: Generic hook emitter

- **Dependencies:** M15
- **Effort:** L
- **Testing:** test-first
- **Observability:** required (hook spans, plugin-named skip/timeout
  diagnostics)
- **Tasks:**
  1. Seams under test: one emitter executing declared merge semantics
     (`Chain`/`FirstWins`/`Accumulate`/`Tap`) and failure policies
     <!-- D-020 -->; tap fibers with sliding queues + drop counts.
  2. RED: gate timeout rejects (fail closed); Chain contribution
     failure skips with diagnostic; slow tap provably does not extend
     turn latency (clocked test).
  3. GREEN + REFACTOR: hook-point table as data; no per-point emitters.

#### M17: Trust with digest binding

- **Dependencies:** M15
- **Effort:** M
- **Testing:** test-first
- **Observability:** required (structured trust decisions: digest,
  scope, change summaries)
- **Tasks:**
  1. Seams under test: two-phase load; project-local classification
     (any path inside project tree); digest record + re-prompt on
     change <!-- D-015 -->.
  2. RED: CLI-passed in-project plugin cannot answer trust; changed
     content re-prompts with summary; untrusted project never executes
     plugin code.
  3. GREEN + REFACTOR.

#### M18: Plugin loading and hot reload

- **Dependencies:** M16, M17
- **Effort:** L
- **Testing:** test-first
- **Observability:** required (generation swap: old/new ids, drain
  duration, closed resources)
- **Tasks:**
  1. Seams under test: native TS module loading (absolute `file:` URL
     `import()`, query-string cache busting for reload, `enum`/
     `namespace` rejected with a clear diagnostic - spike A-002);
     generation `Ref` swap; drain barrier deferring old-generation
     `Scope` close until in-flight turns settle (`Scope.make` +
     `Layer.buildWithScope` + `Deferred`, validated by spike A-003).
  2. RED: reload during a running turn - turn finishes on old
     generation, next turn on new, old scope closes after settle.
  3. GREEN. 4. RED: reload is a mailbox command (cannot interleave
     mid-gate). 5. GREEN + REFACTOR.

#### M19: First-party plugins (dogfood proof)

- **Dependencies:** M18
- **Effort:** M
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: compact command and session naming implemented
     purely through the public plugin API, exercised via driver head
     <!-- D-005 --> <!-- D-021 -->.
  2. RED: import-boundary CI proves they touch no kernel internals.
  3. GREEN + REFACTOR: extract the plugin-author API surface docs from
     these two implementations.

### Gate 3→4

- [ ] Dogfood CI check green with compact + session naming as plugins
- [ ] A from-docs example plugin (one tool, one command, one hook)
      loads and runs in a scripted session

### Phase 4: Wire protocol and heads

**Goal:** External processes drive peye: print, json, rpc.

**Gate from previous:** Gate 3→4.

#### M20: Protocol schemas

- **Dependencies:** M14
- **Effort:** M
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: Schema frames for kernel primitives +
     invoke-command <!-- D-021 -->; full-transcript snapshot with
     revision + entry-id addressing reserved <!-- D-017 -->;
     interaction requests with timeout/fallback.
  2. RED/GREEN per frame family; REFACTOR into protocol package with
     zero kernel imports.

#### M21: print and json heads

- **Dependencies:** M20
- **Effort:** S
- **Testing:** test-after (thin orchestration glue over driver +
  protocol; verified by golden-output integration tests)
- **Tasks:**
  1. Implement print (final text, exit code from stop reason) and json
     (one item per line, stdout-paced).
  2. Verify: golden transcripts for scripted sessions, including error
     and abort exits.

#### M22: rpc head

- **Dependencies:** M20
- **Effort:** L
- **Testing:** test-first
- **Observability:** required (frame spans; protocol error
  diagnostics; per-subscriber drop counts)
- **Tasks:**
  1. Seams under test: strict-LF framing (U+2028/U+2029 fixtures);
     attach/detach; interaction request round-trip with timeout
     fallback; bounded sliding progress buffers.
  2. RED: adversarial framing fixtures; head detach mid-interaction
     resolves fallback; slow subscriber drops progress but snapshots
     stay correct.
  3. GREEN + REFACTOR. Head-author doc points at pi's rpc.md framing
     lesson.

#### M23: Snapshot-size measurement

- **Dependencies:** M22
- **Effort:** S
- **Testing:** test-after (measurement, not behavior; verified by a
  recorded report)
- **Tasks:**
  1. Measure snapshot payload sizes across recorded long sessions;
     report against thresholds.
  2. Verify: written report attached to plan; pagination go/no-go
     recorded as a decision <!-- D-017 -->.

### Gate 4→5

- [ ] An external process completes a full tool-using session via rpc
- [ ] Golden transcripts stable across two consecutive runs
- [ ] Snapshot measurement report recorded

### Phase 5: Verification hardening

**Goal:** The reliability claims are demonstrated, not asserted.

**Gate from previous:** Gate 4→5.

#### M24: Crash-simulation suite

- **Dependencies:** M11, M22
- **Effort:** M
- **Testing:** test-first (the suite is the deliverable)
- **Observability:** required (recovery reports are the suite's
  assertion surface)
- **Tasks:**
  1. Kill-at-every-boundary matrix over the canonical fixtures (append
     ack, record write, tool start/end, generation swap).
  2. RED→GREEN: every cell recovers to a well-formed journal per
     D-022; recovery reports match expectations.

#### M25: Conformance publication and docs

- **Dependencies:** M24
- **Effort:** M
- **Testing:** test-after (packaging/docs; verified by a clean-room
  install exercising the published suites)
- **Tasks:**
  1. Publish journal + seam conformance suites as package exports;
     recorded-journal fixture harness documented; plugin-author guide
     from M19; README.
  2. Verify: clean-room `pnpm add` consumer runs both suites green.

### Gate 5→complete

- [ ] All suites green in CI from a clean checkout
- [ ] Five phase PRs merged to main <!-- D-025 -->

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| pi-ai 0.x behavioral drift crosses the seam | high | medium | Exact pin; M12 contract fixtures gate every bump <!-- D-014 --> | kernel |
| Plugin authors hit the enum/namespace prohibition (spike A-002) | low | medium | Clear load-time diagnostic in M18; documented in plugin guide (M19/M25); transforming loader only if demand proves it | plugins |
| Full-transcript snapshots too heavy for long sessions | medium | medium | Reserved entry-id pagination activates (D-017); M23 measures before it matters | protocol |
| Journal file growth unbounded (compaction never shrinks files) | low | high | Accepted for v1; vacuum/export is a later plan; documented | journal |
| Hook-point set too narrow for TUI-era plugins | medium | low | Registry admits new kinds/points without core changes (D-019); protocol invariants fixed in RFC | plugins |

---

## Escape Hatches

1. **If Gate 4→5 snapshot measurement fails thresholds**: activate
   reserved pagination (D-017) as a Phase 5 milestone instead of
   fast-follow.
2. **If plugin-syntax friction proves real** (enum/namespace
   prohibition generates support burden): add a transforming loader
   behind the same loading seam; plugin API unchanged.

(Original hatches 1-3 were retired by the spike results - see Spike
Learnings and spike-report.md.)

---

## Landing Strategy

<!-- D-025 -->

| Field | Value |
|-------|-------|
| Merge target | `main` (private GitHub repo under `dungle-scrubs`) |
| Branch model | one branch per phase |
| PR cadence | PR per phase (5 PRs) |
| Independent reviewer | Codex review per PR (cross-family); muse-spark fallback per rubric |
| Ship mechanism | tool-proxy github flow (create_branch → push_files → create_pull_request → merge_pull_request) |

---

## Progress Report Accounting

Per the planner invariants: normalized buckets (current cutoff blockers
/ accepted-deferred / superseded / completed), current-focus marker on
the first unchecked current-cutoff box, no empty active sections, no
bare FP-references. Run `plan-db check-progress` before resuming
implementation or declaring convergence.

---

## Validation Commands

```bash
pnpm install
pnpm build          # tsc project references
pnpm lint           # Biome + import-boundary check
pnpm test           # vitest, all packages
pnpm test:conformance  # journal + seam suites (from Phase 1/2 onward)
```

(Names fixed at M1; this table is updated there if scaffold differs.)

---

## Decisions

Canonical decisions live in `.plans/00-peye-coding-agent/plan.db`
(D-001..D-025). Query:

```bash
npx tsx <planner-skill-dir>/scripts/plan-db.ts query-decisions --plan "00-peye-coding-agent"
```
