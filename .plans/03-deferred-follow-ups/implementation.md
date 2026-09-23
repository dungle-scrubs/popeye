# 03-deferred-follow-ups - Implementation Plan

## ⚠️ Execution Protocol

A progress report exists at `.plans/03-deferred-follow-ups/progress-report.md`.
It lists every user-facing feature for every milestone as a checkbox.

**Mandatory rules for all agents working on this plan:**

1. Before starting a milestone, run `plan-db check-progress --plan
   "03-deferred-follow-ups"` and read its section in the progress report -
   those current-cutoff checkboxes are your spec
2. Check each box as you complete the feature, not at the end
3. A milestone is NOT done until every current-cutoff checkbox under it is
   checked
4. If you find features missing from the report, add them first
5. Never declare a phase complete without updating the current focus marker
   and Summary
6. Deferred follow-up and superseded/obsolete checklist debt must not be
   counted as current blockers
7. Fully deferred/tabled sections must be moved under Deferred follow-up;
   empty active sections must not remain between completed/current sections
8. `FP-<number>` references must be backed by real progress-report sections
   and checkboxes, not merely named

## 0. Hard Dependencies

None. Plans 00-02 are complete and merged; every surface this plan touches
is on `main`.

## Architecture

This document plus the decisions ledger in `plan.db` are canonical and
sufficient to execute; the archived RFC (under `artifacts/` after
consolidation) is background rationale.

```
kernel                                plugins
  ToolRegistry.view(sessionId)          makePluginRuntime.checkout (lease)   D-005
  turn loop: lease at Turn open         importTimeoutMillis                  (M6)
  seam: declarations per request        PluginInteractions + identity        D-009
  sessions.ts recovery migration        tool-call-gate sessionId (additive)

cli                                   protocol (additive only)
  makePluginRuntime composition root    interaction pluginName field         D-009
  /reload + host control service D-006
  adapter emits tool-call-gate   D-008
  opt-in gate Plugins            D-007
```

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| One binding rule: Turn-level lease (D-005) | Reload takes effect at Turn boundaries; compaction requests carry no tools; recovery name-identity caveat documented |
| `use()` cannot span a Turn | New `checkout` lease primitive in plugins (additive); `use` re-expressed over it |
| Reload must not run under a lease (D-006) | `/reload` Command calls a host control service; swap on a host fiber |
| A tools-only swap strands host services | CLI composition root becomes `makePluginRuntime`; registry/emitter/host/grants/audit resolve through current generation |
| Startup composition precedes any Head (D-007) | Startup `PluginInteractions` is the null Layer; interactive trust is reload-time only |
| No plugin-identity channel exists | Emitter sets a current-plugin FiberRef around contribution execution |
| Protocol changes additive only | Optional `pluginName` on interaction requests; optional `sessionId` on tool-call-gate input |
| Native imports are not cancellable | Import timeout bounds latency only; wording per RFC Design 4 |

### Boundaries

- New/changed module seams (module comments state owns/why/not-responsible):
  - `packages/plugins/src/generation.ts`: lease primitive joins the runtime
    (same module; no new file).
  - `packages/plugins/src/interactions.ts` (new): owns `PluginInteractions`
    service definition, the identity FiberRef contract, and fallback
    resolution rules. Not responsible for transport (heads own that).
  - `packages/cli/src/plugins/runtime.ts` (new): owns the CLI composition
    root over `makePluginRuntime` - the ONE recomposition function
    (discovery, load, guards, first-party registration) used by startup
    and reload. `pipeline.ts` becomes its discovery/guard helper.
  - `packages/cli/src/plugins/reload.ts` (new): owns the host control
    service behind `/reload` - swap orchestration, busy/drain-timeout
    semantics, result reporting.
  - Gate plugins: `packages/cli/src/features/trust-gate.ts`,
    `tool-vetting.ts` - opt-in linkable modules, never in the default set.
- Import-boundary CI unchanged; protocol keeps zero kernel imports; no
  pi-ai outside the seam.

### Observability

- Lease/reload: swap diagnostics (old/new ids, plugin/tool deltas, drain
  duration) via existing generation sink; drain-timeout diagnostic names
  lease-holding sessions; `/reload` result carries the same data;
  audit fields refresh on swap.
- Interactions: request/resolution diagnostics carry plugin name, kind,
  outcome (answered/fallback/timeout/detached); pending-entry removal on
  interruption logs.
- Turn leasing: turn spans gain a generation-id attribute.
- Gate plugins: every deny/allow logs with plugin attribution.

