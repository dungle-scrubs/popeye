# 01-cli-entry - Implementation Plan

Wire a spawnable `popeye` command over the existing heads so popeye is
runnable from a shell AND spawnable as a harness by the normalizer
(same pattern as `claude -p` / `pi -p --mode json`). Ledger: D-001..D-007
in `.plans/01-cli-entry/plan.db`. Builds on the complete
00-popeye-coding-agent (Driver, heads, pi-ai seam all merged).

## Architecture

The heads already exist as library functions (`runPrintHead`,
`runJsonHead`, `runRpcHead`) with the stdout/stderr writers and exit-code
contract from M21/M22. The gap is purely the entrypoint: argv/env/stdin
-> a composed Driver (with the pi-ai provider layer from the ai seam)
-> the selected head. No kernel/journal/plugins/protocol changes.

- New: `packages/cli/src/bin/popeye.ts` (shebang entrypoint) + a `bin`
  field on `packages/cli/package.json`.
- New: `packages/cli/src/entry/{args,config,run}.ts` - arg parsing
  (util.parseArgs), env/flag config resolution, and the compose+run
  wiring. Kept as a library seam so it is testable without spawning.
- The provider layer is the M12 pi-ai seam driven by an OpenAI-compatible
  base URL (D-003); the CLI resolves { model, baseUrl, apiKey } from
  flags-over-env (D-002/D-004) and builds `PiAiProviderLive`.

### Boundaries

- bin/entry live in @popeye/cli; they import the composed Driver via
  compose.ts and the public head functions - no new deep imports, the
  existing boundary rules stand.
- Secrets: apiKey from env only, never logged, never in the journal or
  diagnostics (D-004). No --api-key flag.

### Observability

Required: the entry logs a single structured startup line to STDERR
(mode, model, baseUrl-host, session action) so a spawned run is
diagnosable; stdout stays pure protocol per the M22 stderr-logger
discipline. Errors (bad args, missing model/endpoint, provider auth)
exit non-zero with a clear stderr message naming the flag/env to fix.

## Phase 1: CLI entry (one phase, PR to main)

### M1: argv/env/config resolution
- **Testing:** test-first
- **Observability:** required (startup stderr line; typed arg/config errors)
- Tasks: seams under test = `parseArgs(argv)` and
  `resolveConfig(parsed, env)`.
  RED/GREEN: -p headless flag; --mode print|json|rpc (default print);
  positional prompt AND stdin-as-prompt; --model/--base-url/--resume/
  --session-dir; flags override env (POPEYE_MODEL/POPEYE_BASE_URL/
  POPEYE_API_KEY with OPENAI_API_KEY/ANTHROPIC_API_KEY fallback);
  --version prints the cli package version and exits 0; --help;
  missing model or endpoint -> typed error naming the env/flag; an
  --api-key flag is rejected (secrets via env only). rpc mode takes no
  prompt; a prompt with rpc mode errors.

### M2: spawnable bin + head wiring
- **Testing:** test-after (spawns a real subprocess; verified by
  golden output + exit codes)
- **Observability:** required (the spawned process's stderr startup +
  error lines asserted)
- Tasks: `bin/popeye.ts` shebang entrypoint calls the entry run();
  `bin` field added to package.json; version bumped 0.0.0 -> 0.1.0.
  run() composes the Driver with `PiAiProviderLive` from resolved
  config and dispatches: print head (text + exit code), json head
  (wire stream + exit code), rpc head (persistent stdio server).
  Spawn-per-turn semantics for print/json: one prompt -> settlement ->
  exit. A subprocess test drives the built bin over real pipes:
  popeye --version; popeye -p "..." (needs a provider - use the fake
  provider seam, below); popeye -p --mode json "..."; a bad-args exit;
  a missing-config exit. Uniformity check: the flag surface matches
  the documented pi-style shape.

### M3: fake-provider seam + captured wire fixture
- **Testing:** test-after (fixture capture + golden)
- Tasks: an env-gated deterministic provider (POPEYE_FAKE_PROVIDER with a
  scripted-response file, or reuse the recorded-fixture provider) so
  the CLI runs end-to-end WITHOUT a network/model - both for CI tests
  and to capture output. Run `popeye -p --mode json` against it and
  commit the real stdout as
  `packages/cli/test-fixtures/cli-json-stream.jsonl`; a test asserts
  the committed stream decodes through @popeye/protocol
  decodeProgress/decodeSnapshot (closing the normalizer's decoder-
  fixture blocker) and is stable across two runs.

### Gate 1 -> complete
- [ ] popeye --version, popeye -p "...", popeye -p --mode json "...",
      popeye -p --mode rpc all work over a real spawned process
- [ ] the committed cli-json-stream.jsonl decodes through the protocol
      schemas and is stable
- [ ] flag surface documented (README quickstart updated) and matches
      the pi-style -p/--mode vocabulary

## Landing Strategy
| Field | Value |
|---|---|
| Merge target | `main` |
| Branch model | one branch (`cli-entry`) |
| PR cadence | single PR |
| Independent reviewer | boundary review agent + Codex per the rubric |

## Follow-ups (not this plan)
- npm publish (unblocks the normalizer's npm versionSource) -> prepare-public-release
- interactive TUI (pi-tui) -> separate plan
- the normalizer-side descriptor + content decoder -> the normalizer repo
