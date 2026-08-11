# 02-cli-live-gaps - Implementation Plan

## ⚠️ Execution Protocol

A progress report exists at `.plans/02-cli-live-gaps/progress-report.md`. It
lists every user-facing feature for every milestone as a checkbox.

**Mandatory rules for all agents working on this plan:**

1. Before starting a milestone, run `plan-db check-progress --plan
   "02-cli-live-gaps"` and read its section in the progress report - those
   current-cutoff checkboxes are your spec
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

None. Plans `00-peye-coding-agent` and `01-cli-entry` are complete and merged;
every library API this plan composes already exists on `main`.

## Architecture

The plan closes two composition gaps in `@pop-eye/cli`; no other package
changes. This document plus the decisions ledger in `plan.db` are canonical
and sufficient to execute; the archived RFC
(`artifacts/01_cli-plugin-tool-loading-and-concurrent-rpc-dispatch.rfc.md`)
is background rationale only.

```
peye bin
  └─ run.ts
       ├─ Plugin pipeline (NEW composition)          Phase 1
       │    discovery config (~/.peye/plugins, --plugin, --no-project-plugins)
       │    loadGeneration(trust: "trusted", TrustStoreMemory)   D-002 D-008
       │    first-party plugins via same registry (dogfood)
       │    phase-1 displacement guard                            D-011
       │    fail-closed -> CliRunError composition_failed         D-010
       ├─ Tool adapter (NEW)                          Phase 2
       │    grant-aware registry.list ∘ self-declaration rule     D-009
       │    closest-scope shadowing -> kernel Tool[]              D-007
       │    ONE per-process ToolRegistry after load               D-006
       │    union grants per session                              D-003
       └─ Heads
            print/json: unchanged dispatch; snapshot audit fields D-012
            rpc: per-Session queues + control bypass (REWORK)     D-005
                 serialized writer; bounded; EOF semantics
```

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Kernel `ToolRegistryService` is Session-less; ai seam captures `list()` at Layer build | One per-process registry, built after generation load, before Driver composition (D-006) |
| ContributionRegistry keys are `plugin/name` - cross-plugin tool-name collisions surface only in the adapter | Adapter owns shadowing policy (D-007) |
| `loadGeneration` is all-or-nothing (no per-plugin skip) | Fail-closed startup with named diagnostic (D-010) |
| `loadGeneration` requires a TrustStore layer | Compose `TrustStoreMemory` (D-008) |
| Protocol command `id` is optional | rpc ordering must come from dispatch structure, not correlation (D-005) |
| One generation per process (no CLI reload trigger) | Adapter needs no generation-swap handling in v1 |

### Boundaries

- All new code lives in `@pop-eye/cli`. Import-boundary CI rules are
  unchanged and must stay green: no kernel internals, no pi-ai outside the
  seam.
- New module seams (each gets a module comment stating what it owns and why
  it exists):
  - `packages/cli/src/plugins/pipeline.ts` - owns discovery-config
    construction and `loadGeneration` composition (trust constant, memory
    store, sinks, displacement guard, fail-closed mapping). Exists so
    `run.ts` stays an I/O boundary and the pipeline is testable without a
    process.
  - `packages/cli/src/plugins/tool-adapter.ts` - owns Contribution→kernel
    Tool adaptation: self-declaration rule, shadowing, per-process registry
    build, tool-count diagnostic. Exists so the one place unqualified tool
    names collide has one owner.
  - `packages/cli/src/heads/rpc-dispatch.ts` - owns Session queues, control
    bypass, bounds, and the serialized writer wrapper. Exists so `rpc.ts`
    keeps framing/decoding/handling and dispatch policy is testable in
    isolation.
- `compose.ts` keeps the single in-process composition boundary; the
  generation-backed `PluginHost` replaces the static
  `FirstPartyPluginHostLive` registry construction behind the same service
  interface.

### Observability

Runtime and transport behavior changes, so observability is part of the
feature (D-012):

