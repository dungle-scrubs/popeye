# peye

Keep coding-agent work durable when providers and interfaces change.

peye is for coding-agent hosts that have outgrown mutable transcripts, hardcoded commands, and
provider rules spread across the runtime. It stores each Session as an append-only Journal. One
Plugin primitive adds Tools, Commands, Hooks, and instruction fragments. Effect services keep
resource lifetime, typed failure, interruption, and concurrency rules visible at module boundaries.

Existing agents often make a Head reconstruct truth from streamed output or put policy in one large
session object. peye makes Snapshots authoritative and keeps Progress disposable. A stopped process
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

peye keeps pi-ai behind one ai seam. The Kernel owns Turn execution but not presentation policy.
The Journal is the only durable representation. Context and Snapshots are pure Branch folds.
First-party behavior uses the same Plugin API as project behavior. Heads send protocol commands and
render Progress, but they replace local assumptions with each new Snapshot.

## Architecture at a glance

| Package | Owns |
| --- | --- |
| `@peye/journal` | Session Entries and Records, Branch reads, Compaction, JSONL and memory Layers, Journal conformance |
| `@peye/kernel` | Driver, mailbox, Turns, Steering, Follow-ups, Tool execution, recovery, Context fold, ai seam |
| `@peye/plugins` | manifests, Contributions, Capabilities, Trust, generic Hook emission, generations and reload |
| `@peye/protocol` | commands, Snapshots, Progress, results, and interaction wire Schemas |
| `@peye/cli` | print, JSON, and RPC Head functions plus first-party Plugin composition |

The package graph points inward. Protocol has no Kernel dependency. pi-ai imports stay inside the
kernel ai seam. Feature modules import public package roots only.

## Install

For a repository quickstart, use Node 24 or later and pnpm 11.5.2. The workspace packages are
private at version `0.0.0`; no npm release exists yet.

```sh
corepack enable
pnpm install
pnpm build
```

## Use it

Run a complete Head fixture after the build:

```sh
pnpm exec vitest run packages/cli/src/heads/heads.test.ts
```

The last command runs the print and JSON Heads through complete fake-Provider Sessions. It covers
plain output, Tool use, provider errors, aborts, Progress, and final Snapshots without network
access. Application hosts compose `DriverDefault` with one Journal Layer, one Provider Layer, and a
Tool registry. The in-process Driver is also the SDK and test Head.

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
