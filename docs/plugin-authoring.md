# Plugin authoring

A Plugin is the only unit of behavior addition in pop-eye. It returns a Schema-validated manifest and
an array of Contributions. The shipped compact and Session-name features use this public interface.
Read their source at
[`packages/cli/src/features`](../packages/cli/src/features) beside this guide.

## Current host boundary

`@pop-eye/plugins` publishes the manifest, registry, Hook emitter, Trust, discovery, loading, and
generation APIs. The v1 CLI package publishes Head functions rather than an executable. Its
first-party host statically composes the compact and Session-name Plugins. An application that uses
dynamic discovery must wire `makePluginRuntime` into its own host.

npm-referenced Plugin packages are not in v1. The loader accepts absolute paths to local TypeScript
files. Project discovery reads `.peye/plugins/`. User-global directories and explicit CLI paths come
from the host's `PluginDiscoveryConfig`.

## Minimal Plugin

A module must export a factory as either `plugin` or `default`. The factory can return its value or
a Promise.

```typescript
import { defineCommandContribution } from "@pop-eye/plugins";
import type { PluginManifest } from "@pop-eye/plugins";
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

Import from package roots. Do not import `@pop-eye/plugins/src/*` or another package's source files.

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

### Commands

Use `defineCommandContribution`. A Command is invoked by the user through
`Driver.invokeCommand`. It never enters the model's Tool list. The host validates `arguments`
before it runs `execute`.

The current `CommandExecutionContext` contains:

- `sessionId` for the active Session;
- `compactNow(expectedRevision?)` for the public Compaction operation;
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

## Supported TypeScript syntax

The loader uses Node 24 native TypeScript stripping through an absolute `file:` URL. Type
annotations, `import type`, generics, host-package imports, and relative sibling imports work.

Do not use TypeScript `enum` or `namespace` declarations in a Plugin. Node reports them as
unsupported transform syntax. The loader converts that error to `PluginLoadError` and names the
file and construct. Use `as const` objects, string literal unions, and ordinary modules instead.

## Reload and generation drain

Each generation owns an Effect `Scope`. Reload builds a fresh generation before it changes routing.
If the build fails, the current generation stays active. A successful reload then:

1. swaps the current generation reference;
2. sends all newly admitted work to the fresh generation;
3. lets in-flight work finish on its captured generation;
4. waits at a drain barrier;
5. closes the old `Scope` and runs its finalizers once;
6. emits a generation-swap diagnostic with IDs, Plugin changes, drain time, and closed resources.

The runtime serializes reload operations. Hosts use `useSerialized` for gates that must not
interleave with a reload.

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

Files below a `features/` directory must import pop-eye packages from package roots only. They must not
use deep imports or relative imports that escape their feature package. A feature imports
`@pop-eye/plugins`. The CLI composition module alone imports `@pop-eye/kernel` to supply public kernel
operations. Run `pnpm check-boundaries` to enforce this rule.
