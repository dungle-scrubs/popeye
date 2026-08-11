# 02-cli-live-gaps - Progress Report

> Auto-generated from implementation plan. This is the canonical
> source of truth for what is done and what remains. Update this
> file as features are implemented - never mark a milestone complete
> until every current-cutoff checkbox under it is checked.

> Current focus: Phase 1 - Plugin pipeline in the CLI

## Phase 1: Plugin pipeline in the CLI

### M1: Flag and config surface
Source: `implementation.md` (M1); D-013, D-014

- [x] `--plugin <path>` repeatable flag parses into an ordered list; absent means empty
- [x] A `--plugin` path resolving inside the project tree is classified project-local
- [x] `--no-project-plugins` flag parses
- [x] `--help` documents both new flags
- [x] User-global plugin directory resolves to `~/.peye/plugins` (test override via `PEYE_USER_PLUGIN_DIR`, undocumented surface)
- [x] No trust-related flag exists; an attempted `--trust` is rejected as unknown

### M2: Generation composition
Source: `implementation.md` (M2); D-002, D-008, D-010, D-011, D-014

- [x] Empty project: first-party plugins load through the generation registry; `compact` and `session-name` commands invoke
- [x] A fixture project plugin in `.peye/plugins` loads and its command invokes
- [x] A user-global fixture plugin loads in phase 1, before any project code
- [x] An out-of-tree `--plugin` path loads phase-1; an in-tree `--plugin` path loads phase-2
- [x] `--no-project-plugins` skips `.peye/plugins` AND project-local `--plugin` paths; user-global and out-of-tree sources still load
- [x] `loadGeneration` composes `trust: "trusted"` over `TrustStoreMemory`; a fresh store re-resolves (nothing durably recorded)
- [x] A phase-2 plugin whose manifest name matches a loaded phase-1 plugin fails registration with a diagnostic naming both paths; the run fails closed
- [x] A plugin that throws at import fails the run as `CliRunError` `composition_failed` naming file and cause; the bin exits 2
- [x] All four diagnostic sinks (trust, registry, hook, generation) are wired to the stderr logfmt logger
- [x] The generation-backed `PluginHost` replaces the static registry; `compactionGate` and `invokeCommand` keep existing behavior (existing tests stay green)
- [x] Any two plugin sources sharing a manifest name fail composition closed naming both paths (D-020; includes user-global vs first-party)
- [x] `--no-project-plugins` decoy project path is a fresh empty temp directory (invariant by construction, not convention)

## Phase 2: Tool adaptation and audit surface

### M3: Tool adapter
Source: `implementation.md` (M3); D-003, D-006, D-007, D-009, D-015

- [ ] A fixture tool contribution adapts with every field intact (name, description, parameters schema, execute, executionMode, replay, requiredCapabilities)
- [ ] Session grants are the union of loaded manifests' capabilities
- [ ] A tool requiring a capability its own plugin does not declare is skipped with a diagnostic naming the plugin and the missing declaration, even when another plugin declares that capability
- [ ] Duplicate tool name across scopes: project-local shadows user-global shadows first-party
- [ ] Duplicate tool name within one scope: manifest priority wins, then lexical plugin-name order
- [ ] Every shadowing emits a diagnostic naming both plugins and the survivor; startup does not fail
- [ ] The per-process registry built after generation load replaces `ToolRegistryLive([])` in `run.ts`
- [ ] An empty adapted tool set is valid; the startup line reports the tool count (0 and N cases)
- [ ] An adapted tool executes through the kernel with Schema-validated arguments; invalid arguments become a model-visible error result

### M4: Snapshot audit fields
Source: `implementation.md` (M4); D-012

- [ ] rpc snapshots carry `capabilityGrants` (sorted) and `loadedGeneration` for a loaded fixture plugin
- [ ] json head emits both fields; golden transcripts regenerated and stable
- [ ] Both fields survive session resume (fields present on a resumed session's snapshot)

### M5: End-to-end tool proof
Source: `implementation.md` (M5)

- [ ] A fake-provider toolCall turn completes through the spawned bin (`--mode json`); the captured stream decodes through `@pop-eye/protocol`
- [ ] The captured fixture is stable across two consecutive runs
- [ ] Live harness: a real model turn calls the fixture tool through the shipped bin (env-gated)
- [ ] `01-cli-entry` ledger finding 2 (tool loading) resolved with harness evidence

## Phase 3: rpc per-Session dispatch

### M6: Serialized writer
Source: `implementation.md` (M6); D-005

- [ ] N concurrent fibers writing M frames each produce N*M intact LF-terminated frames with no interleaving (adversarial scheduling test)
- [ ] An underlying write failure surfaces `HeadWriteError` to the writing fiber and poisons the writer (subsequent writes fail fast)

### M7: Session queues and control bypass
Source: `implementation.md` (M7); D-005

- [ ] `set-model` then `prompt` on one session apply in stdin order under adversarial completion order
- [ ] `abort` dispatches while that session's `prompt` handler is mid-turn; the turn aborts; both responses correlate
- [ ] An `abort` outracing its prompt returns `abortTurnNotAborted` (client may retry)
- [ ] `interaction-response` resolves a pending interaction while a turn runs
- [ ] Two concurrent responses to one interaction id: exactly one wins; the loser gets the existing no-pending-request protocol error (atomic claim)
- [ ] Distinct sessions' prompts run concurrently (clocked: total under sequential sum)
- [ ] Sessionless commands (`create`, `list`) dispatch on their own queue in arrival order
- [ ] Exceeding a queue or bypass bound rejects the frame with a wire error naming the bound; the connection stays up
- [ ] A handler completes side effects before writing its response (attach installs the interactive head before responding)
- [ ] Writer failure terminates the head through the boundary; no further frames are read
- [ ] EOF: reading stops, waiting fibers interrupt without wire errors, accepted kernel work settles, exit follows the existing contract
- [ ] `rpc.frame` spans carry session, queue-depth, and bypass attributes

### M8: rpc live proof
Source: `implementation.md` (M8)

- [ ] Live harness aborts a mid-turn prompt through the shipped bin; the snapshot shows stop reason `aborted`
- [ ] Adversarial soak (3+ interleaved sessions, dropped subscriber, oversized frame) keeps existing contracts
- [ ] `01-cli-entry` ledger finding 3 (rpc abort dispatch) resolved with harness evidence
- [ ] README documents `--plugin`, `--no-project-plugins`, and concurrent dispatch semantics

## Deferred follow-up

Source: `implementation.md` (Deferred follow-up); D-006, D-010

- [ ] Per-Session tool visibility (kernel seam change) - D-006
- [ ] Plugin import timeout in `@pop-eye/plugins` - D-010 known limitation
- [ ] Opinionated trust-gate and tool-vetting first-party plugins over the existing `trust` / `tool-call-gate` hook points
- [ ] CLI hot-reload trigger for generations

## Superseded/obsolete checklist debt

(none)

## Summary
- Total features: 52
- Completed: 18
- Remaining: 34
- Current cutoff blockers: 34
- Accepted/deferred follow-up: 4
- Superseded/obsolete checklist debt: 0
