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

Install the CLI from npm. Use Node 24 or later. `@dungle-scrubs/popeye` provides the `popeye`
executable.

```sh
npm install -g @dungle-scrubs/popeye
popeye --version
```

The five packages share one version, set in each `packages/*/package.json`, and `popeye --version`
prints it. The CLI depends on the other four packages at that same version. Versions before 0.1.5
do not install, because their published manifests carry `workspace:*` dependencies; they are
deprecated on npm.

To run popeye from a checkout of this repository instead, use pnpm 11.5.2:

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
`--resume <sessionId>` to continue a Session. Use `--session-dir <dir>` to replace the default
`.popeye/sessions` Journal directory. Print mode writes settled assistant text. JSON mode writes
only Progress and Snapshot JSON lines. `assistantThinking` Progress streams while the model reasons.
Thinking never enters the Snapshot, and it is provisional: a failed, retried, or aborted Provider
attempt may have published thinking that no later frame retracts. `assistantText` Progress for an
attempt arrives once that attempt's stream completes, so a retried attempt's text is never shown.
RPC mode stays open and accepts LF-delimited protocol commands on stdin. RPC frames dispatch per
Session in arrival order. `abort`, `close`, `interaction-response`, and `steer` frames, and
`invoke-command` frames for `goal pause` or `goal clear`, bypass the Session queue so they can act
on a running Turn. A `prompt` frame with `deliveryMode: "steer"` bypasses the queue only while that
Session's `prompt` frame is running in the Kernel, including the Goal continuation Turns that frame
waits on; otherwise it waits in the queue and opens the next Turn. A `steer` frame is acknowledged
as soon as the Kernel accepts it: it joins the running Turn, including a Goal continuation Turn, at
its next safe point, becomes a Follow-up when the Turn has not started or has closed Steering, and
fails with `phase_invalid_command` when the Session has no running or pending Turn. Control frames
share a bound of 64 concurrent handlers; steer-mode prompts waiting on a running Turn have their own
bound of 64.

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

The CLI auto-trusts discovered Plugin code. It loads user-global Plugins from `~/.popeye/plugins`
and project Plugins from `.popeye/plugins`. Tools contributed by loaded Plugins are available to the
model. Running `popeye` inside a repository executes that repository's Plugin code, the same trust
you extend to its own scripts; use `--no-project-plugins` to opt out, or install a Trust-gate
Plugin user-globally. Project-scope Agents are also discovered at every headless start: their
descriptions enter the model's context through `delegate`, and their bodies can become child
personas. `--no-project-plugins` skips project-scope Agents at startup and on every delegate or rpc
Agent resolution; only user-scope Agents remain available.

### Default Tools