---

## Phases

### Phase 1: Leasing and Session-scoped Tools

**Goal:** a Turn pins one generation for its whole life; Tools resolve
per-Session per-request; nothing observable changes for a default run.

**Gate from previous:** none (first phase).

#### M1: Generation lease primitive

- **Dependencies:** none
- **Effort:** M
- **Testing:** test-first
- **Observability:** required (lease acquire/release visible in generation
  diagnostics; drain reflects lease count)
- **Tasks:**
  1. Seams under test: `makePluginRuntime` in
     `packages/plugins/src/generation.ts`.
  2. RED: `checkout` yields a lease on the current generation; the
     generation cannot close while the lease's Scope is open. GREEN.
  3. RED: `reload` drains: swap completes, old generation closes only
     after the last lease releases; leases taken after swap are on the
     new generation. GREEN: re-express `use`/`useSerialized` over
     checkout; existing generation tests stay green unmodified.
  4. RED: drain observability - lease count in swap diagnostics. GREEN.
  5. REFACTOR: module comment updated (lease contract stated).

#### M2: Kernel Session-keyed Tool path

- **Dependencies:** M1
- **Effort:** L
- **Testing:** test-first
- **Observability:** required (turn spans gain generation-id attribute)
- **Tasks:**
  1. Seams under test: `ToolRegistryService.view(sessionId)` in
     `packages/kernel/src/tool.ts`; turn loop in `turn.ts`; seam
     declarations in `ai/seam.ts`; recovery in `sessions.ts`.
  2. RED: `ToolRegistryLive(tools)` satisfies the new `view` contract as
     the degenerate same-view constructor; existing kernel tests green.
     GREEN.
  3. RED: the turn loop resolves the view once per Turn open and every
     provider request in the Turn (tool loop, steering recursion,
     transient retry) uses it; a view swapped mid-Turn is NOT picked up
     until the next Turn (fake registry flips views; assert stability).
     GREEN.
  4. RED: seam receives declarations per request; two Sessions with
     different views produce different provider `tools` arrays in one
     process (contract-suite fixture). GREEN.
  5. RED: compaction summarization requests carry no tool declarations.
     GREEN.
  6. RED: `sessions.ts` recovery resolves `availableToolNames` via
     `view(sessionId)`; recovery-matrix suite green. GREEN.
  7. REFACTOR: seam/tool module comments; recovery name-identity caveat
     documented in `docs/plugin-authoring.md`.

#### M3: CLI Session-keyed resolution

- **Dependencies:** M2
- **Effort:** M
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: `packages/cli/src/tools/adapter.ts` +
     `entry/run.ts` wiring.
  2. RED: the CLI provides `view(sessionId)` resolving against the
     current generation at call time (still one startup generation this
     phase); adapted views match today's behavior; E2E fake-provider tool
     turn green. GREEN.
  3. REFACTOR: startup builds no static tool array anymore; startup line
     toolCount reads the startup view.

### Gate 1→2

- [ ] All Phase 1 milestone tests pass; full local gate green
- [ ] Kernel + journal + seam contract suites green
- [ ] Live harness smoke (existing cases) green against local endpoint

### Phase 2: Composition root and reload

**Goal:** `popeye` composes through `makePluginRuntime`; `/reload` swaps
generations safely mid-session.

**Gate from previous:** Gate 1→2.

#### M4: CLI composition root

- **Dependencies:** M3
- **Effort:** L
- **Testing:** test-first
- **Observability:** required (recomposition diagnostics identical for
  startup and reload; audit fields resolve current generation)
- **Tasks:**
  1. Seams under test: new `packages/cli/src/plugins/runtime.ts`
     exporting the composition root and the ONE recomposition function;
     `compose.ts` host services resolve through the runtime's current
     generation.
  2. RED: startup through the composition root preserves every existing
     behavior (bin tests, pipeline tests, displacement guards, fail-closed
     errors, audit fields). GREEN: recomposition = discovery + load +
     guards + first-party registration.
  3. RED: host services (invokeCommand, compactionGate), tool views,
     grant union, audit fields all reflect the CURRENT generation (swap a
     generation in-process; assert each surface follows). GREEN.
  4. RED: grants recompute at swap; a Session's next Turn sees the new
     union; audit fields report it. GREEN.
  5. REFACTOR: `pipeline.ts` demoted to discovery/guard helper; module
     comments updated.

#### M5: /reload Command and swap semantics

