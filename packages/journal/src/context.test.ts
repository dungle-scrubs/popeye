import { Effect } from "effect";
import { expect, test } from "vitest";

import { foldContext } from "./context.js";
import { type Entry, EntryIdSchema, EntrySchema } from "./shapes.js";

const root = EntrySchema.make({
  id: EntryIdSchema.make("root"),
  kind: "session_root",
  parentId: null,
  payload: {},
});

const entry = (id: string, parentId: string | null, kind = "conversation"): Entry =>
  EntrySchema.make({
    id: EntryIdSchema.make(id),
    kind,
    parentId: parentId === null ? null : EntryIdSchema.make(parentId),
    payload: { content: id, role: "user" },
  });

test("foldContext returns no items for a root-only branch", async () => {
  const result = await Effect.runPromise(
    foldContext([root], {
      budget: 10,
      visibility: () => {
        throw new Error("The root entry must not cross the visibility boundary.");
      },
    }),
  );

  expect(result).toEqual({ accounting: { usedBudget: 0 }, items: [] });
});

test("foldContext uses the newest compaction summary, retained tail, and later entries", async () => {
  const earlier = entry("earlier", "root");
  const retained = entry("retained", "earlier");
  const compaction = EntrySchema.make({
    id: EntryIdSchema.make("compaction"),
    kind: "compaction",
    parentId: retained.id,
    payload: {
      firstSummarizedId: earlier.id,
      lastSummarizedId: retained.id,
      retainedTailIds: [retained.id],
      summary: "Earlier context.",
    },
  });
  const later = entry("later", "compaction");
  const result = await Effect.runPromise(
    foldContext([root, earlier, retained, compaction, later], {
      budget: 100,
      visibility: (candidate) => {
        const payload = candidate.payload as { readonly content: string; readonly role: string };
        return { content: payload.content, role: payload.role };
      },
    }),
  );

  expect(result).toEqual({
    accounting: {
      compactionApplied: compaction.id,
      usedBudget: "Earlier context.".length + "retained".length + "later".length,
    },
    items: [
      { content: "Earlier context.", role: "system" },
      { content: "retained", role: "user" },
      { content: "later", role: "user" },
    ],
  });
});

test("foldContext delegates compaction summary shaping to summaryItem", async () => {
  const first = entry("first", "root");
  const compaction = EntrySchema.make({
    id: EntryIdSchema.make("compaction"),
    kind: "compaction",
    parentId: first.id,
    payload: {
      firstSummarizedId: first.id,
      lastSummarizedId: first.id,
      retainedTailIds: [],
      summary: "Raw summary.",
    },
  });

  const result = await Effect.runPromise(
    foldContext([root, first, compaction], {
      budget: 100,
      summaryItem: (payload) => ({ content: `summary:${payload.summary}`, role: "developer" }),
      visibility: () => ({ content: "not visible", role: "user" }),
    }),
  );

  expect(result.items).toEqual([{ content: "summary:Raw summary.", role: "developer" }]);
});

test("foldContext never visits entries before the newest compaction outside its retained tail", async () => {
  const earlier = entry("earlier", "root");
  const retained = entry("retained", "earlier");
  const compaction = EntrySchema.make({
    id: EntryIdSchema.make("compaction"),
    kind: "compaction",
    parentId: retained.id,
    payload: {
      firstSummarizedId: earlier.id,
      lastSummarizedId: retained.id,
      retainedTailIds: [retained.id],
      summary: "Earlier context.",
    },
  });
  const later = entry("later", "compaction");
  const visited: Array<string> = [];

  await Effect.runPromise(
    foldContext([root, earlier, retained, compaction, later], {
      budget: 100,
      visibility: (candidate) => {
        visited.push(candidate.id);
        const payload = candidate.payload as { readonly content: string; readonly role: string };
        return { content: payload.content, role: payload.role };
      },
    }),
  );

  expect(visited).toEqual([retained.id, later.id]);
});

test("foldContext lets the newest compaction cover an older compaction", async () => {
  const first = entry("first", "root");
  const olderCompaction = EntrySchema.make({
    id: EntryIdSchema.make("older-compaction"),
    kind: "compaction",
    parentId: first.id,
    payload: {
      firstSummarizedId: first.id,
      lastSummarizedId: first.id,
      retainedTailIds: [],
      summary: "Old summary.",
    },
  });
  const beforeNewest = entry("before-newest", "older-compaction");
  const newestCompaction = EntrySchema.make({
    id: EntryIdSchema.make("newest-compaction"),
    kind: "compaction",
    parentId: beforeNewest.id,
    payload: {
      firstSummarizedId: olderCompaction.id,
      lastSummarizedId: beforeNewest.id,
      retainedTailIds: [],
      summary: "New summary.",
    },
  });
  const later = entry("later", "newest-compaction");
  const visited: Array<string> = [];
  const result = await Effect.runPromise(
    foldContext([root, first, olderCompaction, beforeNewest, newestCompaction, later], {
      budget: 100,
      visibility: (candidate) => {
        visited.push(candidate.id);
        const payload = candidate.payload as { readonly content: string; readonly role: string };
        return { content: payload.content, role: payload.role };
      },
    }),
  );

  expect(result.items).toEqual([
    { content: "New summary.", role: "system" },
    { content: "later", role: "user" },
  ]);
  expect(visited).toEqual([later.id]);
});

