# pi Source Analysis (earendil-works/pi @ 0.84.1)

Research baseline for the pop-eye plan. Produced 2026-08-10 from a
full source read of the pi monorepo (three parallel deep-dives: extension
system, agent loop + ai layer, protocol/session/TUI). File references are to
the pi repo at that version.

## The single most important structural fact

Pi ships **two parallel stacks**:

| | Shipped stack | New stack (built, tested, dark) |
|---|---|---|
| Agent | `Agent`/`agent-loop.ts` driven by `coding-agent/src/core/agent-session.ts` (3,342 lines) | `packages/agent/src/harness/` (`AgentHarness`) - most methods throw `HarnessNotImplemented` |
| Session store | JSONL v3 entry tree in `session-manager.ts` | JSONL v4 mutation log + lanes/records + SQLite backend |
| Remote drive | `--mode rpc`, JSONL over stdio, 38 commands | CBOR client/server protocol, 9 commands, no CLI entry invokes it |
| Design doc | - | `packages/agent/docs/harness-v2.md` (~4,600 lines) |

Pi's authors already diagnosed their debts; harness-v2 is the cure, unfinished.
pop-eye is essentially that design finished, in Effect, dogfooded.

## Best parts (keep/steal)

1. **pi-ai** (kept as a dependency, D-001):
   - `StreamFn` contract: stream functions never throw; failures are encoded
     in the stream as events + final message with `stopReason: "error"`.
   - API/provider split: a wire protocol is a module structurally exporting
     `stream`/`streamSimple` (`ProviderStreams`); a provider is ~50 lines of
     data via `createProvider`. 10 wire APIs, ~40 providers.
   - `Model.compat`: per-model capability quirks as typed data keyed on the
     API (e.g. `thinkingFormat` with 11 variants), not `if (baseUrl...)`.
   - Lazy imports (`lazyApi`/`lazyStream`) keep startup free of 40 SDKs.
   - Thinking levels (`minimal..max`) clamped per model; cache retention
     translated per provider; TypeBox schemas; deferred responses
     (`DeferredHandle`) for cross-process resume.
2. **Append-only entry tree as the single session primitive.** Entries with
   `id`/`parentId`; branch = leaf-pointer move; compaction = entry (never a
   rewrite); entry ids double as durable RPC cursors. Extension state
   persisted in the tree gives correct per-branch state on fork for free.
3. **Snapshot-authoritative protocol** (new stack): every mutating command
   returns a full `SessionSnapshot` with monotonic `revision`; streaming
   `session_progress` events are transient hints that must never be reduced
   into authoritative state. Kills client-drift bugs; reconnect is trivial.
4. **Extension system judgment calls**:
   - Trust-aware two-pass loading: global extensions answer `project_trust`
     before any project-local code loads. Security by load order.
   - Hooks installed once on the Agent, resolved late through the runner
     pointer: hot reload = atomic swap.
   - Per-event merge semantics: `context`/`before_provider_request` chain;
     `tool_call` block first-wins; `tool_result` accumulates field-wise;
     `input` short-circuits on "handled". (~350 lines of near-duplicate
     emitters pay for this.)
   - Mode polymorphism via a total no-op UI context (`hasUI` = identity
     check); one extension runs in TUI/RPC/JSON/print.
   - Extension UI sub-protocol over RPC: blocking dialogs (select/confirm/
     input/editor) vs fire-and-forget (notify/status/widgets), agent-side
     timeouts, honest degradation.
   - 33 typed events; extensions can rewrite context, replace the provider
     payload, gate tool calls, rewrite results, intercept input, take over
     the editor.
5. **Harness-v2 recovery design**: intent records with pre-provisioned result
   entry ids (idempotent replay), `StepAttemptRecord`, tool records with
   `replay: "never"|"safe"`, pure `reduceLaneState()` over a bounded slice,
   `validateRecordLog()` rejecting 12 named corruption classes,
   `drive: "manual"` making every effect steppable for crash tests.
6. **SQLite backend**: fenced writer leases (`fence+1` on takeover,
   `owner_id AND fence` on renewal - stale owner cannot resume); DDL comments
   marking canonical tables vs derived caches.
7. **Conformance suites** exported for session storage and telemetry;
   third-party backends run them. Adopt as a general pattern.