The headless host ships no filesystem or shell coding Tools. With the default first-party Plugins
(`compact`, `goal`, `reload`, and `session-name`), the only model-visible Tool is `manage-goal`.
When at least one Agent definition is discoverable, the first-party `delegation` Plugin adds the
`delegate` Tool (see Delegation).
The model cannot read or write files or run commands until a Plugin adds Tools for that.
[Plugin authoring](docs/plugin-authoring.md#minimal-local-coding-plugin) has a minimal local coding
Plugin with `read-file`, `write-file`, and `run-command` Tools.

### Agent definitions

`--agent <name>` starts a headless Session as an Agent definition: a markdown file with YAML
frontmatter and a body. The frontmatter requires `name` and `description`; `tools` and `model` are
optional. The body is appended to the system prompt.

```sh
popeye -p --agent scout "Map the auth flow."
```

Discovery reads two flat directories: `~/.popeye/agents` for user definitions and `.popeye/agents`
at the project root for project definitions. Set `POPEYE_AGENTS_DIR` to read user definitions from
another directory. A project definition shadows a user definition of the same name. A file with
invalid frontmatter is skipped with a warning on stderr; the other definitions still load.
Discovery runs at every headless start. With `--agent`, a load error fails startup and
each skipped file is reported on stderr. Without `--agent`, nothing changes unless at
least one definition is discoverable: then skipped files are reported the same way and the
`delegate` Tool is registered. A load error, or files that are all skipped, leaves stderr
and the Tool list as they were.

Name resolution is exact and case-sensitive. An unknown name fails startup and lists the available
names. Two definitions in one scope with the same name fail startup and name both files. The `model`
frontmatter key picks the Provider model when `--model` is absent: `--model` beats the agent file,
and the agent file beats `POPEYE_MODEL`. A `tools` list narrows the Tools the Session is offered:
the Session gets only the Tools that are both in the list and granted by `--tools`, `--exclude-
tools`, and `--access`, so no flag can widen it, and a first-party Tool such as `manage-goal` must
be listed to stay available. `native:<name>` is accepted. A list whose every name is outside the
granted Tools fails startup, so any non-empty list fails under `--isolation tool-free`. Names
outside the granted Tools, whether no Tool has that name or a flag removed it, are reported on
stderr, and the Session runs with the rest. An absent or empty list changes nothing. RPC mode
refuses `--agent`; an RPC client names the Agent per Session with the `agent` field of `create`
(below).

`--agent` is a startup input, like `--system-prompt` and `--append-system-prompt`. Nothing about the
agent is journaled with the Session: resuming a Session that ran as an agent without passing
`--agent` again produces an unagented Session, with no warning. Pass `--agent` on resume to continue
with the same persona. Within a run, every Turn of the head Session carries the agent body,
`--append-system-prompt`, `--system-prompt`, and `--effort`, including a Goal continuation and a
sole `/goal resume` restart.

An RPC client starts an Agent session with `{"_tag":"create","agent":"<name>"}`. Each such `create`
reads both directories again, so an edited definition applies to the next one. The name, `model`,
body, and `tools` list resolve exactly as for `--agent`, but for that Session only: other Sessions
in the process keep the process model and Tools. `--model` on the process beats the agent `model`,
which beats `POPEYE_MODEL`, and a later `set-model` for the Session beats all three. Every Turn
the Session runs carries the body as appended system prompt and uses that model: a `prompt`, a
Goal continuation, a `resume-goal` or Goal restart, and a `steer` that becomes a Follow-up alike.
Compaction requests inside those Turns still use the process model. An unknown name, a definition
load failure, an unresolvable Agent model, or a `tools` list with no granted name fails the `create`
with error code `agent_error` and creates no Session; `details.reason` names the cause
(`agent_model_unresolvable`
for an unresolvable Agent model), and for `unknown_agent`, `details.available` lists the names.
Names outside the granted Tools are logged on stderr, and the Session runs with the rest. A `fork`
of an Agent session runs as the same Agent, even when the fork fails partway and leaves the new
Session behind. After `close`, a `resume` without `agent`, in the same process or a new one, is a
plain Session; `{"_tag":"resume","sessionId":"<id>","agent":"<name>"}` resumes it as the Agent,
resolved the same way, with the Agent's Tools already in force for crash recovery. The same failures
fail the `resume` with `agent_error` and leave the Session unresumed. A `resume` with `agent` of a
Session that already runs as an Agent in this process fails with `details.reason`
`agent_session_bound`: `close` it first.

#### Delegation

When at least one Agent definition is discoverable at startup, the first-party `delegation`
Plugin registers the `delegate` Tool in every mode. Its arguments are `agent` (an exact
definition name), `task`, and an optional `cwd`. Each call discovers definitions again, so
edits apply to the next call. A call creates a new child Session in the same
`--session-dir`, applies the definition's body, `model`, and `tools` to it, prompts it with
`Task: <task>`, and returns the child's final message as the Tool result. The child sees only
the task, not the parent's conversation. Its Tools are the intersection of the process
grant, the parent Session's own filters, and the definition's `tools` list, so a child is
never offered a Tool its parent cannot call; a child keeps `delegate` only when its parent
has it and its list does not leave it out. Delegation is capped at depth 3: a Session created or
resumed by the head is depth 0, and each child is its parent's depth plus 1. A depth-3 child is
never offered `delegate`, and a direct call at depth 3 or more fails without creating a child.
Depth is tracked only in-process and dropped on release; a child resumed later is a head Session
at depth 0. There is no global bound on combined descendant concurrency. `--model` beats
the definition's `model` for children too, and `--effort` applies to children;
`--system-prompt` and `--append-system-prompt` do not. In rpc mode a child does not inherit the
parent Session's `set-model` or `set-thinking`: it uses its Agent's `model` unless `--model`
was passed, and the head's `--effort`. A child's compaction requests use
the process model and reasoning level, not the definition's `model` or `--effort`. No
Agent name or model setting is stored in the child Session and no `model_change` Entry
is added, so resuming a child does not restore its Agent's model; request accounting
Records still name the model each request used. `cwd` resolves against the process working
directory, must be a directory, and reaches the child as a `Working directory:` line in its system
content; Tools still run in the process working directory. An unknown name returns a failed result
that lists the available agents. Several `delegate` calls in one response run in parallel
under the Tool batch limit (4 by default). Aborting the parent Turn aborts the child: a
child Turn that had started keeps what it completed and an aborted assistant message, and
one that had not started yet never starts. The child Session resumes with
`--resume <id>`. The child's final message is returned whole, with no truncation in v1. A
message larger than the parent's context budget ends the parent Turn with an error: with
compaction on (the default), summarizing it can exhaust the Turn's Provider round bound
(`provider_error`); with compaction off, or when the retained message alone still exceeds
the budget, the error is `budget_exceeded`. Later Turns on that Branch fail the same way
until the budget or compaction options change or the user branches to an earlier Entry.
The RPC 1 MiB frame limit still applies to Snapshots that carry it. `--skills` removes the
Tool unless it names `delegation`.

### Reasoning and Tool selection

`--effort <level>` controls Provider reasoning. The accepted words are
`off`, `low`, `medium-low`, `medium`, `medium-high`, `high`, and `xhigh`.
The Kernel maps each CLI word onto a Kernel thinking level; the table below
shows the wire word sent to models pi-ai does not know when they are reached
through `--base-url`. Models pi-ai does not know, reached through --base-url,
use the wire mapping in this table. For models pi-ai does not know, the field
is always top-level reasoning_effort, whatever the endpoint.

| CLI effort | Kernel thinking level | Wire `reasoning_effort` |
| --- | --- | --- |
| unset | no effective level | absent field |
| off | off | none |
| low | minimal | minimal |
| medium-low | low | low |
| medium | medium | medium |
| medium-high | high | high |
| high | xhigh | xhigh |
| xhigh | max | xhigh |

Print, JSON, and HCN Heads share the same `--effort` surface:

```sh
popeye -p --effort off --exclude-tools manage-goal "Reply with one short sentence."
```

`max` saturates to `xhigh` on the wire because the demonstrated endpoint rejects
`max` and accepts `xhigh`; the same word is sent for both `high` and `xhigh`.
Reasoning levels are endpoint hints, not timing guarantees: the model and the
endpoint decide the actual cost. With no explicit Turn level, saved Session
level, or Provider layer default, models pi-ai does not know send no
`reasoning_effort` field. RPC uses set-thinking with Kernel levels; off sends
reasoning_effort none to those models. Registry reasoning models keep
pi-ai's model-specific mapping, so off is not guaranteed to disable their
reasoning.

An explicit level, including off, for a registry model without reasoning
support ends the Turn with a Provider error (exit 1 in print, JSON, and
HCN). The diagnostic names the model and the missing capability. The forced
OpenAI field is deliberate even when URL detection would select an
endpoint-native thinking format. Endpoint rejection follows the existing
Provider error handling, with no fallback.

`--tools <names>` and `--exclude-tools <names>` filter the Tools the model
may call. Each name is a contributed Tool name; `native:<name>` is accepted.
`--isolation tool-free` loads first-party Plugins only and exposes no Tools.
`--skills <names>` is a Plugin-name allowlist, not a trust setting. RPC
clients use `set-thinking` with Kernel words, not CLI HCN words; `--effort`
remains refused in RPC mode.

RPC frames arrive in order: `create`, capture the returned Session ID,
`set-thinking` with that Session ID and `thinkingLevel: "off"`, await its
Snapshot acknowledgement, then `prompt`.

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