test("foldContext ignores a compaction that is not on the selected branch", async () => {
  const summarized = entry("summarized", "root");
  const branchLeaf = entry("branch-leaf", "summarized");
  const result = await Effect.runPromise(
    foldContext([root, summarized, branchLeaf], {
      budget: 100,
      visibility: (candidate) => {
        const payload = candidate.payload as { readonly content: string; readonly role: string };
        return { content: payload.content, role: payload.role };
      },
    }),
  );

  expect(result).toEqual({
    accounting: { usedBudget: "summarized".length + "branch-leaf".length },
    items: [
      { content: "summarized", role: "user" },
      { content: "branch-leaf", role: "user" },
    ],
  });
});

test("foldContext excludes non-visible entries only through its visibility callback", async () => {
  const hidden = entry("hidden", "root", "internal");
  const visible = entry("visible", "hidden");
  const visited: Array<string> = [];
  const result = await Effect.runPromise(
    foldContext([root, hidden, visible], {
      budget: 100,
      visibility: (candidate) => {
        visited.push(candidate.id);
        if (candidate.kind === "internal") {
          return undefined;
        }
        const payload = candidate.payload as { readonly content: string; readonly role: string };
        return { content: payload.content, role: payload.role };
      },
    }),
  );

  expect(result.items).toEqual([{ content: "visible", role: "user" }]);
  expect(visited).toEqual([hidden.id, visible.id]);
});

test("foldContext accounts for every included entry through sizeOf", async () => {
  const first = entry("first", "root");
  const compaction = EntrySchema.make({
    id: EntryIdSchema.make("compaction"),
    kind: "compaction",
    parentId: first.id,
    payload: {
      firstSummarizedId: first.id,
      lastSummarizedId: first.id,
      retainedTailIds: [first.id],
      summary: "Summary.",
    },
  });
  const later = entry("later", "compaction");
  const result = await Effect.runPromise(
    foldContext([root, first, compaction, later], {
      budget: 12,
      sizeOf: (candidate) =>
        candidate.kind === "compaction" ? 5 : candidate.id === first.id ? 3 : 4,
      visibility: (candidate) => {
        const payload = candidate.payload as { readonly content: string; readonly role: string };
        return { content: payload.content, role: payload.role };
      },
    }),
  );

  expect(result.accounting).toEqual({ compactionApplied: compaction.id, usedBudget: 12 });
});

test("foldContext emits retained entries in branch order when replayed content lists them out of order", async () => {
  const first = entry("first", "root");
  const second = entry("second", "first");
  const compaction = EntrySchema.make({
    id: EntryIdSchema.make("compaction"),
    kind: "compaction",
    parentId: second.id,
    payload: {
      firstSummarizedId: first.id,
      lastSummarizedId: second.id,
      retainedTailIds: [second.id, first.id],
      summary: "Summary.",
    },
  });

  const result = await Effect.runPromise(
    foldContext([root, first, second, compaction], {
      budget: 100,
      visibility: (candidate) => ({ content: candidate.id, role: "user" }),
    }),
  );

  expect(result.items).toEqual([
    { content: "Summary.", role: "system" },
    { content: first.id, role: "user" },
    { content: second.id, role: "user" },
  ]);
});

test("foldContext rejects malformed compactions and unresolved retained ids as corruption", async () => {
  const first = entry("first", "root");
  const malformed = EntrySchema.make({
    id: EntryIdSchema.make("malformed"),
    kind: "compaction",
    parentId: first.id,
    payload: { summary: "Missing span ids." },
  });
  const malformedError = await Effect.runPromise(
    Effect.flip(
      foldContext([root, first, malformed], {
        budget: 100,
        visibility: () => ({ content: "not visible", role: "user" }),
      }),
    ),
  );
  const unresolved = EntrySchema.make({
    id: EntryIdSchema.make("unresolved"),
    kind: "compaction",
    parentId: first.id,
    payload: {
      firstSummarizedId: first.id,
      lastSummarizedId: first.id,
      retainedTailIds: [EntryIdSchema.make("missing")],
      summary: "Summary.",
    },
  });
  const unresolvedError = await Effect.runPromise(
    Effect.flip(
      foldContext([root, first, unresolved], {
        budget: 100,
        visibility: () => ({ content: "not visible", role: "user" }),
      }),
    ),
  );

  expect(malformedError).toMatchObject({
    _tag: "JournalError",
    corruptionClass: "invalid_compaction",
  });
  expect(unresolvedError).toMatchObject({
    _tag: "JournalError",
    corruptionClass: "invalid_compaction",
    message: expect.stringContaining("missing"),
  });
});

test("foldContext dies when sizeOf returns a negative or non-finite size", async () => {
  await expect(
    Effect.runPromise(
      foldContext([root, entry("first", "root")], {
        budget: 100,
        sizeOf: () => Number.NaN,
        visibility: () => ({ content: "visible", role: "user" }),
      }),
    ),
  ).rejects.toThrow("sizeOf must return a finite, non-negative number");
});

test("foldContext fails with ContextBudgetExceeded when compaction cannot fit its budget", async () => {
  const first = entry("first", "root");
  const compaction = EntrySchema.make({
    id: EntryIdSchema.make("compaction"),
    kind: "compaction",
    parentId: first.id,
    payload: {
      firstSummarizedId: first.id,
      lastSummarizedId: first.id,
      retainedTailIds: [],
      summary: "Summary.",
    },
  });
  const error = await Effect.runPromise(
    Effect.flip(
      foldContext([root, first, compaction], {
        budget: 4,
        sizeOf: () => 5,
        visibility: () => ({ content: "not included", role: "user" }),
      }),
    ),
  );

  expect(error).toMatchObject({
    _tag: "ContextBudgetExceeded",
    budget: 4,
    compactionApplied: compaction.id,
    optionsDiagnostic: "branch to an earlier entry or start a new session",
    required: 5,
  });
});
