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
| `@dungle-scrubs/popeye-journal` | Session Entries and Records, Branch reads, Compaction, memory, JSONL, and SQLite Layers, JSONL-to-SQLite migration, Journal conformance |
| `@dungle-scrubs/popeye-kernel` | Driver, mailbox, Turns, Steering, Follow-ups, Tool execution, recovery, Context fold, ai seam |
| `@dungle-scrubs/popeye-plugins` | manifests, Contributions, Capabilities, Trust, generic Hook emission, Plugin interactions, generations and reload |
| `@dungle-scrubs/popeye-protocol` | commands, Snapshots, Snapshot pagination, Progress, results, and interaction wire Schemas |
| `@dungle-scrubs/popeye` | the `popeye` executable, print, JSON, RPC, and HCN Heads, `usage export`, and first-party Plugin composition |

The package graph points inward. Protocol has no Kernel dependency. pi-ai imports stay inside the
kernel ai seam. Feature modules import public package roots only.

## Install

Run popeye from a checkout of this repository. Use Node 24 or later and pnpm 11.5.2. The five
packages share one version, set in each `packages/*/package.json`, and `popeye --version` prints it.
`@dungle-scrubs/popeye` provides the `popeye` executable.

The packages are published to npm under the `@dungle-scrubs` scope, but four of the five current
registry versions, including the CLI, do not install. As of 2026-10-03, the published manifests of
`@dungle-scrubs/popeye`, `@dungle-scrubs/popeye-kernel`, `@dungle-scrubs/popeye-plugins`, and
`@dungle-scrubs/popeye-protocol` carry `workspace:*` dependencies, which npm and pnpm cannot
resolve, and the registry lags the 0.1.4 release. Install from this repository until a fixed
release ships. [#69](https://github.com/dungle-scrubs/popeye/issues/69) tracks the publish defect.

```sh
corepack enable
pnpm install
pnpm build
```

## Use it

Set an OpenAI-compatible endpoint and model. Loopback endpoints such as LM Studio need no API key;
popeye sends a local placeholder unless `POPEYE_API_KEY` is set. `POPEYE_API_KEY` is the endpoint
credential and overrides every other key on every endpoint. Without it, popeye reads a provider
key only for that provider's own API host: `OPENAI_API_KEY` for `https://api.openai.com` and
`ANTHROPIC_API_KEY` for `https://api.anthropic.com`. The match is exact (scheme, host, and port).
Any other hosted endpoint, such as a gateway, proxy, or LAN host, requires `POPEYE_API_KEY`;
without it, popeye exits with status 2 before it sends a request. An empty or whitespace-only key
counts as unset.

```sh
export POPEYE_MODEL="your-model"
export POPEYE_BASE_URL="http://127.0.0.1:1234/v1"

popeye --version
popeye -p "Explain this repository."
popeye -p --mode json "Explain this repository."
popeye -p --mode rpc
popeye "Explain this repository."
echo "Explain this repository." | popeye -p
popeye usage export --session-dir .popeye/sessions
```

Inside this repository, replace `popeye` with `pnpm --filter @dungle-scrubs/popeye popeye`. That
form runs from `packages/cli`, so a relative `--session-dir`, the default `.popeye/sessions` Journal
directory, and project Plugins in `.popeye/plugins` resolve under `packages/cli`. Use
`--resume <sessionId>` to continue a Session. Use `--session-dir <dir>` to
replace the default `.popeye/sessions` Journal directory. Print mode writes settled assistant text.
JSON mode writes only Progress and Snapshot JSON lines. RPC mode stays open and accepts LF-delimited
protocol commands on stdin. RPC frames dispatch per Session in arrival order. `abort`, `close`,
`interaction-response`, and `steer` frames, and `invoke-command` frames for `goal pause` or
`goal clear`, bypass the Session queue so they can act on a running Turn. A `prompt` frame with
`deliveryMode: "steer"` bypasses the queue only while that Session's `prompt` frame is running in
the Kernel, including the Goal continuation Turns that frame waits on; otherwise it waits in the
queue and opens the next Turn. A `steer` frame is acknowledged as soon as the Kernel accepts it: it
joins the running Turn, including a Goal continuation Turn, at its next safe point, becomes a
Follow-up when the Turn has not started or has closed Steering, and fails with
`phase_invalid_command` when the Session has no running or pending Turn. Control frames share a
bound of 64 concurrent handlers; steer-mode prompts waiting on a running Turn have their own bound
of 64.

`popeye usage export` reads all Session Records and writes one JSON line per Provider request.
`--session <id>` limits the scan. Each row has stable Session, owner, and request IDs; Provider
and model identity; a `providerClass`; outcome; and separate input, output, cache-read, cache-write, one-hour
cache-write, and reasoning counts. A started request with no receipt is `pending`, with unknown
counts. Repeated exports have the same request IDs, so an external collector can upsert them.
The command opens JSONL or SQLite read-only and emits no Entry content, prompts, responses, Tool
data, endpoint URLs, or credentials. It exits nonzero on a torn or invalid Journal read.

The CLI records `provider: "openai-compatible"` for a configured base URL. It sets
`providerClass: "local"` when the endpoint host is loopback (`localhost`, a `*.localhost` name, an
IPv4 address in `127.0.0.0/8`, or `::1`) and `providerClass: "unknown"` for any other host. It never
emits `hosted`. A loopback relay that forwards to a hosted Provider is still `local`, so a collector
must not infer a public API price from the model name. The pinned pi-ai version normalizes missing usage fields to zero for several Providers.
Popeye labels positive values `normalized`, faux Provider estimates `estimated`, and ambiguous
zeros `unknown`; it never treats context-pressure
`ProviderUsage` as billable tokens. Historical Sessions without these Records have unknown usage
coverage. The export does not calculate prices.

Use `--plugin <path>` to load an additional Plugin. The flag is repeatable. Use
`--no-project-plugins` to skip project-local Plugins.

### Session Goals

The first-party `goal` Command stores a Goal on the current Journal Branch. Only the user can create,
replace, resume, or clear a Goal. The model can read it through `manage-goal` and, while it is active,
pause it, report a blocker with a reason, or report completion with evidence. Ordinary prompts and
earlier user requests in Context do not authorize the model to activate or resume a Goal. A Goal
stays in Context after Compaction or Session resume. When a Turn ends while the Goal is active, the
Kernel queues one continuation Turn at a time. A queued user Follow-up runs first. Abort, stop, or an
error pauses an active Goal. The Kernel blocks a Goal after 40 automatic continuations. Clearing a
Goal records a terminal `cancelled` status so the last condition remains inspectable. A prompt working
on an explicitly started Goal waits for its continuation chain; print, JSON, HCN, and RPC keep that
completion contract.

The print, JSON, and HCN Heads accept `/goal <objective>` and bare `/goal` as text Commands. Use
`/goal pause`, `/goal resume`, `/goal clear`, `/goal blocked <reason>`, or
`/goal complete <evidence>` to update it. `/goal <objective>` creates or replaces the Goal. Send a
normal prompt after setting the Goal to start work. An RPC Head invokes `goal` through
`invoke-command`, with arguments such as
`{"action":"set","objective":"Finish and verify the task"}`. A sole `/goal resume` restarts work.
A resumed print, JSON, or HCN Head with no new prompt continues an active Goal. RPC clients use
`resume-goal` after `resume` when they want to continue without a new prompt. After abort, resume a
paused Goal explicitly through `/goal resume` or the corresponding user RPC path.

The CLI auto-trusts discovered Plugin code. It loads user-global Plugins from `~/.popeye/plugins` and
project Plugins from `.popeye/plugins`. Tools contributed by loaded Plugins are available to the
model. Running `popeye` inside a repository executes that repository's Plugin code, the same trust
you extend to its own scripts; use `--no-project-plugins` to opt out, or install a Trust-gate
Plugin user-globally.

### Default Tools

The headless host ships no filesystem or shell coding Tools. With the default first-party Plugins
(`compact`, `goal`, `reload`, and `session-name`), the only model-visible Tool is `manage-goal`.
The model cannot read or write files or run commands until a Plugin adds Tools for that.
[Plugin authoring](docs/plugin-authoring.md#minimal-local-coding-plugin) has a minimal local coding
Plugin with `read-file`, `write-file`, and `run-command` Tools.

### Agent definitions

`--agent <name>` starts a headless Session as an Agent definition: a markdown file with YAML
frontmatter and a body. The frontmatter requires `name` and `description`; `tools` and `model`
are optional. The body is appended to the system prompt.

```sh
popeye -p --agent scout "Map the auth flow."
```

Discovery reads two flat directories: `~/.popeye/agents` for user definitions and `.popeye/agents`
at the project root for project definitions. Set `POPEYE_AGENTS_DIR` to read user definitions from
another directory. A project definition shadows a user definition of the same name. A file with
invalid frontmatter is skipped with a warning on stderr; the other definitions still load.
Discovery happens when `--agent` is used.

Name resolution is exact and case-sensitive. An unknown name fails startup and lists the available
names. Two definitions in one scope with the same name fail startup and name both files. The
`model` frontmatter key picks the Provider model when `--model` is absent: `--model` beats the
agent file, and the agent file beats `POPEYE_MODEL`. A `tools` list is checked against the tools
this process grants: a list whose every name is unknown fails startup, and partially unknown names
are reported as warnings. `--agent` is refused in RPC mode, like the system-prompt flags.

`--agent` is a startup input, like `--system-prompt` and `--append-system-prompt`. Nothing about
the agent is journaled with the Session: resuming a Session that ran as an agent without passing
`--agent` again produces an unagented Session, with no warning. Pass `--agent` on resume to
continue with the same persona.

## Guides

- [Plugin authoring](docs/plugin-authoring.md) covers manifests, all 4 Contribution kinds, Hook
  decisions, Capabilities, Trust, TypeScript limits, generation drain, and a minimal local coding
  Plugin.
- [Conformance suites](docs/conformance-suites.md) shows how to run the published Journal and ai
  seam contracts.
- [Testing with recorded fixtures](docs/testing-with-fixtures.md) covers deterministic fixture
  regeneration and the crash matrix.
- [Ubiquitous language](CONTEXT.md) defines Session, Journal, Entry, Record, Branch, Snapshot,
  Context, Progress, Kernel, Turn, Plugin, and Head.
- [Journal ADR](docs/adr/0001-journal-is-the-only-representation.md) records why the Journal is the
  only durable Session representation.

## v1 scope

v1 is headless. It includes an in-process Driver plus print, JSON, RPC, and HCN Heads. It ships
memory, JSONL, and SQLite Journal Layers. It uses an exact pi-ai dependency for providers. Journal
files are append-only and do not yet have vacuum or export compaction.

The CLI picks the Journal Layer for each Session directory. `POPEYE_JOURNAL_LAYER=sqlite` stores
Sessions in `<session-dir>/journal.sqlite`. `POPEYE_JOURNAL_LAYER=jsonl` stores one
`<sessionId>.jsonl` file per Session. When the variable is unset, the CLI uses SQLite if
`journal.sqlite` exists in the directory and JSONL if it does not. Any other non-empty value logs a
warning and uses the same file check. The CLI does not move Sessions between Layers.
`migrateJsonlToSqlite` from `@dungle-scrubs/popeye-journal` copies a JSONL directory into
`journal.sqlite`.

A Head pages a Snapshot whose encoded size exceeds the page target: 1,048,576 bytes by default, or
the value of `POPEYE_SNAPSHOT_PAGE_BYTES`. A paged Snapshot holds a leaf-anchored window of Entries
and an `entryRange` that marks whether more Entries come before it. A single Entry larger than the
page target arrives whole, so that Snapshot exceeds the target. An RPC client reads other windows
with `get-snapshot` and `beforeEntryId` or `afterEntryId`. A range read is not paged: it returns
every Entry in the range, and a frame larger than the 1 MiB RPC frame limit fails.

A Plugin that holds the `interaction` Capability raises select, confirm, and input requests through
`PluginInteractions`. A request without that Capability resolves to its declared fallback at once.
In RPC mode, the Head sends a request to the client attached to its Session (an `attach` frame
without `interactive: false`) and accepts the `interaction-response` frame. With no attached client,
the request waits until its timeout and then resolves to its fallback. During startup Plugin
composition in every mode, and in the print, JSON, and HCN Heads, each request resolves to its
declared fallback at once.

The following work is deferred:

- a TUI Head;
- npm-referenced Plugins;
- Kernel initiation of select, confirm, and input requests.

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

popeye is released under the [MIT License](LICENSE).

## Exit codes

- 0 - the turn completed (done or truncated)
- 1 - the provider settled the turn as an error
- 2 - aborted turn, OR bad arguments / missing config (read stderr to distinguish)
- 3 - unresolved tool calls
- 4 - a turn failure or defect
