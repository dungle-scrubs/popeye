# First-party Plugin author interface

The first-party Plugins use the same public interface as an external Plugin. Feature modules import
`@popeye/plugins` from its package root. They use Effect v3 for execution and Schema values. The CLI
composition module imports `@popeye/kernel` from its package root and supplies the public kernel
operations through the command context. Feature modules do not import kernel source files or
journal adapters.

## Plugin manifest

A Plugin returns a `manifest` and a `contributions` array. The Plugin manifest declares a kebab-case
name, a semantic version, optional descriptive text, and its Capabilities. Declare every Capability
that a Contribution needs. The compact and session-name Plugins need no Capability, so both declare
an empty array.

## Command Contribution

Use `defineCommandContribution` for a Command. The declaration contains a name, description,
argument Schema, and Effect-returning `execute` function. The host validates the input against the
Schema before it calls `execute`.

The `CommandExecutionContext` is scoped to one Session. It provides the Session id and these public
kernel operations:

- `compactNow(expectedRevision?)` applies Compaction through the public Compaction operation.
- `setSessionName(name, expectedRevision?)` appends a non-model-visible `session_name` Entry. A
  Session name must contain a non-whitespace character and must not exceed 200 characters.

A Command must use these operations. It must not write to the Journal or import kernel source paths.
The Driver exposes Commands through `invokeCommand(sessionId, name, args, expectedRevision?)`.
The Driver checks `expectedRevision` inside the Session mailbox before it decodes arguments, runs a
Hook, or mutates the Journal.

## Gate Hook

Use `defineHookContribution` for a Hook. The compact Plugin contributes the `compaction-gate` Hook.
This Hook uses the `FirstWins` merge class. It returns `action: "compact"` or `action: "skip"`. A
skip vetoes manual Compaction with a `command_vetoed` error. A skip also prevents overflow-triggered
Compaction. The Turn settles with a budget diagnostic that tells the user to branch or start a new
Session. The v1 Hook does not replace a Compaction summary or instruction.

The import-boundary check scans every file under a `features/` directory. It rejects deep imports
from `@popeye/kernel`, `@popeye/plugins`, `@popeye/journal`, and `@popeye/protocol`. It also rejects relative
imports that escape the feature's package. Feature modules use `@popeye/plugins` from its package
root. The CLI composition module uses `@popeye/kernel` from its package root.