- **Dependencies:** M4
- **Effort:** L
- **Testing:** test-first
- **Observability:** required (swap result payload; drain-timeout
  diagnostic naming lease holders; busy rejection diagnostic)
- **Tasks:**
  1. Seams under test: new `packages/cli/src/plugins/reload.ts` (host
     control service); `features/` reload command contribution; command
     execution context extension injecting the service.
  2. RED: `/reload` from an idle session swaps generations; result
     reports old/new ids and deltas; new Turn uses new tools; in-flight
     Turn on another session finishes on the old generation (stalled fake
     provider). GREEN: swap on host fiber outside leases.
  3. RED: failed recomposition (throwing plugin) leaves current
     generation serving; typed error result. GREEN.
  4. RED: reload-while-busy rejects typed; drain timeout (fake clock)
     fails the reload, both generations alive, diagnostic names the
     holder; old generation still closes when the Turn settles. GREEN.
  5. RED: trust flow re-entered on reload (memory store; auto-trust
     default unchanged). GREEN.
  6. Live harness: reload mid-session over rpc against the local
     endpoint - new tool visible to the next Turn.
  7. REFACTOR: bounded reload result schema documented for heads.

### Gate 2→3

- [ ] All Phase 2 milestone tests pass; full local gate green
- [ ] Live reload case green
- [ ] Race stress (reload vs concurrent turns, 50+ iterations) green in CI

### Phase 3: Interactions and gates

**Goal:** Plugin code can ask; the opt-in gates work over rpc; imports are
time-bounded.

**Gate from previous:** Gate 2→3.

#### M6: Import timeout

- **Dependencies:** none (within phase)
- **Effort:** S
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: `loadGeneration` / `loadPluginModule`.
  2. RED: a never-settling import fails typed at the bound naming the
     file; default 30s; configurable. GREEN.
  3. RED: CLI startup maps it fail-closed (exit 2); reload maps it
     contained. GREEN (wiring exists; assert both paths).

#### M7: PluginInteractions seam

- **Dependencies:** none (within phase; protocol field independent)
- **Effort:** L
- **Testing:** test-first
- **Observability:** required (request/resolution diagnostics with plugin
  attribution; pending-entry interruption cleanup logged)
- **Tasks:**
  1. Seams under test: new `packages/plugins/src/interactions.ts`;
     emitter identity FiberRef; protocol `pluginName` field;
     `RpcInteractions` finalizers; CLI null/live Layers.
  2. RED: emitter sets current-plugin identity around every contribution
     execution; `PluginInteractions.request` stamps it. GREEN.
  3. RED: grant-gated: ungranted `interaction` resolves fallback with
     diagnostic; granted proceeds. GREEN.
  4. RED: protocol round-trip with optional `pluginName` (older-decoder
     fixture ignores it); `tool-call-gate` input gains the additive
     optional `sessionId` (existing hook fixtures stay green without it).
     GREEN.
  5. RED: rpc live Layer: request delivered to attached head; pending
     delivered on attach; timeout→fallback; INTERRUPTED request removes
     its pending entry (no stale delivery, id reusable). GREEN.
  6. RED: null Layer resolves fallbacks immediately; wired in print/json
     and during startup composition in all modes. GREEN.
  7. RED: gate-interaction default timeout 25s nests inside the 30s hook
     timeout (clocked: interaction fallback decides, not hook timeout).
     GREEN.

#### M8: Opt-in gate Plugins and emission

- **Dependencies:** M7
- **Effort:** L
- **Testing:** test-first
- **Observability:** required (every allow/deny logged with attribution)
- **Tasks:**
  1. Seams under test: adapter `tool-call-gate` emission; trust-gate and
     tool-vetting plugin modules; scripted interactive rpc head harness.
  2. RED: adapter emits tool-call-gate after tool_started, before
     execute; no contributor → allowed (default run zero-cost, existing
     tests green). GREEN.
  3. RED: vetting plugin: reject→model-visible error tool result in call
     order; allow-once/allow-for-session via scripted head; session
     memory generation-scoped (reload forgets - assert). GREEN.
  4. RED: trust gate: startup headless denies immediately via null layer
     (no stall, clocked); reload over rpc with scripted head: answer
     trusted loads stage-2, fallback untrusted swaps without project
     plugins reported in result counts. GREEN.
  5. RED: linkable-module install path (symlink into user dir) loads the
     gates; default set never includes them. GREEN.
  6. Live harness: vetting prompt answered over rpc against the local
     endpoint.
  7. REFACTOR: `docs/plugin-authoring.md` gains the opt-in install
     pattern and PluginInteractions author guidance.

