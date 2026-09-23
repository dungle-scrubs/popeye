# Testing with recorded Journal fixtures

Recorded Journal fixtures preserve the durable boundary of a Session. They contain the JSONL
header, Entries, and Records that the JSONL Journal wrote during a deterministic Driver script.
Tests use them to detect schema drift, fold drift, and recovery errors without a live Provider.

## Canonical M14 fixture

[`packages/kernel/test-fixtures/canonical-driver-session.jsonl`](../packages/kernel/test-fixtures/canonical-driver-session.jsonl)
records one Session that uses a Tool, accepts Steering, runs a Follow-up, aborts a Turn, moves the
Leaf to an earlier Branch, and appends a Compaction Entry.

The test in [`packages/kernel/src/driver.test.ts`](../packages/kernel/src/driver.test.ts) creates the
Session with a fake Provider and a deterministic Tool. It then normalizes all generated values:

- Session, Entry, Record, and operation IDs become ordered placeholders.
- Timestamp fields become `<timestamp>`.
- JSON object keys and JSONL line order stay unchanged.
- The file ends with one newline.

Normalization is idempotent. The test applies it twice and requires the same result.

## Regenerate the canonical fixture

Regenerate only after an intentional change to the durable contract or canonical Driver script:

```sh
POPEYE_UPDATE_RECORDED_FIXTURES=1 pnpm exec vitest run packages/kernel/src/driver.test.ts \
  -t "scripted session is captured as the canonical recorded-journal fixture"
git diff -- packages/kernel/test-fixtures/canonical-driver-session.jsonl
pnpm exec vitest run packages/kernel/src/driver.test.ts
```

The update mode runs the same fake Provider and Tool as the normal assertion. It writes only the
normalized fixture. Review every changed JSONL line. A changed ID placeholder alone often means the
Entry or Record order changed.

## Write a replay test

Copy a fixture into a temporary Journal directory. Open it through `JournalJsonl`. Assert the
Branch or recovery result through the public Journal interface.

```typescript
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Journal, JournalJsonl, SessionIdSchema } from "@popeye/journal";
import { Effect } from "effect";
import { expect, test } from "vitest";

test("replays the recorded Session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "popeye-recorded-"));
  const sessionId = SessionIdSchema.make("<session-1>");
  try {
    await copyFile(
      new URL("../test-fixtures/canonical-driver-session.jsonl", import.meta.url),
      join(directory, `${sessionId}.jsonl`),
    );
    const branch = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal;
        return yield* journal.readBranch(sessionId);
      }).pipe(Effect.provide(JournalJsonl(directory))),
    );

    expect(branch.at(-1)?.kind).toBe("compaction");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
```

Do not assert generated IDs, timestamps, or temporary paths before normalization. Assert durable
kind, parent relationships, payload, recovery action, and final Branch instead.

## M24 crash matrix

[`packages/kernel/src/recovery-matrix.ts`](../packages/kernel/src/recovery-matrix.ts) is the worked
example for crash testing. It records 5 deterministic Sessions, reads their JSONL content, and
derives each acknowledged boundary from durable kind and payload. It does not use fixed line
indexes. The matrix injects a process crash after each acknowledgement and then resumes the Session.

The assertions in
[`packages/kernel/src/recovery-matrix.test.ts`](../packages/kernel/src/recovery-matrix.test.ts)
check that every cell:

- reopens as a well-formed Journal;
- emits the expected recovery report and span;
- preserves completed Tool results;
- synthesizes interrupted results for `replay: "never"`;
- re-executes `replay: "safe"` Tools;
- has no duplicate Tool call IDs or open operations;
- accepts the next prompt.

Run the worked examples with:

```sh
pnpm exec vitest run packages/kernel/src/driver.test.ts packages/kernel/src/recovery-matrix.test.ts
```

The matrix writes only to temporary directories. Its recorded Sessions are generated for each run.
The checked-in M14 fixture remains the stable, reviewable JSONL example.
