# pop-eye

An Effect-based coding agent with an event-sourced core and a unified
plugin system. This glossary is the ubiquitous language; every plan
document, module comment, and type name uses these terms.

## Language

### The journal

**Session**:
One conversation tree with identity and lifecycle (create, branch, fork,
resume).
_Avoid_: chat, thread, conversation

**Journal**:
The append-only store holding a session's entries and records; nothing in
it is ever rewritten or deleted.
_Avoid_: log, event log, store, history

**Entry**:
A durable, authoritative item in the journal's conversation tree; the
only input to snapshots and context.
_Avoid_: event, message (a message is one kind of entry payload)

**Record**:
A durable operational item in the journal (operation intents, attempts,
tool starts) used for crash recovery and replay; never model-visible.
_Avoid_: audit log, op log

**Branch**:
A root-to-leaf path through a session's entry tree.
_Avoid_: fork (forking is the act that creates a new session from a
branch, not the branch itself)

**Leaf**:
The entry a session is currently positioned at; switching branches moves
the leaf, never rewrites the tree.
_Avoid_: head (reserved for protocol consumers), HEAD, cursor

**Compaction**:
An entry that summarizes an older span of its branch so context stays
within budget; the summarized entries remain in the journal.
_Avoid_: pruning, truncation, summarization (the act that produces it)

### Derived state

**Snapshot**:
The authoritative state of a session at a revision, derived by folding
the current branch's entries.
_Avoid_: state, view, projection

**Context**:
The model-visible message sequence derived from the current branch by a
pure fold under a token budget.
_Avoid_: prompt, message history, window

**Progress**:
An ephemeral hint streamed to heads while work happens (text deltas, tool
activity); rendered but never folded into a snapshot.
_Avoid_: event, delta, update, notification

### Execution

**Kernel**:
The policy-free engine that runs turns: it consumes a prompt against a
session, appends entries, and streams progress.
_Avoid_: agent loop, engine, runtime, harness

**Turn**:
One assistant response plus the tool executions it triggers.
_Avoid_: step, round, iteration

**Steering**:
A user message delivered into a running turn, taking effect at the next
safe point without aborting the turn.
_Avoid_: interrupt (aborting is a different act), injection

**Follow-up**:
A user message queued while a turn runs, delivered as the opening of the
next turn after the current one settles.
_Avoid_: queued prompt, pending message

**Provider**:
An LLM endpoint reachable through pi-ai; pop-eye consumes providers, it does
not implement them.
_Avoid_: model (a model is what a provider serves), backend, API

### Extension

**Plugin**:
The single unit of extension: a manifest plus contributions; the only way
behavior is added, including pop-eye's own built-in features.
_Avoid_: extension, skill, theme, template, package (each names a plugin
whose contributions happen to be of one kind)

**Contribution**:
A typed thing a plugin adds to a registry: a tool, command, hook,
instruction fragment, renderer, or theme.
_Avoid_: registration, export

**Hook**:
A contribution that intervenes at a named point in kernel flow, with its
merge semantics and failure policy declared as part of its type.
_Avoid_: handler, listener, middleware, interceptor

**Capability**:
A declared power a plugin or tool requires (shell, filesystem write,
network); granted per session, and required before the needing code can
run.
_Avoid_: permission, scope, entitlement

**Tool**:
A contribution the model may call during a turn; its schema, capability
requirements, and execution are one declaration.
_Avoid_: function, action

**Command**:
A contribution the user invokes directly (slash command); commands never
enter the model's tool list.
_Avoid_: slash command (informal alias), verb

**Trust**:
A per-project decision, made before any project-local plugin loads, about
whether that project's plugins load at all.
_Avoid_: permission, sandboxing (isolation is an OS concern, not trust)

### Presentation

**Head**:
Any consumer of the protocol that presents or drives the agent: TUI,
print mode, RPC client, SDK, tests.
_Avoid_: client, frontend, UI, mode

**Protocol**:
The wire contract between kernel and heads: commands in; snapshots and
progress out; plus kernel-initiated interaction requests (select, confirm,
input) that a head answers or times out.
_Avoid_: RPC (one head's transport), API

## Relationships

- A **Session** is stored in exactly one **Journal** and has exactly one
  **Leaf** at a time
- An **Entry** belongs to one **Session** and has one parent entry,
  forming the tree; a **Branch** is a root-to-leaf path through it
- A **Snapshot** and a **Context** are both pure folds of a **Branch**'s
  entries; **Progress** contributes to neither
- The **Kernel** appends **Entries** and **Records**, and streams
  **Progress**; it consumes **Providers** and executes **Tools**
- A **Turn** produces entries; **Steering** adds a user entry inside a
  running turn
- A **Plugin** declares **Capabilities** and provides **Contributions**;
  **Tools**, **Commands**, and **Hooks** are kinds of contribution
- A **Tool** may require **Capabilities**; an ungranted capability makes
  the tool unavailable, not silently permitted
- **Trust** gates which plugins load; **Capabilities** gate what loaded
  plugins can do
- A **Head** sends protocol commands and renders **Progress**, but trusts
  only **Snapshots**

```
journal (append-only)
├── entries    - conversation tree ──fold──> Snapshot (authoritative)
│                                  ──fold──> Context  (model-visible)
└── records    - operation journal ────────> crash recovery / replay

kernel ~~~~ Progress ~~~~> heads   (hints; rendered, never folded)
```

## Example dialogue

> **Dev:** "When the user hits escape and types during a turn, does that
> abort it?"
> **Domain expert:** "No - that's **steering**. The kernel appends the
> new user **entry** at the next safe point and the **turn** continues.
> Aborting is a separate command that interrupts the turn's fiber."
>
> **Dev:** "The TUI dropped a **progress** item during a redraw. Is the
> transcript now wrong?"
> **Domain expert:** "It can't be - progress is a hint. The TUI re-reads
> the **snapshot** at the next revision and is exactly correct again.
> Only **entries** are truth."
>
> **Dev:** "Is `/compact` a built-in?"
> **Domain expert:** "It's a **command** contributed by a **plugin** that
> ships with pop-eye. There are no built-ins that bypass the plugin API -
> that's the dogfood rule."

## Flagged ambiguities

- "event" was used for durable log items, kernel output, and UI hints -
  resolved: banned entirely; durable items are **Entries**, streamed
  hints are **Progress**. (pi-ai's `AssistantMessageEvent` keeps its
  name inside the ai seam; it never crosses into pop-eye vocabulary.)
- "head" collided between protocol consumers and the current tree
  position - resolved: **Head** is the consumer; the tree position is
  the **Leaf**.
- "extension"/"skill"/"theme"/"template"/"package" - resolved: all are
  **Plugins**; the old words describe what a plugin contributes, not
  what it is.
- "lane" (pi harness-v2's parallel-operations concept) is deliberately
  not in this vocabulary yet; if concurrent operations per session enter
  scope, the term gets defined then.