- Startup: structured diagnostics for every pipeline stage - discovery
  (sources found, per origin/scope), trust (digest, decision, provenance),
  registration (plugins loaded, shadowing events naming both plugins,
  skipped under-declared tools naming plugin + missing capability),
  displacement-guard rejections, adapted tool count in the startup line.
- Sessions: grant set logged at creation; Snapshots emit `capabilityGrants`
  and `loadedGeneration` from rpc and json heads.
- rpc dispatch: spans per frame keep the existing `rpc.frame` shape and gain
  queue attributes (session, queue depth, bypass flag); bound-exceeded
  rejections are wire errors with a named bound; writer-failure termination
  logs before exit.
- Failure payloads: every fail-closed startup error names file and cause;
  nothing is silently dropped (all `loadGeneration` sinks wired to stderr
  logfmt).

---

## Phases

### Phase 1: Plugin pipeline in the CLI

**Goal:** `peye` discovers, trusts (constant), and loads user-global,
CLI-passed, and project-local plugins through one generation, fail-closed,
fully diagnosed - with commands and hooks served from that generation.

**Gate from previous:** none (first phase).

#### M1: Flag and config surface

- **Dependencies:** none
- **Effort:** S
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: `parseArgs` / `resolveConfig`
     (`packages/cli/src/entry/args.ts`, `config.ts`).
  2. RED: `--plugin <path>` repeatable flag parses to an ordered list;
     absent → empty. GREEN: implement.
  3. RED: `--no-project-plugins` parses; `--help` documents both flags.
     GREEN: implement.
  4. RED: config resolves user-global plugin dir to `~/.peye/plugins`
     <!-- D-013 --> (overridable for tests via env `PEYE_USER_PLUGIN_DIR`;
     env var is test-support, not documented surface). GREEN: implement.
  5. REFACTOR: keep the flag table alphabetical; update bin help fixture.

#### M2: Generation composition

- **Dependencies:** M1
- **Effort:** L
- **Testing:** test-first
- **Observability:** required (startup diagnostics: discovery, trust,
  registration, displacement guard, fail-closed errors - all sinks wired)
- **Tasks:**
  1. Seams under test: new `packages/cli/src/plugins/pipeline.ts` exporting
     `composePluginRuntime(config)` returning the loaded generation's
     registry + emitter + manifests; consumed by `compose.ts`/`run.ts`.
  2. RED: pipeline with an empty project loads first-party plugins only;
     commands (`compact`, `session-name`) resolve through the generation
     registry. GREEN: compose `loadGeneration` with `trust: "trusted"`
     <!-- D-002 --> over `TrustStoreMemory` <!-- D-008 -->, register
     first-party plugins through the same registry.
  3. RED: a fixture project plugin in `.peye/plugins` loads; its command is
     invokable. GREEN: phase-2 wiring.
  4. RED: `--no-project-plugins` skips `.peye/plugins` AND a project-local
     `--plugin` path <!-- D-014 -->; user-global and out-of-tree `--plugin`
     paths still load. GREEN: implement.
  5. RED: a phase-2 plugin whose manifest name matches a loaded phase-1
     plugin fails registration with a diagnostic naming both paths
     <!-- D-011 -->; the run fails closed. GREEN: displacement guard.
  6. RED: a plugin that throws at import fails the run as `CliRunError`
     `composition_failed` naming file and cause <!-- D-010 -->; exit 2
     through the bin. GREEN: error mapping.
  7. RED: trust runs record nothing durable - a second `composePluginRuntime`
     in a fresh store re-resolves (assert via TrustStore state)
     <!-- D-008 -->. GREEN: verify memory-store composition.
  8. REFACTOR: `run.ts` consumes `composePluginRuntime`; generation-backed
     `PluginHost` replaces the static registry in `compose.ts`; delete dead
     static path.

### Gate 1→2

- [ ] All Phase 1 milestone tests pass
- [ ] Full local gate green (`build`, `typecheck`, `lint`, `test`,
      `check-boundaries`)
