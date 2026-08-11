# Conformance suites

peye publishes its reusable test contracts from package subpaths. The package roots do not import
Vitest. Install Vitest only in projects that run a conformance suite.

## Journal adapters

Import the Journal contract from `@peye/journal/conformance`. The harness must return a fresh
adapter for each test. `reopen` must open the same durable content through a new Layer.
`snapshotLines` must return the adapter's durable lines so the suite can prove append-only writes.

```typescript
import {
  createMemoryJournalContractHarness,
  describeJournalContract,
} from "@peye/journal/conformance";

await describeJournalContract(createMemoryJournalContractHarness);
```

For another backend, implement `JournalContractHarness` and pass its factory to
`describeJournalContract`. The suite checks Session creation, Entry and Record behavior, Branch
folding, Compaction, leaf moves, reopen behavior, isolation, validation, and concurrent appends.

## Provider adapters and pi-ai upgrades

Import the ai seam contract from `@peye/kernel/ai-conformance`. The shipped harness feeds recorded
pi-ai streams through the shipped Provider Layer without network access.

```typescript
import {
  createPiAiSeamContractHarness,
  describeAiSeamContract,
} from "@peye/kernel/ai-conformance";

await describeAiSeamContract(createPiAiSeamContractHarness);
```

The suite checks request mapping, Tool declarations, interleaved text and thinking deltas, Tool
calls, stop reasons, typed provider failures, transient classification, missing terminal items,
and terminal-reason drift. Run it before accepting a pi-ai version change.

To test another Provider adapter, implement `AiSeamContractHarness<TFixture>`. Supply recorded
fixtures for each named case. `providerLayer` must feed one fixture through the adapter and report a
normalized request through `onRequest`. The same assertions then run against the Provider interface.

## Peer dependency rule

Both conformance subpaths load Vitest when their `describe*Contract` function runs. Vitest is an
optional peer of each package so normal use of `@peye/journal` and `@peye/kernel` stays Vitest-free.
Projects that run either suite must install a compatible Vitest 3 release.
