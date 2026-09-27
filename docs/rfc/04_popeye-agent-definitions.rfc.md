---
number: 04
title: "Popeye Agent Definitions"
type: feature
status: Accepted
author: "kevin"
date: 2026-09-27
---

# RFC-04: Popeye Agent Definitions

## Abstract

Popeye cannot run as a named persona or delegate work to one: every session
starts from the same defaults, and the pi-format agent markdown files already
on this machine are unreadable by popeye. This RFC specifies Agent
definitions: pi-compatible markdown files held in popeye's own user and
project directories, a headless session starting as a named definition with
`--agent`, an `agent` field on the rpc `create` command, and Delegation: a
first-party `delegate` Tool that runs a child Agent session in-process and
returns its final message. Every design decision was settled on the
wayfinder map (issues 44-51); this RFC renders those decisions and decides
nothing new.

## Introduction

Two consumption paths, one format. A head (print, json, hcn) starts a
session as a named Agent definition through the `--agent` flag; an rpc
client names the definition per `create` on the wire; a running session
hands a task to a child Agent session through the `delegate` Tool.

Scope boundaries, with the reason each excluded item stays out:

- Rich head rendering of delegated child progress: child Progress rides the
  existing event fabric, so rendering is a head feature, not architecture.
  No shipped head needs more than tool activity plus the returned result.
  Revisit when a TUI ships.
- An agent marketplace or registry: no user; upkeep outruns use. Markdown
  files move through git or dotfile syncing.
- Reading pi's own directories (`~/.pi/agents`, `.pi/agents`): popeye keeps
  its own directories; `POPEYE_AGENTS_DIR` points at any other location.
- Journaling agent identity with the session: `--agent` is a startup input
  exactly like `--system-prompt`; resume requires re-passing the flag.
- Interactive agent switching inside a live TUI session: no TUI ships.

Motivation: the owner runs multiple harnesses and already maintains pi
agent files; popeye cannot consume them, and pi's format is the local
lingua franca for agent personas. Popeye's kernel, journal, and grant
machinery already carry most of what Delegation needs (research recorded on
issues 45 and 46); the missing pieces are a loader, a flag, per-session
grant variation, one protocol field, and one Tool.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD
NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted
as described in RFC 2119.

Terms follow the glossary in `CONTEXT.md`:

- **Agent definition**: a markdown artifact, frontmatter plus body, that a
  Session can run as.
- **Agent session**: a Session that runs as an Agent definition, whether a
  head starts it or Delegation creates it.
- **Delegation**: the act of a running session handing a task to a child
  Agent session and receiving its result.
- **delegate**: the first-party Tool contribution that performs Delegation.
- **User scope**: `~/.popeye/agents`, overridable by `POPEYE_AGENTS_DIR`.
- **Project scope**: `.popeye/agents` at the project root.

## Motivation

The format decision (issue 48) anchors on pi's de-facto contract: four
frontmatter keys plus body, owned by pi's `examples/extensions/subagent`
sample, whose code is the spec (there is no schema and no validator
upstream). Popeye parses that format unchanged so existing files work, and
diverges only on error paths where pi's behavior is a known defect.

The execution decision (issue 51) anchors on native progress streaming:
child Progress flows through the same event fabric as every other session
event, so any head can render delegated work without new plumbing.

## Design

### 1. Agent definition format

A definition file is UTF-8 markdown: an optional YAML frontmatter block
delimited by `---` lines, then a body.

Frontmatter keys, exactly pi's four:

| Key | Type | Required | Default when absent |
| --- | --- | --- | --- |
| `name` | string | Yes | (file rejected) |
| `description` | string | Yes | (file rejected) |
| `tools` | comma-separated string or YAML string array | No | full granted set |
| `tools`-list normalization | trim items; drop empties and non-strings; empty result = no restriction | - | - |
| `model` | string, opaque | No | inherit remaining sources |

Unknown frontmatter keys MUST be ignored. The parser MUST NOT validate tool
names or model identifiers at parse time. The body is trimmed markdown; an
empty body appends nothing.