- [ ] Live harness: fixture project plugin's command invoked through the
      spawned bin

### Phase 2: Tool adaptation and audit surface

**Goal:** plugin-contributed Tools reach the model through the shipped bin,
with the self-declaration rule and shadowing policy enforced, and Snapshots
report what loaded.

**Gate from previous:** Gate 1→2.

#### M3: Tool adapter

- **Dependencies:** M2
- **Effort:** L
- **Testing:** test-first
- **Observability:** required (shadowing diagnostics naming both plugins;
  skipped-tool diagnostics naming plugin + missing declaration; adapted
  tool count in startup line)
- **Tasks:**
  1. Seams under test: new `packages/cli/src/plugins/tool-adapter.ts`
     exporting `adaptTools(registry, grants, manifests)` →
     `ReadonlyArray<Tool.Any>`; per-process `ToolRegistryLive(adapted)`
     built after load <!-- D-006 -->.
  2. RED: a fixture tool contribution round-trips: name, description,
     parameters schema, execute, executionMode, replay,
     requiredCapabilities. GREEN: adapt from contribution payload.
  3. RED: session grants are the manifest union <!-- D-003 -->; a tool
     requiring a capability its own plugin does not declare is skipped with
     a diagnostic even when another plugin declares it <!-- D-009 -->.
     GREEN: self-declaration rule.
  4. RED: two plugins contributing one tool name: project-local shadows
     user-global shadows first-party; within a scope, manifest priority
     then lexical plugin name; diagnostic names both plugins and the
     survivor; startup does not fail <!-- D-007 -->. GREEN: shadowing.
  5. RED: empty adapted set is valid; startup line reports tool count 0
     <!-- D-015 -->. GREEN: degraded-operation diagnostic.
  6. REFACTOR: `run.ts` replaces `ToolRegistryLive([])` with the adapted
     registry; provider layer receives it.

#### M4: Snapshot audit fields

- **Dependencies:** M2
- **Effort:** S
- **Testing:** test-first
- **Observability:** required (this milestone IS the audit surface: rpc and
  json snapshots emit capabilityGrants + loadedGeneration <!-- D-012 -->)
- **Tasks:**
  1. Seams under test: `connectionSnapshot` (rpc) and the json head's
     snapshot emission; protocol schema fields already reserved.
  2. RED: rpc snapshot carries `capabilityGrants` (sorted) and
     `loadedGeneration` for a loaded fixture plugin. GREEN: wire from
     generation + grants.
  3. RED: json head golden transcript includes both fields; goldens
     regenerated deterministically. GREEN: implement; update fixtures.

#### M5: End-to-end tool proof

- **Dependencies:** M3, M4
- **Effort:** M
- **Testing:** test-after (spawned-bin E2E glue over already-unit-tested
  behavior; verification is the named harness runs)
- **Tasks:**
  1. Fixture: a project plugin contributing one tool; fake-provider script
     issuing a toolCall; spawned `peye -p --mode json` completes the tool
     turn; captured stream decodes through `@pop-eye/protocol`.
  2. Live harness: a real model turn calls the fixture tool through the
     shipped bin (env-gated like the existing live tests).
  3. Verify: both harnesses green twice consecutively (fixture stability),
     full local gate green.
  4. Resolve `01-cli-entry` ledger finding 2 (tool loading) with a comment
     pointing at the harness evidence.

### Gate 2→3

- [ ] All Phase 2 milestone tests pass
- [ ] Live harness model turn calls a plugin tool end-to-end
- [ ] `01-cli-entry` finding 2 resolved in its plan.db

### Phase 3: rpc per-Session dispatch

**Goal:** abort-over-rpc works mid-Turn; same-Session commands keep stdin
order; output frames never tear; the head terminates sanely on writer
failure and EOF.

**Gate from previous:** Gate 2→3 (independent in code, ordered by product
priority; may start once Phase 2 review is out).

