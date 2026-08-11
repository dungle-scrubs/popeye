# 01-cli-entry - Progress Report

> Canonical source of truth for what is done. Update as features land.

> Current focus: Phase 1 - CLI entry

## Phase 1: CLI entry

### M1: argv/env/config resolution
Source: implementation.md (M1); D-001, D-002, D-004, D-005

- [x] parseArgs handles -p headless flag
- [x] --mode print|json|rpc parsed (default print)
- [x] positional prompt parsed
- [x] stdin used as prompt when no prompt arg and stdin is piped
- [x] --model / --base-url / --resume / --session-dir parsed
- [x] flags override env; PEYE_MODEL/PEYE_BASE_URL/PEYE_API_KEY read
- [x] OPENAI_API_KEY / ANTHROPIC_API_KEY fallback for the key
- [x] --version prints the cli package version and exits 0
- [x] --help prints usage and exits 0
- [x] missing model or endpoint fails typed, naming the env/flag to set
- [x] --api-key flag is rejected (secrets via env only)
- [x] rpc mode rejects a prompt arg with a clear error

### M2: spawnable bin + head wiring
Source: implementation.md (M2); D-003, D-006

- [x] bin/peye.ts shebang entrypoint added; bin field in package.json
- [x] version bumped 0.0.0 -> 0.1.0
- [x] run() composes the Driver with PiAiProviderLive from config
- [x] print head dispatch: final text + stop-reason exit code
- [x] json head dispatch: wire stream + exit code, spawn-per-turn
- [x] rpc head dispatch: persistent LF-delimited stdio server
- [x] a spawned-subprocess test drives the built bin (--version, -p,
      --mode json, bad-args exit, missing-config exit)
- [x] startup line + errors go to stderr; stdout stays pure protocol
- [x] flag surface matches the documented pi-style -p/--mode shape

### M3: fake-provider seam + captured wire fixture
Source: implementation.md (M3); D-007

- [x] env-gated deterministic provider runs the CLI end-to-end without
      a network/model
- [x] peye -p --mode json against it captured as
      test-fixtures/cli-json-stream.jsonl
- [x] committed stream decodes through @peye/protocol decoders
- [x] fixture stable across two runs

## Deferred follow-up

- [ ] npm publish (normalizer npm versionSource) - prepare-public-release
- [ ] interactive TUI (pi-tui) - separate plan
- [ ] normalizer-side descriptor + content decoder - normalizer repo

## Summary
- Total features: 25
- Completed: 25
- Remaining: 0
- Current cutoff blockers: 0
- Accepted/deferred follow-up: 3
- Superseded/obsolete checklist debt: 0
