# popeye

Keep coding-agent work durable when providers and interfaces change.

popeye is for coding-agent hosts that have outgrown mutable transcripts, hardcoded commands, and
provider rules spread across the runtime. It stores each Session as an append-only Journal. One
Plugin primitive adds Tools, Commands, Hooks, and instruction fragments. Effect services keep
resource lifetime, typed failure, interruption, and concurrency rules visible at module boundaries.

Existing agents often make a Head reconstruct truth from streamed output or put policy in one large
session object. popeye makes Snapshots authoritative and keeps Progress disposable. A stopped process
can reopen the Journal, recover unfinished work, and continue from durable Entries and Records.

```text
Journal -> Entries and Records -> Snapshot and Context
Provider -> ai seam -> Kernel -> Progress -> Heads
Plugin -> Contributions -> registry and Hook emitter
```

## Why this design

The design follows a source review of pi 0.84.1. That system has strong provider support and an
append-only Session tree, but it also has parallel old and new stacks, hardcoded features, mutable
session policy, and more than one remote protocol. See
[`docs/research/pi-analysis.md`](docs/research/pi-analysis.md) for the evidence.

popeye keeps pi-ai behind one ai seam. The Kernel owns Turn execution but not presentation policy.
The Journal is the only durable representation. Context and Snapshots are pure Branch folds.
First-party behavior uses the same Plugin API as project behavior. Heads send protocol commands and
render Progress, but they replace local assumptions with each new Snapshot.

## Architecture at a glance

| Package | Owns |
| --- | --- |
| `@popeye/journal` | Session Entries and Records, Branch reads, Compaction, JSONL and memory Layers, Journal conformance |
| `@popeye/kernel` | Driver, mailbox, Turns, Steering, Follow-ups, Tool execution, recovery, Context fold, ai seam |
| `@popeye/plugins` | manifests, Contributions, Capabilities, Trust, generic Hook emission, generations and reload |
| `@popeye/protocol` | commands, Snapshots, Progress, results, and interaction wire Schemas |
| `@popeye/cli` | print, JSON, and RPC Head functions plus first-party Plugin composition |

The package graph points inward. Protocol has no Kernel dependency. pi-ai imports stay inside the
kernel ai seam. Feature modules import public package roots only.

## Install

For a repository quickstart, use Node 24 or later and pnpm 11.5.2. The workspace packages remain
private. `@popeye/cli` is version `0.1.0` and is linked as the `popeye` executable in this workspace.
No npm release exists yet.

```sh
corepack enable
pnpm install
pnpm build
```

## Use it

Set an OpenAI-compatible endpoint and model. Loopback endpoints such as LM Studio do not need an
API key. Hosted endpoints also need `POPEYE_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY`.

```sh
export POPEYE_MODEL="your-model"
export POPEYE_BASE_URL="http://127.0.0.1:1234/v1"

popeye --version
popeye -p "Explain this repository."
popeye -p --mode json "Explain this repository."
popeye -p --mode rpc
popeye "Explain this repository."
echo "Explain this repository." | popeye -p
```

Inside this repository, replace `popeye` with `pnpm --filter @popeye/cli popeye` when the installed bin
is not on `PATH`. Use `--resume <sessionId>` to continue a Session. Use `--session-dir <dir>` to
replace the default `.popeye/sessions` Journal directory. Print mode writes settled assistant text.
JSON mode writes only Progress and Snapshot JSON lines. RPC mode stays open and accepts LF-delimited
protocol commands on stdin. RPC frames dispatch per Session in arrival order. `abort` and
`interaction-response` frames bypass the Session queue so they can run during a Turn.

Use `--plugin <path>` to load an additional Plugin. The flag is repeatable. Use
`--no-project-plugins` to skip project-local Plugins.

The CLI auto-trusts discovered Plugin code. It loads user-global Plugins from `~/.popeye/plugins` and
project Plugins from `.popeye/plugins`. Tools contributed by loaded Plugins are available to the
model. Running `popeye` inside a repository executes that repository's Plugin code, the same trust
you extend to its own scripts; use `--no-project-plugins` to opt out, or install a Trust-gate
Plugin user-globally.

## Guides

- [Plugin authoring](docs/plugin-authoring.md) covers manifests, all 4 Contribution kinds, Hook
  decisions, Capabilities, Trust, TypeScript limits, and generation drain.
- [Conformance suites](docs/conformance-suites.md) shows how to run the published Journal and ai
  seam contracts.
- [Testing with recorded fixtures](docs/testing-with-fixtures.md) covers deterministic fixture
  regeneration and the crash matrix.
- [Ubiquitous language](CONTEXT.md) defines Session, Journal, Entry, Record, Branch, Snapshot,
  Context, Progress, Kernel, Turn, Plugin, and Head.
- [Journal ADR](docs/adr/0001-journal-is-the-only-representation.md) records why the Journal is the
  only durable Session representation.

## v1 scope

v1 is headless. It includes an in-process Driver plus print, JSON, and RPC Head functions. It ships
memory and JSONL Journal Layers. It uses an exact pi-ai dependency for providers. Journal files are
append-only and do not yet have vacuum or export compaction.

The following work is deferred:

- a TUI Head;
- a SQLite Journal Layer;
- npm-referenced Plugins;
- bounded Snapshot pagination before a Snapshot exceeds 1 MiB;
- Kernel and Plugin initiation of select, confirm, and input requests.

The protocol already reserves Entry-range addressing for pagination. It also defines interaction
request and response frames. Those wire contracts do not mean the deferred Kernel paths exist. v1
Heads remain non-interactive and use declared interaction fallbacks.

## Contributing

Run the complete local gate before review:

```sh
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm check-boundaries
```

Do not edit generated plan files to record code changes. Keep package boundaries intact. Add
durable behavior through Entries and Records. Add product behavior through Contributions.

## License

This repository does not contain a license file. No license grant is provided.

## Exit codes

- 0 - the turn completed (done or truncated)
- 1 - the provider settled the turn as an error
- 2 - aborted turn, OR bad arguments / missing config (read stderr to distinguish)
- 3 - unresolved tool calls
- 4 - a turn failure or defect
