# Plugin authoring

A Plugin is the only unit of behavior addition in popeye. It returns a Schema-validated manifest and
an array of Contributions. The shipped compact, goal, reload, and Session-name features use this
public interface.
Read their source at
[`packages/cli/src/features`](../packages/cli/src/features) beside this guide.

## Current host boundary

`@dungle-scrubs/popeye-plugins` publishes the manifest, registry, Hook emitter, Trust, discovery,
loading, and generation APIs. The CLI package `@dungle-scrubs/popeye` ships the `popeye` executable
and exports its Head functions. The executable composes the first-party `compact`, `goal`, `reload`,
and `session-name` Plugins, then discovers and loads Plugins from the user-global directory,
`--plugin` paths, and the project's `.popeye/plugins/`. An application that embeds the Plugin APIs
in its own host must wire `makeGenerationRuntime` itself.
When at least one Agent definition is discoverable, it also composes the first-party
`delegation` Plugin, whose `delegate` Tool runs a child Agent session through the in-process
Driver. That Tool reaches the Driver through a CLI-internal port, not through the public
Plugin interface, so Plugin authors cannot build the same Tool from the Plugin API alone.

The headless host ships no filesystem or shell coding Tools. The only Tool that the default Plugins
contribute is `manage-goal`. To give the model coding Tools, load a Plugin such as the
[minimal local coding Plugin](#minimal-local-coding-plugin).

npm-referenced Plugin packages are not in v1. The loader imports local TypeScript or JavaScript files
by absolute path. Project discovery reads `.popeye/plugins/`. User-global directories and explicit
CLI paths come from the host's `PluginDiscoveryConfig`.

## Minimal Plugin

A module must export a factory as either `plugin` or `default`. The factory can return its value or
a Promise.

```typescript
import { defineCommandContribution } from "@dungle-scrubs/popeye-plugins";
import type { PluginManifest } from "@dungle-scrubs/popeye-plugins";
import { Effect, Schema } from "effect";

const manifest = {
  capabilities: [],
  description: "Reports the current Session identity.",
  name: "session-info",
  version: "1.0.0",
} satisfies PluginManifest;

export const plugin = () => ({
  contributions: [
    defineCommandContribution({
      arguments: Schema.Struct({}),
      description: "Return the current Session id.",
      execute: (_input, context) => Effect.succeed({ sessionId: context.sessionId }),
      name: "session-info",
    }),
  ],
  manifest,
});
```

Import from package roots. Do not import `@dungle-scrubs/popeye-plugins/src/*` or another package's
source files.

Node resolves a Plugin's imports from the Plugin file's location upward, so
`@dungle-scrubs/popeye-plugins` and `effect` must be in a `node_modules` directory at or above the
Plugin file. The registry packages do not install yet (see the README Install section). Until they
do, keep your Plugin files in a checkout of this repository, below `packages/cli/`, where
`pnpm install` links both packages, and load them with `--plugin <path>`. Git ignores every
`.popeye/` directory, so `packages/cli/.popeye/local-plugins/` keeps them out of commits.

## Minimal local coding Plugin

The headless host ships no filesystem or shell coding Tools. This Plugin adds three: `read-file`,
`write-file`, and `run-command`. The Tools use the working directory of the `popeye` process as the
workspace.

To run it from a checkout of this repository:

1. In the checkout, run `pnpm install` and `pnpm build`.
2. Save the Plugin below as `packages/cli/.popeye/local-plugins/local-coding.ts` in the checkout.
3. Go to the directory that the model works in, and run the built executable with the Plugin:

```sh
popeye_checkout="$HOME/src/popeye" # the path of your checkout
node "$popeye_checkout/packages/cli/dist/bin/popeye.js" \
  --plugin "$popeye_checkout/packages/cli/.popeye/local-plugins/local-coding.ts" \
  -p "Write notes/hello.txt with the text hello, then run cat notes/hello.txt."
```

The Session Journal goes to `.popeye/sessions` in that directory unless you pass `--session-dir`.

```typescript
import { exec } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { defineToolContribution } from "@dungle-scrubs/popeye-plugins";
import type { PluginManifest, ToolExecutionResult } from "@dungle-scrubs/popeye-plugins";
import { Data, Effect, Schema } from "effect";

const workspace = process.cwd();
const execShell = promisify(exec);

// A failure that the model reads as an error result. It does not fail the Turn.
class ToolFailure extends Data.TaggedError("ToolFailure")<{ readonly message: string }> {}

// Runs a Node promise. Interrupting the Tool call aborts `signal`.
const attempt = <A>(work: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, ToolFailure> =>
  Effect.tryPromise({
    catch: (cause) =>
      new ToolFailure({ message: cause instanceof Error ? cause.message : String(cause) }),
    try: work,
  });

// Resolves a model-supplied path and refuses a path that leaves the workspace.
const workspacePath = (path: string): Effect.Effect<string, ToolFailure> => {
  const target = resolve(workspace, path);
  const fromWorkspace = relative(workspace, target);
  return fromWorkspace === ".." || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace)
    ? Effect.fail(new ToolFailure({ message: `${path} is outside the workspace ${workspace}.` }))
    : Effect.succeed(target);
};

const toolResult = (work: Effect.Effect<string, ToolFailure>): Effect.Effect<ToolExecutionResult> =>
  work.pipe(
    Effect.map((content) => ({ content })),
    Effect.catchTag("ToolFailure", ({ message }) =>
      Effect.succeed({ content: message, isError: true }),
    ),
  );

const manifest = {
  capabilities: [],
  description: "Reads and writes workspace files and runs shell commands.",
  name: "local-coding",
  version: "1.0.0",
} satisfies PluginManifest;

export default () => ({
  contributions: [
    defineToolContribution({
      description: "Read a UTF-8 text file inside the workspace.",
      execute: ({ path }) =>
        toolResult(
          workspacePath(path).pipe(
            Effect.flatMap((target) =>
              attempt((signal) => readFile(target, { encoding: "utf8", signal })),
            ),
          ),
        ),
      name: "read-file",
      parameters: Schema.Struct({ path: Schema.String }),
      replay: "safe",
    }),
    defineToolContribution({
      description: "Write UTF-8 text to a file inside the workspace. Creates parent directories.",
      execute: ({ content, path }) =>
        toolResult(
          Effect.gen(function* () {
            const target = yield* workspacePath(path);
            yield* attempt(() => mkdir(dirname(target), { recursive: true }));
            yield* attempt((signal) => writeFile(target, content, { encoding: "utf8", signal }));
            return `Wrote ${content.length} characters to ${path}.`;
          }),
        ),
      executionMode: "sequential",
      name: "write-file",
      parameters: Schema.Struct({ content: Schema.String, path: Schema.String }),
    }),
    defineToolContribution({
      description: "Run a shell command in the workspace. Returns stdout followed by stderr.",
      execute: ({ command }) =>
        toolResult(
          attempt((signal) => execShell(command, { cwd: workspace, signal, timeout: 60_000 })).pipe(
            Effect.map(({ stderr, stdout }) => `${stdout}${stderr}`),
          ),
        ),
      executionMode: "sequential",
      name: "run-command",
      parameters: Schema.Struct({ command: Schema.String }),
    }),
  ],
  manifest,
});
```

`read-file` and `write-file` refuse a path that resolves outside the workspace. That check is
lexical, not a sandbox: a symlink inside the workspace can still point outside it. `run-command`
runs any shell command with the authority of the popeye process. Load this Plugin only in a
workspace you trust. Over RPC, the opt-in `tool-vetting` gate can ask the client to confirm each
call.

Each failure returns `{ content: <message>, isError: true }` to the model and does not fail the
Turn: a path outside the workspace, a failed read or write, and a command that exits nonzero, runs
longer than 60 seconds, or writes more than 1 MiB to stdout or to stderr (the Node `exec` default
`maxBuffer`). When the Kernel interrupts a Tool call, for example on an RPC `abort`, the
Plugin aborts the pending read or write and sends `SIGTERM` to the shell that runs the command.

## Manifest Schema

The manifest has 4 fields:

- `name`: required kebab-case Plugin name, from 1 through 64 characters.
- `version`: required semantic version.
- `capabilities`: required array of `{ name, required? }` declarations. Names must be non-empty,
  trimmed, and unique.
- `description`: optional text.

Unknown fields fail decoding. Invalid input becomes a `PluginLoadError` with cause
`manifest_invalid`.

Contribution names also use kebab-case and have the same 64-character limit. The registry builds
the key as `plugin-name/contribution-name`. A Plugin re-registration replaces the prior Plugin
atomically. A duplicate key selects the higher declared priority. Equal priorities fail the whole
registration. The registry emits a conflict diagnostic when it selects one.

## The 4 v1 Contribution kinds

### Tools

Use `defineToolContribution`. A Tool declares its name, description, argument Schema, Effect
execution, and optional policy fields in one value.

- `parameters` validates model-supplied arguments.
- `requiredCapabilities` adds Capability requirements for this Tool.
- `executionMode` is `"parallel"` by default or `"sequential"`.
- `replay` is `"never"` by default or `"safe"` when crash recovery can repeat the Tool.
- `execute` returns `{ content, isError? }` or fails with `ToolContributionError`.

The registry omits a Tool from the model-visible list when its required Capabilities are not
granted for that Session.

A host can also narrow one Session's Tools by name (an RPC Agent session does this). That Session
is offered only the Tools that both the process-level grant and its own filters allow, and a
call to any other Tool returns `Unknown tool: <name>.` Narrowing never changes Capability
grants. A Plugin reload during a Turn does not change which names the Turn may call. A call that starts after the swap runs the Tool as the reloaded Plugins provide it; a call already running finishes on the generation it started on.

### Commands

Use `defineCommandContribution`. A Command is invoked by the user through
`Driver.invokeCommand`. It never enters the model's Tool list. The host validates `arguments`
before it runs `execute`.

The current `CommandExecutionContext` contains:

- `sessionId` for the active Session;
- `compactNow(expectedRevision?)` for the public Compaction operation;
- `getGoal()` to read the current Branch's Goal;
- `changeGoal(action)` to append a validated Goal change;
- `setSessionName(name, expectedRevision?)` for a non-model-visible Session-name Entry.

The first-party compact and Session-name Plugins use only these operations. A Command must not
write directly to a Journal.

### Hooks

Use `defineHookContribution`. The declaration names a Hook point and repeats that point's merge
class. Registration fails if the merge class does not match the point definition. Hook input and
output pass through the point's exported Effect Schema.

All built-in points use a 30-second timeout:

| Hook point | Merge | Failure | Input and result |
| --- | --- | --- | --- |
| `context` | `Chain` | skip | messages and token budget to revised messages and budget |
| `provider-request` | `Chain` | skip | messages, model, and options to a revised request |
| `input-transform` | `Chain` | skip | input text to revised text |
| `input-handling` | `FirstWins` | skip | input text to continue or handled result |
| `tool-call-gate` | `FirstWins` | reject | Tool call to continue, block, or replacement |
| `tool-result` | `Accumulate` | skip | Tool result to partial field updates |
| `resource-discovery` | `Accumulate` | skip | query to resources and metadata |
| `compaction-gate` | `FirstWins` | reject | reason and token count to compact or skip |
| `trust` | `FirstWins` | reject | Trust request to continue, block, or replacement |
| `turn-lifecycle` | `Tap` | drop | Turn phase and Session id |
| `progress` | `Tap` | drop | completed count, total count, and message |
| `session-lifecycle` | `Tap` | drop | created, resumed, or closed Session |

The emitter orders Hooks by descending priority, then namespaced key. Merge behavior is fixed:

- `Chain` sends each successful output to the next Hook. A failed Hook keeps the current value.
- `FirstWins` stops at the first claim or rejection. A continue result tries the next Hook.
- `Accumulate` runs each Hook on the original input and merges top-level fields. The highest-priority
  writer owns a field. Lower-priority conflicts emit a diagnostic.
- `Tap` queues observer work on a separate fiber. Each Hook has a bounded queue of 64 items. A full
  queue drops the oldest item and emits a count diagnostic.

`skip` failures fail open and emit `hook_contribution_skipped`. `reject` failures fail closed with a
typed `GateRejected`. `drop` failures do not affect the caller and emit a Tap diagnostic. A timeout
uses the same policy as any other failure.

While a Hook runs, `CurrentGrantsFiberRef` (exported from `@dungle-scrubs/popeye-plugins`)
contains `Some(grants)` for that emit; its value type is `Option<CapabilityGrants>`. At
`tool-call-gate`, when the Tool call supplies a Session id, the grants carry that id, matching
the gate input's `sessionId`. Without a Session id, the gate keeps the adaptation grants. The
Capabilities remain those of the adaptation grants.

### Live callers

A declared Hook point runs only when some code in this repository emits it. A Hook contributed to
a point with no caller never runs.

| Hook point | Live callers |
| --- | --- |
| `context` | none |
| `provider-request` | none |
| `input-transform` | none |
| `input-handling` | none |
| `tool-call-gate` | [`tool-invocation-pipeline.ts`](../packages/cli/src/tools/tool-invocation-pipeline.ts), before each Tool call |
| `tool-result` | none |
| `resource-discovery` | none |
| `compaction-gate` | [`compose.ts`](../packages/cli/src/compose.ts), for manual and overflow Compaction, on the generation current when the gate runs |
| `trust` | [`trust.ts`](../packages/plugins/src/trust.ts), when an external Plugin loads |
| `turn-lifecycle` | none: diagnostic only |
| `progress` | none: diagnostic only |
| `session-lifecycle` | Kernel callers: end of `create` and end of `resume` in [`sessions.ts`](../packages/kernel/src/sessions.ts), end of `closeSession` in [`driver.ts`](../packages/kernel/src/driver.ts); plus a Head's normal exit (see below) |

`session-lifecycle` reaches Plugins through
[`currentGenerationLifecycleTap`](../packages/cli/src/compose.ts) in the shipped CLI, which emits
on the generation current at each emit, or through
[`generationLifecycleTap`](../packages/cli/src/compose.ts) in a host bound to one fixed
generation. The Kernel receives it as a function
(`DriverDefaultOptions.lifecycle`) and never imports the Plugin package. `created` is emitted
after the Journal Session exists and its Mailbox is active. `resumed` is emitted after recovery
succeeds; a failed resume emits nothing. `closed` is emitted after the close settles and its
Snapshot is read. Fork emits `created` for the new Session. Branch and Session-name changes emit
nothing.

### Diagnostic versus durable signals

Every `Tap` point is **diagnostic**. Each Hook has a bounded queue of 64 items. A full queue drops
the oldest item and emits `hook_tap_dropped`. A Plugin that observes `turn-lifecycle`, `progress`,
or `session-lifecycle` sees a hint, not a record. Never build a guarantee on a Tap.

The **durable** Session lifecycle signal is the reflection send
([ADR-0002](adr/0002-reflection-producer.md)). It is on only when `POPEYE_REFLECT_INTAKE` names an
executable file. It reports from the same seams as `session-lifecycle`, but it does not ride the
Tap. The Kernel spawns `<POPEYE_REFLECT_INTAKE> hook popeye <event>` directly and writes one start
record per activation. The next Popeye process on the same Session directory reconciles a start
record whose process died without a close. The send is best effort. A gap shows at the intake as
a revision without a clean end (RI-301), never as a clean close.

Close contract:

- `closeSession` (the RPC `close` command) reports `closed` with its drain fact.
- The print, json, and hcn Heads report a clean close when their Session loop returns normally.
  They never call `closeSession`.
- The RPC Head reports a clean close for every Session still open when its input ends normally.
- A Session gets at most one close report per activation.

Paths that end a Session with no close report. The next sweep reports each one as killed:

- a failed or defective Session loop in the print, json, or hcn Head;
- RPC input that ends with an oversized frame, and an RPC writer failure;
- a crash or SIGKILL of the Popeye process;
- a program that composes `DriverDefault` without a Head, and never calls `closeSession`.

A run with `POPEYE_REFLECT_INTAKE` unset is an uncovered path: nothing is sent and no start record
is written.

### Typed gate decisions

The Tool-call gate and Trust gate return one of these values:

```typescript
type GateDecision<TValue> =
  | { readonly decision: "continue" }
  | { readonly decision: "block"; readonly reason: string }
  | { readonly decision: "replace"; readonly value: TValue };
```

The input-handling point returns `continue` or `{ decision: "handled", value }`. The Compaction gate
uses `{ action: "compact" }` or `{ action: "skip", reason }`. The first-party compact Plugin uses
the Compaction gate for manual and overflow-triggered Compaction. A skip vetoes the operation. v1
does not support replacing a Compaction summary or instruction.

### Instruction fragments

Use `defineInstructionFragmentContribution`. A fragment declares `id`, `content`, and
`trigger: "explicit"`. The registry stores and capability-filters it. Model-requestable fragments
are deferred. The v1 first-party CLI host does not add an automatic fragment selection path.

## Capability grants and Trust

Capability grants belong to one Session. The registry combines manifest-wide requirements with a
Contribution's own requirements. It omits unavailable Contributions and emits one
`contribution_unavailable` diagnostic for each grant-set and key.

In the current implementation, `required: true` applies that manifest Capability to every
Contribution. A missing grant does not stop the TypeScript module factory from running. It makes
the Contributions unavailable at registry lookup. Treat this as declaration and visibility, not
process isolation.

Trust decides if project-local code runs. Loading has 2 phases:

1. Load user-global and out-of-project explicit paths.
2. Ask for Trust, bind the answer to a digest of project Plugin files, then load project-local code
   only when the digest is trusted.

An explicit path that resolves inside the project is project-local and cannot answer its own Trust
request. A content change requires a new Trust decision. Trusted Plugin code still runs with the
host process's authority. Use an OS or container boundary when isolation is required.

## Opt-in gate Plugins

Two gates ship as linkable modules and never load by default. Their sources are in
`packages/cli/src/features/`, and `pnpm build` writes the loadable modules to
`packages/cli/dist/features/`:

- `trust-gate.ts` - contributes to the `trust` Hook. It raises a confirm interaction (project path, digest, change summary) with a 25s timeout and fallback `untrusted`. With the null `PluginInteractions` layer (print/json heads and startup composition in every mode) the fallback resolves immediately: unknown project code is denied without stalling. Over rpc with an interactive Head, the Head answers; `trusted` loads stage-2 project plugins, fallback `untrusted` swaps without them and the `/reload` result lists the project Plugins that left in `pluginsRemoved`.
- `tool-vetting.ts` - contributes to `tool-call-gate`. It raises a select (`allow once` / `allow for session` / `reject`) with a 25s timeout and fallback `reject`. Session memory is keyed by the generation whose gate answered: a reload starts with no allows, and an answer given to the previous generation's gate after the reload never authorizes the new generation's calls (fail-closed). A rejection becomes a model-visible error `ToolResult` with `isError: true` in the call's journal position, preserving call order.

Install them by symlinking the built modules into a user-global Plugin directory (the host's `userPluginDir`, by default `~/.popeye/plugins/`). Run `pnpm build` first:

```bash
mkdir -p ~/.popeye/plugins
ln -s "$PWD/packages/cli/dist/features/tool-vetting.js" ~/.popeye/plugins/tool-vetting.js
ln -s "$PWD/packages/cli/dist/features/trust-gate.js" ~/.popeye/plugins/trust-gate.js
```

Link the built `.js` modules, not the `src/features/*.ts` sources: `tool-vetting.ts` imports a
sibling module by its `.js` name, which Node type stripping cannot resolve. Do not copy the modules:
a copy cannot resolve `@dungle-scrubs/popeye-plugins`, `effect`, or its sibling modules.

The default first-party set is `compact`, `goal`, `reload`, and `session-name`; the gates load only when the user places them in the Plugin source directory. Remove the symlink to uninstall.

## PluginInteractions author guidance

`PluginInteractions` lets Plugin code ask the user. The emitter stamps the originating Plugin name via `CurrentPluginFiberRef` around every Hook and Command execution, so you do not supply `pluginName` yourself; Heads receive it for attribution and a malicious Plugin cannot impersonate another. Declare the `interaction` Capability in the manifest; without it the request resolves its declared fallback with an `interaction_ungranted` diagnostic and never reaches a Head.

```typescript
import { PluginInteractions, DEFAULT_INTERACTION_TIMEOUT_MILLIS } from "@dungle-scrubs/popeye-plugins";
import { Effect } from "effect";

const run = Effect.gen(function* () {
  const interactions = yield* PluginInteractions;
  const resolution = yield* interactions.request({
    fallback: { kind: "select", value: "reject" },
    id: `my-plugin-${Date.now()}`,
    kind: "select",
    options: [
      { label: "Allow once", value: "allow-once" },
      { label: "Allow for session", value: "allow-for-session" },
      { label: "Reject", value: "reject" },
    ],
    prompt: "Allow tool X?",
    timeoutMs: DEFAULT_INTERACTION_TIMEOUT_MILLIS, // 25s, nests inside the 30s hook timeout
    // sessionId: context.sessionId when you have one (tool-call-gate); omit for trust
  });
  const choice = resolution.response.value; // typed by kind
  const source = resolution.source; // "head" or "fallback"
});
```

Timeout layering: gate Plugins default to 25s, which nests inside the emitter's 30s Hook timeout, so the interaction fallback - not the Hook timeout - decides the outcome. The rpc live Layer delivers pending requests on attach, times out to the fallback, and removes pending entries on interruption (id reusable, no stale delivery). The null Layer (print/json and startup composition) resolves fallbacks immediately. Always provide a safe fallback: `reject` for vetting, `untrusted` (`false`) for trust. Check `resolution.error` (`InteractionTimeout`) when you need to distinguish a fallback from a Head answer. Every allow/deny should log with plugin attribution (the vetting and trust gates already do).

## Supported TypeScript syntax

The loader uses Node 24 native TypeScript stripping through an absolute `file:` URL. Type
annotations, `import type`, generics, host-package imports, and relative sibling imports work.

Do not use TypeScript `enum` or `namespace` declarations in a Plugin. Node reports them as
unsupported transform syntax. The loader converts that error to `PluginLoadError` and names the
file and construct. Use `as const` objects, string literal unions, and ordinary modules instead.

## Reload and generation drain

The first-party `reload` Plugin contributes the `/reload` Command. Send it as a print or json
prompt (`/reload`) or as an rpc `invoke-command` frame with `name: "reload"` and `args: {}`. It
rebuilds the Plugin generation from the discovery inputs the process started with, so it picks
up added, removed, and edited Plugin entry files.

Each generation owns an Effect `Scope`. Reload builds a fresh generation and adapts its Tools
before it changes routing. If either step fails, the current generation stays active, the fresh
generation closes, and `/reload` fails. A successful build then:

1. swaps the current generation reference, and with it the Tools that Tool calls resolve, in one step;
2. routes new generation checkouts to the fresh generation;
3. lets leased in-flight work finish on its captured generation;
4. waits at a drain barrier for those leases, for at most 5 seconds;
5. closes the old `Scope` and runs its finalizers once;
6. emits a generation-swap diagnostic with IDs, Plugin changes, drain time, and closed resources.

`/reload` returns that diagnostic: `{ type: "generation_swap", oldGenerationId,
newGenerationId, pluginsAdded, pluginsRemoved, pluginsReplaced, drainDurationMillis,
leaseCount, closedResources }`. The Plugin lists hold sorted manifest names; `pluginsReplaced`
names every Plugin present in both generations, changed or not. The print Head writes the
diagnostic as one JSON line, rpc returns it as the `commandInvoked` value, and the json Head
writes the Session's Snapshot, whose `loadedGeneration` names the new generation.

The runtime serializes reload operations. A `/reload` while another reload is running fails with
`Reload is already in progress.` (over rpc: `invoke_command_error`, reason `command_failed`).
Hosts use `useSerialized` for gates that must not interleave with a reload.

A Tool call holds a lease on the generation that provided its Tool from the start of its
execution until it settles, so a reload never closes a generation while one of its Tools runs.
A Turn holds no lease: the Tools offered to the model are fixed when the Turn opens, while each
call resolves its Tool when it starts. A call that starts after the swap runs the reloaded Tool
and its gate Hooks; a call to a name the reloaded Plugins no longer provide returns
`Unknown tool: <name>.` A call that resolved its Tool just before the swap but starts after that
generation stopped taking leases does not run; it returns an error result that asks the model to
call the Tool again.

When leases outlast the 5-second drain timeout, the swap stands and the new generation serves,
but `/reload` fails with a message that names both generation IDs and the lease holders (for
example `tool:delegate`). The old generation closes, and the generation-swap diagnostic is
logged, when its last lease settles, even if the `/reload` caller is gone. Closing the runtime
waits for those leases too. Commands, the compaction gate, and `session-lifecycle` Taps take no
lease; they run on the generation that is current when they start.

Cache busting re-imports the Plugin entry file with fresh module state. It does not change relative
sibling URLs. Restart the process after a sibling module changes. Each entry reload also remains in
Node's ESM registry, so reload is for human-paced development, not a hot loop.

Import timeout bounds composition latency only (RFC Design 4, 03/D-010): native ESM imports are not
cancellable, a timed-out import's side effects may still run later, and repeated reload attempts with
cache-busted specifiers accumulate registry entries. Startup maps the timeout fail-closed (exit 2);
reload maps it contained (current generation serves).

## Recovery name-identity caveat

Tool identity in journal Records is by name. A crash recovered after a reload that redefined a
same-named Tool replays against the new definition. Operators changing Tool semantics under a stable
name across a crash boundary own that risk.

## First-party import boundary

Files below a `features/` directory must import popeye packages from package roots only. They must not
use deep imports or relative imports that escape their feature package. A feature imports
`@dungle-scrubs/popeye-plugins`. The CLI composition module alone imports
`@dungle-scrubs/popeye-kernel` to supply public kernel operations. `pnpm check-boundaries` checks
the relative-import part of this rule. It does not yet check imports by package name.