### Gate 3→4

- [ ] All Phase 3 milestone tests pass; full local gate green
- [ ] Live gate-prompt case green
- [ ] Default-run posture proven unchanged (no new prompts, no stalls;
      existing golden fixtures byte-stable)

### Phase 4: Hardening

**Goal:** 02/D-025 residuals closed.

#### M9: Test hardening

- **Dependencies:** none (within phase)
- **Effort:** M
- **Testing:** test-after (the deliverables are tests; verification is
  the suite green plus 10x flake runs)
- **Tasks:**
  1. rpc soak: raw stdout byte capture; byte-boundary frame integrity;
     provider-start-order per Session; tightened assertions.
  2. Kernel: abort between provider retry attempts (transient fail →
     backoff → abort) asserts one provider start, `aborted`, Session
     usable.
  3. Verify: full gate + 10x heads/kernel flake runs.

### Gate 4→done

- [ ] Full local gate green; flake runs green
- [ ] README/docs updated (reload, opt-in gates, interaction authoring)
- [ ] All four PRs merged

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Turn-lease refactor destabilizes the turn loop (most-tested kernel area) | high | medium | M2 keeps every existing kernel/contract test green before adding new behavior; recovery matrix must stay green | cli |
| CLI composition-root swap (M4) regresses startup behaviors | medium | medium | M4 task 2 pins ALL existing bin/pipeline tests before dynamic behavior lands | cli |
| Reload drain vs rpc session queues interact badly (reload command queued behind its own session's turn) | medium | medium | Documented: invoke /reload from an idle session; abort bypass remains available; busy/timeout semantics bound the damage | cli |
| Interaction identity FiberRef leaks across fibers (tap hooks run on own fibers) | medium | low | M7 test asserts attribution under Tap/parallel hook execution | cli |
| Gate plugins flake under scripted-head timing | low | medium | Deterministic scripted head (no real model) for unit paths; live case is the only timing-sensitive one | cli |
| ESM cache growth across many reloads | low | low | Documented limitation (RFC Design 4); reload is operator-invoked, not hot-path | cli |

---

## Escape Hatches

1. **If the seam's per-request declarations break the pi-ai contract
   suite in unforeseen ways:** fall back to resolving the view once per
   Turn and passing it through the existing captured-list shape
   internally (same external contract, smaller seam diff); record as a
   narrowing decision.
2. **If the emitter FiberRef cannot attribute Tap contributions
   (own-fiber semantics):** restrict PluginInteractions to Gate/Chain/
   Accumulate and Command contexts in v1; Taps get no interaction power;
   record and document.
3. **If M4's composition-root swap balloons:** land M4 with reload-only
   internals (runtime root, no command) and move `/reload` to Phase 3;
   phases re-gate accordingly.

---

## Landing Strategy

| Field | Value |
|-------|-------|
| Merge target | `main` <!-- D-011 --> |
| Branch model | branch per phase <!-- D-012 --> |
| PR cadence | PR per phase (4 PRs) <!-- D-012 --> |
| Independent reviewer | Muse Spark per milestone when Codex implements; Codex review otherwise <!-- D-013 --> |
| Ship mechanism | manual PR via GitHub (tool-proxy github app) |

`complete` means all four PRs merged.

---

## Progress Report Accounting

Normalized accounting per the standard rules; run
`plan-db check-progress --plan "03-deferred-follow-ups"` before resuming
implementation or declaring convergence.

---

## Validation Commands

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm check-boundaries
# live harness (env-gated): POPEYE_LIVE_ENDPOINT/POPEYE_LIVE_MODEL per live.test.ts
```

---

## Deferred follow-up (named, out of scope)

- Startup-interactive trust (two-stage composition) - TUI plan (D-007).
- npm-referenced Plugin packages.
- Trust-gate allowlist layer (RFC Alternatives 1).

---

## Decisions

Canonical decisions in `.plans/03-deferred-follow-ups/plan.db`. Key codes:
D-002 (trust-gate UX), D-003 (/reload command), D-004 (session-scoped
kernel), D-005 (Turn-level leasing), D-006 (reload = host recomposition on
a control path), D-007 (reload-time trust v1), D-008 (vetting emission),
D-009 (interactions identity/attribution/timeouts), D-010 (capability
semantics + scope corrections), D-011..D-013 (landing).