Discovery: both scopes are flat, non-recursive collections of `*.md` files
(regular files and symlinks). User scope reads `POPEYE_AGENTS_DIR` when
set, else `~/.popeye/agents`. Project scope reads `.popeye/agents` at the
project root only; popeye MUST NOT walk ancestor directories. On a
cross-scope name collision, project wins (pi's both-scope shadowing). A
duplicate name within one scope MUST be a load error naming both files.

### 2. Persona seam

The definition body rides the existing `--append-system-prompt` turn-option
machinery: the body appends to the system prompt, never replaces it, and
never enters the fold budget (the pre-existing posture of flag-supplied
system content). No InstructionFragment consumer is built; the
`instruction-fragment` contribution kind stays unconsumed.

### 3. `--agent` flag

The print, json, and hcn heads accept `--agent <name>`. Resolution is an
exact, case-sensitive match over the merged project-then-user set. An
unknown or invalid name MUST fail startup with a config error in the shape
of `missing_model`, listing available agent names.

Model precedence: `--model` flag > agent file `model` > `POPEYE_MODEL`
env. The agent's model seeds the process provider configuration.

Tool constraints: the agent's tools list composes into the existing
process-level name filter (`ToolGrantFilter`) by intersection. Agent list
with `--tools` intersects; `--exclude-tools` subtracts; `--access read`
intersects with the read preset. No input can widen the result. Unknown
tool names in the file produce a startup diagnostic naming each; the
session runs with the known subset.

Rpc mode refuses the flag, matching `--system-prompt`.

### 4. rpc `agent` field

The rpc `create` command gains an OPTIONAL `agent` string field. When
present, the created session resolves the definition the same way `--agent`
does (including model precedence and tool filter composition), applied per
session. Unknown name fails the create.

### 5. Per-session grant variation

Tool grants MUST vary per session within one process: a session created
with an agent carries that agent's composed tool filter; sessions without
an agent keep the existing process-level filter. This is the prerequisite
both for rpc-created agent sessions and for Delegation, and it removes the
current invariant that `view(sessionId)` computes the same union and filter
for every session.

### 6. `delegate` Tool

A first-party Tool contribution named `delegate`, registered only when at
least one Agent definition is discoverable in either scope.

Parameters: `agent` (string), `task` (string), `cwd` (OPTIONAL string).

Behavior:

1. Resolve `agent` at call time (fresh discovery; edits apply to future
   delegations). Unknown name returns a failed tool result listing
   available agents, matching the `--agent` error contract.
2. Fork a child session from the current session (`driver.fork`), journaled
   in the parent's `--session-dir`: visible, resumable, auditable.
3. Apply the agent's persona (as append-system-prompt content), model
   preference, and per-session tool filter to the child.
4. Prompt the child with `Task: <task>` through the driver, in-process.
5. Return the child's final assistant message as full-text tool result
   content. No truncation in v1.

Concurrency: parallel delegation is multiple `delegate` calls in one tool
batch, bounded by the existing batch limit; no new concurrency knob.
Chaining is the model issuing the next call with the prior result. On
parent abort or turn interruption, the child turn is aborted through the
per-tool Scope cleanup; the journaled child session keeps whatever it
completed.

### 7. Agent identity is not journaled

No new journal entry kind. Persona and model are startup or creation
inputs; a resumed agent session requires the flag or field again.

## State Machine

```
discovered -> resolved (on: exact name match)
resolved   -> running  (on: persona+model+filter applied to a session)
running    -> done     (on: child final message, normal case)
running    -> aborted  (on: parent abort or turn interruption; Scope cleanup)
```

An invalid file never enters `discovered` (skipped with a diagnostic); a
file missing `name` or `description` never enters `discovered` (skipped,
matching pi).

## Error Handling

- `E-Agent-Load-Invalid` (warning): a definition file with invalid YAML or
  a rejected shape is skipped with a diagnostic naming the file. Discovery
  continues. (Deliberate divergence: pi fails every lookup on one bad
  file.)
- `E-Agent-DuplicateName` (error): two files in one scope declare the same
  name; the load fails naming both files.
- `E-Agent-Unknown` (error): `--agent` names no discovered definition;
  startup fails listing available names. The rpc `create` and the
  `delegate` Tool carry the same contract.
- `E-Agent-UnknownTools` (warning): the resolved file names tools absent
  from the granted set; a diagnostic names each; the session runs with the
  known subset.
- `E-Agent-ModelUnresolvable` (error): the agent's opaque model string
  fails provider resolution; fails in the shape of the existing
  unknown-model startup error.

## Security Considerations

Trust boundaries: Agent definitions are data files loaded by first-party
code. They MUST NOT pass through the plugin trust pipeline: no digest, no
trust hook, no ESM import. The existing trust model gates project-local
code execution; markdown persona text is not executed code.

Prompt-content risk: a project-scope definition is repo-controlled text
that enters the model's context. This is the same risk class as plugin
prompt content and carries the same posture: documented, not scanned. A
project you run agents from is a project whose instructions you accept.
Revisit if an interactive head ships (pi's prompt-when-UI precedent).

Blast radius: a definition constrains a session (persona, model
preference, tool filter); it grants nothing. The tool filter only narrows
(intersection), so a definition cannot widen a session's powers. The
`model` value is opaque until provider resolution, which fails closed.

Data sensitivity: definitions carry no credentials by design; they are
plain markdown, and `POPEYE_AGENTS_DIR` can point anywhere on disk, so
users MUST treat that directory's contents as prompt-visible.

## Alternatives Considered

- Build the InstructionFragment consumer (rejected on issue 48): new kernel
  code; the kind's `trigger: "explicit"` semantics were deferred by design;
  fragment content would ride outside the fold budget either way. The
  append-system-prompt seam exists and is exactly how pi passes personas.
- Persona via a context hook per agent (rejected on issue 48): routes data
  through a code plugin per agent; the naming decision ruled a definition
  is not a Plugin.
- Byte-for-byte pi parser behavior (rejected on issue 48): would import two
  known defects (one invalid file bricking discovery; filesystem-order
  duplicate resolution) as popeye's own contract.
- Ancestor walk for project scope (rejected on issue 48): pi walks to the
  filesystem root, which pulls the user's home agents into every project;
  popeye's plugin convention is fixed directories.
- Extend the trust digest to project agent files (rejected on issue 48):
  wires data into a pipeline built for code while user-scope files ride
  un-gated anyway.
- Map agent tools to Capabilities (rejected on issue 50): pi names tools,
  not capabilities; capabilities are plugin-declared powers, not external
  restrictions.
- Flags replace the agent tool list (rejected on issue 50): a typed flag
  could silently widen an agent's restriction.
- Child process per delegation (rejected on issue 51): pi parity and OS
  isolation, but child Progress would never stream natively, per-session
  grants would still be needed eventually, and every delegation pays a
  process spawn.
- Ephemeral children like pi's `--no-session` (rejected on issue 51):
  discards the audit trail and fights the fork primitive, whose default is
  a journaled session.
- Journal agent identity (rejected on issue 49): kernel schema and snapshot
  surface for a benefit only resume feels, and resume can re-pass the flag.

## Implementation Plan

Five vertical slices, each demoable, sized to one context window; tickets
carry the full criteria. Rollback at every phase is deleting the added
surface; nothing migrates.

1. Loader plus `--agent` persona sessions: format, directories, precedence,
   error paths, body through append-system-prompt, model precedence,
   hard-error resolution. Verify: pi fixture files from this machine parse
   and run unchanged; error contracts hold.
2. Agent tool constraints: filter composition, intersection, unknown-tool
   diagnostic. Verify: an agent with a tools list sees exactly the
   intersection; flags never widen.
3. Per-session grant variation: per-session filters in one process. Verify:
   two sessions in one process hold different tool views.
4. rpc `agent` field: protocol schema, bridge resolution. Verify: create
   with and without the field over the wire.
5. `delegate` Tool: registration, fork, child persona and filter, result,
   scope-abort. Verify: a parent session delegates and receives the final
   message; interruption leaves a coherent journaled child.

## Open Questions

None. Every decision was settled on map issues 45-51; reversals recorded
there (the rpc field moving in scope) are reflected above.

## References

Normative:

- [Wayfinder map: Popeye custom agents](https://github.com/dungle-scrubs/popeye/issues/44) and its closed tickets 45-51 - the decision record this RFC renders.
- `CONTEXT.md` - Agents cluster (Agent definition, Agent session, Delegation).
- [RFC-02: Popeye HCN Route](./02_popeye-hcn-route.rfc.md) - the rpc head as HCN's live-session carrier.

Informative:

- [pi subagent example: agents.ts](https://github.com/earendil-works/pi/blob/2b0a123de983/packages/coding-agent/examples/extensions/subagent/agents.ts) - the format's owning implementation.
- [pi subagent example: README](https://github.com/earendil-works/pi/blob/2b0a123de983/packages/coding-agent/examples/extensions/subagent/README.md) - the format's only documentation.