#### M6: Serialized writer

- **Dependencies:** none (within phase)
- **Effort:** S
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: new `serializedWriter(writer)` in
     `packages/cli/src/heads/rpc-dispatch.ts` wrapping `HeadWriter`.
  2. RED: N concurrent fibers writing M frames each produce N*M intact
     LF-terminated frames, no interleaving (adversarial scheduling via
     TestClock/yields). GREEN: mutex/queue over whole-frame writes.
  3. RED: a failing underlying write surfaces `HeadWriteError` to the
     writing fiber and poisons the writer (subsequent writes fail fast).
     GREEN: implement.

#### M7: Session queues and control bypass

- **Dependencies:** M6
- **Effort:** L
- **Testing:** test-first
- **Observability:** required (rpc.frame spans gain session/queue-depth/
  bypass attributes; bound-exceeded wire errors name the bound; EOF and
  writer-failure paths log structured reasons)
- **Tasks:**
  1. Seams under test: `rpc-dispatch.ts` exporting a dispatcher consumed by
     `runRpcHead`: `route(frame) -> sessionQueue | controlBypass |
     sessionlessQueue` <!-- D-005 -->.
  2. RED: `set-model` then `prompt` on one session apply in stdin order
     under adversarial completion order. GREEN: per-session FIFO worker.
  3. RED: `abort` dispatches while that session's `prompt` handler is
     mid-Turn (fake provider stalls the stream); turn aborts; both
     responses correlate. GREEN: control bypass fork.
  4. RED: `interaction-response` resolves a pending interaction while a
     turn runs; two concurrent responses to one id - exactly one wins,
     the loser gets the existing no-pending-request protocol error
     (atomic single-`Ref.modify` claim). GREEN: implement.
  5. RED: distinct sessions' prompts run concurrently (clocked: total time
     < sequential sum with stalled fake provider). GREEN: per-session
     workers.
  6. RED: queue bound exceeded rejects the frame with a wire error naming
     the bound; connection stays up. GREEN: bounded queues + bypass set.
  7. RED: handler completes side effects before its response frame is
     written (attach installs interactive head before responding: a
     command racing the response cannot observe missing state on the same
     session). GREEN: response-after-effect ordering inside handlers.
  8. RED: writer failure (closed stdout) terminates the head through the
     boundary; no further frames are read. GREEN: implement.
  9. RED: EOF with an in-flight turn: reading stops, waiting fibers
     interrupt without wire errors, accepted kernel work settles, process
     exits by the existing contract. GREEN: implement.
  10. REFACTOR: `runRpcHead` keeps decode/handle logic; dispatch policy
      lives entirely in `rpc-dispatch.ts`.

#### M8: rpc live proof

- **Dependencies:** M7
- **Effort:** M
- **Testing:** test-after (harness glue over unit-tested dispatch;
  verification is the named harness runs)
- **Tasks:**
  1. Extend the live/spawned rpc harness: mid-turn abort against a real
     (or env-gated fake) provider through the shipped bin; snapshot shows
     stop reason `aborted`.
  2. Adversarial soak: interleaved frames across 3+ sessions, dropped
     subscriber, oversized frame - existing behaviors keep their
     contracts.
  3. Verify: harness green twice consecutively; full local gate green.
  4. Resolve `01-cli-entry` ledger finding 3 (rpc abort dispatch) with a
     comment pointing at the harness evidence.

### Gate 3→done

