# 03-deferred-follow-ups - Progress Report

> Auto-generated from implementation plan. This is the canonical
> source of truth for what is done and what remains. Update this
> file as features are implemented - never mark a milestone complete
> until every current-cutoff checkbox under it is checked.

> Current focus: Phase 3 - Interactions and gates (M8 remaining; M9 hardening)

## Phase 1: Leasing and Session-scoped Tools

### M1: Generation lease primitive
Source: `implementation.md` (M1); D-005

- [x] `checkout` yields a lease on the current generation; the generation cannot close while the lease's Scope is open
- [x] `reload` drains: the old generation closes only after the last lease releases; leases taken after the swap are on the new generation
- [x] `use`/`useSerialized` re-expressed over checkout; existing generation tests stay green unmodified
- [x] Swap diagnostics carry the lease count

### M2: Kernel Session-keyed Tool path
Source: `implementation.md` (M2); D-004, D-005

- [x] `ToolRegistryLive(tools)` satisfies the new `view(sessionId)` contract as the degenerate same-view constructor; existing kernel tests green
- [x] The turn loop resolves the view once per Turn open; tool-loop, steering-recursion, and transient-retry requests all use it
- [x] A view swapped mid-Turn is not picked up until the next Turn (stability asserted against a flipping fake registry)
- [x] The seam receives declarations per request; two Sessions with different views produce different provider `tools` arrays in one process (contract-suite fixture)
- [x] Compaction summarization requests carry no tool declarations
- [x] `sessions.ts` recovery resolves `availableToolNames` via `view(sessionId)`; recovery-matrix suite green
- [x] The recovery name-identity caveat is documented in `docs/plugin-authoring.md`

### M3: CLI Session-keyed resolution
Source: `implementation.md` (M3); D-004

- [x] The CLI provides `view(sessionId)` resolving against the current generation at call time, with behavior parity to today
- [x] The E2E fake-provider tool turn passes through the new path
- [x] The startup line's `toolCount` reads the startup view (no static tool array remains)

## Phase 2: Composition root and reload

### M4: CLI composition root
Source: `implementation.md` (M4); D-006

- [x] Startup through the composition root preserves every existing behavior (bin, pipeline, guard, and audit-field tests green)
- [x] Host services, tool views, grants, and audit fields all follow a swapped generation (asserted by swapping in-process)
- [x] Grants recompute at swap; a Session's next Turn sees the new union; audit fields report it
- [x] Recomposition is one function (discovery, load, guards, first-party registration) shared by startup and reload

### M5: /reload Command and swap semantics
Source: `implementation.md` (M5); D-003, D-006

- [x] `/reload` swaps generations; the result reports old/new ids and Plugin/Tool deltas; the next Turn uses the new tools
- [x] An in-flight Turn on another Session finishes on the old generation (stalled fake provider)
- [x] A failed recomposition leaves the current generation serving with a typed error result
- [x] Reload-while-busy rejects typed; a drain timeout fails the reload with both generations alive, a diagnostic naming the holder, and the old generation still closing when its Turn settles
- [x] The trust flow is re-entered on reload (auto-trust default unchanged)
- [x] Live harness: reload mid-session over rpc; a newly added tool is visible to the next Turn

## Phase 3: Interactions and gates

### M6: Import timeout
Source: `implementation.md` (M6)

- [x] A never-settling import fails typed at the bound naming the file; default 30s, configurable
- [x] Startup maps the timeout fail-closed (exit 2)
- [x] Reload maps the timeout contained (current generation serves)

### M7: PluginInteractions seam
Source: `implementation.md` (M7); D-009, D-010, D-014

- [x] The emitter sets a current-plugin identity around every contribution execution; `PluginInteractions.request` stamps it
- [x] Grant-gated: an ungranted `interaction` resolves the declared fallback with a diagnostic; granted proceeds
- [x] Protocol round-trip with the additive optional `pluginName`; an older-decoder fixture ignores it
- [x] The `tool-call-gate` input gains the additive optional `sessionId`; existing hook fixtures stay green
- [x] rpc live Layer: requests deliver to the attached head; pending requests deliver on attach; timeout resolves the fallback; an interrupted request removes its pending entry (no stale delivery, id reusable)
- [x] The null Layer resolves fallbacks immediately and is wired in print/json and during startup composition in all modes
- [x] The 25s gate-interaction default nests inside the 30s hook timeout (clocked: the interaction fallback decides, not the hook timeout)

### M8: Opt-in gate Plugins and emission
Source: `implementation.md` (M8); D-002, D-007, D-008

- [ ] The adapter emits `tool-call-gate` after `tool_started` and before execute; with no contributor everything is allowed and existing tests stay green (default run zero-cost)
- [ ] Vetting rejection becomes a model-visible error tool result in call order
- [ ] Allow-once and allow-for-session work via a scripted interactive head; session memory is generation-scoped (a reload forgets, asserted)
- [ ] Trust gate: headless startup denies immediately with no stall (clocked); reload over rpc answered trusted loads stage-2 sources; fallback untrusted swaps without project plugins, reported in the result counts
- [ ] The linkable-module install path (symlink into the user dir) loads the gates; the default set never includes them
- [ ] Live harness: a vetting prompt answered over rpc against the local endpoint

## Phase 4: Hardening

### M9: Test hardening
Source: `implementation.md` (M9); 02/D-025

- [ ] rpc soak captures raw stdout bytes and asserts frame integrity on byte boundaries, provider-start ordering per Session, and tightened assertions
- [ ] Kernel test: abort between provider retry attempts asserts one provider start, stop reason `aborted`, and a usable Session afterward
- [ ] Full gate plus 10x flake runs green

## Deferred follow-up

Source: `implementation.md` (Deferred follow-up); D-007

- [ ] Startup-interactive trust (two-stage composition) - TUI plan
- [ ] npm-referenced Plugin packages
- [ ] Trust-gate allowlist layer

## Superseded/obsolete checklist debt

(none)

## Summary
- Total features: 43
- Completed: 34
- Remaining: 9
- Current cutoff blockers: 9
- Accepted/deferred follow-up: 3
- Superseded/obsolete checklist debt: 0
