# First-party Plugin author interface

The first-party Plugins use the same public interface as an external Plugin. Feature modules import
`@peye/plugins` from its package root. They use Effect v3 for execution and Schema values. The CLI
composition module imports `@peye/kernel` from its package root and supplies the public kernel
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
- `setSessionName(name, expectedRevision?)` appends a non-model-visible `session_name` Entry.

A Command must use these operations. It must not write to the Journal or import kernel source paths.
The Driver exposes Commands through `invokeCommand(sessionId, name, args)`.

## Gate Hook

Use `defineHookContribution` for a Hook. The compact Plugin contributes the `compaction-gate` Hook.
This Hook uses the `FirstWins` merge class. It returns `continue`, `block`, or `replace`. A block
rejects Compaction. A replacement with `action: "skip"` returns a skip result without appending a
Compaction Entry.

The import-boundary check scans every file under a `features/` directory. It rejects kernel internal
paths. Feature modules use `@peye/plugins` from its package root. The CLI composition module uses
`@peye/kernel` from its package root.