8. **TUI**: components are pure `render(width): string[]` with a hard width
   contract; all terminal cleverness (diffed line array, synchronized output,
   Kitty images, IME cursor markers, main-screen vs alt-screen renderers)
   lives in the renderer. Zero-dependency, separately published.
9. **Philosophy worth preserving**: no in-process permission theater (real
   isolation is an OS/container boundary - their reasoning is sound); small
   core; the agent writes its own extensions; strict supply-chain hygiene
   (exact pins, min-release-age, lockfile guards, ignore-scripts).

## Debts (what "more elegant" means)

1. **Two of everything, second one unreachable.** Doc drift already leaks
   into the public session-format contract (documents `retainedTail` which
   the shipped writer never emits).
2. **Policy in god objects, coupled by mutation.** Retry/compaction/overflow/
   queueing/extension dispatch/persistence in `agent-session.ts`; retries
   slice messages off agent state; methods monkey-patched; event payloads
   must stay pointer-identical to persisted objects. `interactive-mode.ts`
   is 6,399 lines; `main.ts` 972 lines with ~15 process.exit calls.
3. **Plugin-complete, not plugin-implemented.** One built-in extension
   (llama.cpp, hidden); 22 hardcoded slash commands; core-owned skills/
   templates/compaction. Examples prove the API could host them (plan mode,
   subagents, sandbox, todos exist as examples).
4. **Discipline where types should be.** ~25 regexes over provider error
   prose for retry classification; `tool_call` emitter uniquely missing
   try/catch (buggy handler bricks all tools, invisible in types); conflict
   resolution inconsistent (tools first-wins, shortcuts last-wins, renderers
   silent) with precedence = directory listing order.
5. **Blocking bolted onto streaming.** Per-token `message_update` handlers
   awaited unconditionally; unbounded event queues, silent drop after
   completion, no backpressure; naked `Promise.all` over tool batches (no
   concurrency cap); steering cannot land until a whole tool batch finishes;
   `prompt()` throws while running.
6. **Five discovery surfaces** (extensions, skills, prompt templates, themes,
   packages) over what is nearly one primitive.

## pop-eye design direction (per ledger D-001..D-005)

- **journal**: Schema-versioned append-only log; session = log; branch =
  leaf move; compaction = entry with retained tail; state = fold. JSONL and
  SQLite Layers behind one `Journal` tag + conformance suite.
- **kernel**: `Stream.Stream<AgentEvent, AgentError, Provider | ToolRegistry
  | Journal>`; policy-free loop; retry = `Schedule`; steer/abort = Queue +
  fiber interruption; tool batches = `Effect.forEach` with bounded
  concurrency; per-tool `Scope` for cleanup on interrupt.
- **context**: pure fold (events + budget -> provider messages) with one
  `convertToLlm`-style boundary; compaction is a function here.
- **ai seam**: the only file that knows pi-ai is Promise-land.
  `Stream.fromAsyncIterable` over `AssistantMessageEventStream`; tagged
  errors mapped once.
- **plugins**: Plugin = manifest + `Layer` of contributions. Hooks declare
  merge semantics as data (`Chain | FirstWins | AccumulateWith | Tap`); one
  generic emitter. Tap hooks run on their own fiber with bounded queues
  (hot-path safety by construction). Gate vs observer failure policy in the
  hook's type. Capabilities in the R channel (load-time failure when
  ungranted). Trust = two-phase layer construction. Hot reload =
  `Ref<PluginRuntime>` swap + `Scope` teardown. Namespaced contributions
  with declared priority.
- **protocol/heads**: snapshot-authoritative + progress hints; heads (TUI,
  print, JSON, RPC, SDK, tests) are Stream consumers; backpressure native.

## Open decisions going into the interview

1. TUI strategy: reuse `@earendil-works/pi-tui` as a dependency vs build.
2. v1 scope: kernel + journal + plugins + headless heads first, TUI second?
3. Protocol width at v1 (pi's new protocol died at 9 vs 38 commands; start
   narrow and let plugins extend the command surface?).
4. Runtime: Node vs Bun (Bun only matters for compiled-binary distribution).
5. Naming/package scope, repo layout (single package vs small monorepo).
