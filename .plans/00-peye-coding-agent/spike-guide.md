# peye v1 - Spike Guide

Three untested technical assumptions from RFC-01 / implementation.md.
Each is a small throwaway experiment; learnings merge into the
implementation plan and this guide is archived.

## Assumptions

### A-001: pi-ai stream wraps cleanly into Effect Stream

- **Assumption:** `AssistantMessageEventStream` (async-iterable +
  `result()` promise, never-throw contract) converts to
  `Stream.Stream<Item, ProviderError>` preserving ordering, error
  encoding, and settlement, using only pi-ai's public API.
- **Impact if false:** the seam needs a buffering/normalization layer;
  M12 grows; fixtures encode a canonical order (escape hatch 3).
- **Experiment:** small script against `@earendil-works/pi-ai@0.84.x`:
  wrap via `Stream.fromAsyncIterable`, drive (a) a mocked stream
  replaying a recorded fixture with interleaved text/thinking/toolcall
  items, an error-terminal fixture, and an abort; (b) one live call
  through a cheap provider. Assert: item order preserved; terminal
  error surfaces as typed failure not a throw; `result()` and stream
  end agree; interruption of the consuming fiber does not leak the
  underlying request. Also verify `isRetryableAssistantError` is
  importable and callable on the error-terminal fixture's message.
- **Pass criteria:** all assertions hold with no monkey-patching of
  pi-ai internals.
- **Effort:** ~half a day.

### A-002: Node 24 imports user TS plugin files natively

- **Assumption:** `import()` of user-authored `.ts` plugin files from
  arbitrary absolute paths works under Node 24's type stripping, for
  the syntax plugin authors realistically use (type annotations,
  interfaces, generics), without a bundler or loader dependency.
- **Impact if false:** M18 adds jiti (pi-proven) as the loader
  (escape hatch 1); no external API change.
- **Experiment:** fixture plugins exercising: plain annotations;
  `import type`; enums and namespaces (expected to FAIL type
  stripping - document as unsupported plugin syntax if so); a plugin
  importing `effect` from the host's node_modules; a plugin importing
  a sibling relative file; cache-busting a re-import for hot reload
  (query-string or copy strategy - measure which works).
- **Pass criteria:** annotations/`import type`/host-package imports
  load; the re-import strategy yields fresh module state for reload;
  unsupported syntax list is short enough to document (enums out is
  acceptable).
- **Effort:** ~half a day.

### A-003: Scope-drain hot reload works with stock Effect semantics

- **Assumption:** a plugin generation built as a `Layer` within an
  explicitly created `Scope` can have its close deferred behind a
  drain barrier (in-flight turns settle first) while a new generation
  serves subsequent work - with finalizers running exactly once, in
  order, and no use-after-close observable by the old generation's
  contributions.
- **Impact if false:** explicit in-flight turn refcount gates the
  close instead (escape hatch 2); M18 internal design shifts.
- **Experiment:** prototype with fake "turns" (fibers holding
  resources from generation N): build gen N in `Scope.make()`, swap a
  `Ref`, start gen N+1 work concurrently, close N's scope behind a
  `Deferred` that resolves when in-flight count hits zero. Assert:
  N's finalizers run after the last in-flight turn settles and before
  any report of reload completion; a turn started after the swap never
  observes N; interruption during drain still runs finalizers once.
- **Pass criteria:** all assertions hold under a race-stress loop
  (100+ iterations, randomized delays).
- **Effort:** ~1 day.
