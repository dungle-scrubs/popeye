# A-002 - Native Node 24 TypeScript plugin imports

## What ran

`npx tsx spike-a002.ts` created no loader or bundler dependency. The script launched the installed native runtime, Node `v24.15.0`, in a child process and used `await import()` with absolute `file:` URLs for every fixture. This specifically tests Node's strip-only TypeScript behavior rather than tsx's transform behavior.

## Passing runtime assertions

- A plugin with type-annotated code loaded and evaluated to `annotation:loaded`.
- A plugin using `import type` loaded and exported `import-type`.
- A plugin using a generic function loaded and evaluated to `generic`.
- A plugin importing `effect` resolved it from the host project's `node_modules` and evaluated to `effect-from-host-node-modules`.
- A plugin using a relative sibling import with `./sibling.ts` loaded and evaluated to `relative-sibling-loaded`.
- Hot reload worked in one native Node process with a cache-busted absolute file URL: `import(fileUrl + "?reload=" + uniqueKey)`. Two imports with distinct query keys produced stateful module counts `1` then `2`, proving a fresh module evaluation.

## Exact unsupported syntax list

| Fixture | Native error code | Native message |
| --- | --- | --- |
| `enum.ts` | `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | `TypeScript enum is not supported in strip-only mode` |
| `namespace.ts` | `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | `TypeScript namespace declaration is not supported in strip-only mode` |

No other fixture failed. Plugin guidance must prohibit runtime `enum` and `namespace` syntax, or introduce a transforming loader if either becomes necessary.

VERDICT: pass