- [ ] All Phase 3 milestone tests pass
- [ ] Live harness aborts a real turn over rpc through the shipped bin
- [ ] `01-cli-entry` finding 3 resolved in its plan.db
- [ ] README rpc/flag documentation updated (`--plugin`,
      `--no-project-plugins`, concurrent dispatch semantics)

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Plugin import that never settles hangs startup (no import timeout in plugins pkg) | medium | low | Documented known limitation (D-010); `--no-project-plugins` unblocks; plugins-package timeout is named follow-up | cli |
| `TrustStoreMemory` + `loadGeneration` composition has an unforeseen coupling to persisted-store semantics | medium | low | Escape hatch 1 | cli |
| Effect-level per-session queue implementation grows complex (supervision, bounds, interruption) | medium | medium | Escape hatch 2; M6/M7 are seam-isolated in `rpc-dispatch.ts` | cli |
| Shadowing policy surprises a user (project tool silently used over global) | low | medium | Never silent: diagnostic names both plugins and survivor (D-007) | cli |
| Live-harness model runs are flaky/costly in CI | low | medium | Live tests stay env-gated as in `01-cli-entry`; fixture (fake-provider) variants carry the CI load | cli |
| Abort outracing its prompt confuses rpc clients | low | low | Specified: `abortTurnNotAborted` is the honest answer; client MAY retry (RFC Error Handling) | cli |

---

## Escape Hatches

1. **If `TrustStoreMemory` cannot back `loadGeneration` cleanly:** compose
   `TrustStoreLive` against a per-run temp directory deleted on exit -
   identical semantics (nothing durable), slightly more I/O. No RFC change.
2. **If per-session queues prove disproportionate in Effect:** fall back to
   ONE global FIFO for non-control frames plus the control bypass. Abort
   reachability (the shipped gap) is preserved; cross-session concurrency is
   lost - record as a scope-narrowing decision and a named follow-up.
3. **If the self-declaration rule (D-009) breaks a legitimate first-party
   pattern:** first-party manifests are ours - fix the manifests, not the
   rule.

---

## Landing Strategy

| Field | Value |
|-------|-------|
| Merge target | `main` <!-- D-016 --> |
| Branch model | branch per phase <!-- D-017 --> |
| PR cadence | PR per phase (3 PRs) <!-- D-017 --> |
| Independent reviewer | gpt-5.6-sol via `codex review` per PR (muse-spark fallback if Codex over limit) <!-- D-018 --> |
| Ship mechanism | manual PR via GitHub (tool-proxy `github` app: `create_branch` → `push_files` → `create_pull_request` → `merge_pull_request`) |

`complete` means all three PRs merged and both `01-cli-entry` findings
resolved.

---

## Progress Report Accounting

The progress report is the implementation resume state. It must use
normalized accounting, not raw checkbox counts:

- current cutoff blockers count only active unchecked work
- accepted/deferred follow-up is excluded from current blockers
- superseded/obsolete checklist debt is struck through or moved out with a
  decision/gate reference
- the current focus marker must match the first unchecked current-cutoff
  checkbox

Before resuming implementation or declaring convergence, run:

```bash
plan-db check-progress --plan "02-cli-live-gaps"
```

---

## Validation Commands

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm check-boundaries
# live harness (env-gated; see packages/cli/src/entry/live.test.ts for the gate)
```

---

## Deferred follow-up (named, out of scope)

- Per-Session Tool visibility (kernel seam change) - D-006.
- Plugin import timeout in `@pop-eye/plugins` - D-010 known limitation.
- Opinionated trust-gate and tool-vetting first-party plugins over the
  existing `trust` / `tool-call-gate` hook points.
- CLI hot-reload trigger for generations.

---

## Decisions

Canonical decisions are in the plan database
(`.plans/02-cli-live-gaps/plan.db`). Query with:

```bash
npx tsx <planner-skill>/scripts/plan-db.ts query-decisions --plan "02-cli-live-gaps"
```

Key decisions referenced here: D-002 (auto-trust), D-003 (union grants),
D-005 (per-session dispatch; supersedes D-004), D-006 (per-process
registry), D-007 (shadowing), D-008 (memory trust store), D-009
(self-declaration), D-010 (fail-closed load), D-011 (displacement guard),
D-012 (audit fields), D-013 (`~/.peye/plugins`), D-014
(`--no-project-plugins` scope), D-015 (empty tool set), D-016..D-018
(landing).
