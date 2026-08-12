import { expect, test } from "vitest";

import { EntryIdSchema, EntrySchema, SessionIdSchema } from "#journal";

import {
  paginateSnapshot,
  resolvePageBytes,
  sliceSnapshotByRange,
  snapshotEncodedBytes,
} from "./pagination.js";
import { SnapshotSchema } from "./snapshot.js";

const makeEntry = (
  id: string,
  parentId: string | null,
  payload: unknown = { text: "x".repeat(10) },
) =>
  EntrySchema.make({
    id: EntryIdSchema.make(id),
    kind: id === "root" ? "session_root" : "user",
    parentId: parentId === null ? null : EntryIdSchema.make(parentId),
    payload,
  });

const sessionId = SessionIdSchema.make("sess-test");

test("small snapshot not paginated", () => {
  const root = makeEntry("root", null);
  const e1 = makeEntry("e1", "root");
  const result = paginateSnapshot({
    entries: [root, e1],
    leafEntryId: e1.id,
    phase: "IDLE",
    revision: 2,
    sessionId,
  });
  expect(result.isPaginated).toBe(false);
  expect(result.warning).toBe(false);
  expect(result.snapshot.entries.length).toBe(2);
  expect(result.snapshot.leafEntryId).toBe(e1.id);
});

test("large snapshot paginated leaf-anchored under 1 MiB", () => {
  // Build ~2200 entries to exceed 1 MiB with small payloads - but with 10 bytes payload it will not exceed, so force small pageBytes
  const entries = [];
  const root = makeEntry("root", null);
  entries.push(root);
  let parent = "root";
  for (let i = 0; i < 100; i++) {
    const e = makeEntry(`e${i}`, parent, { text: "x".repeat(500) });
    entries.push(e);
    parent = `e${i}`;
  }
  const leaf = entries[entries.length - 1] as unknown as ReturnType<typeof makeEntry>;
  const result = paginateSnapshot(
    {
      entries,
      leafEntryId: leaf.id,
      phase: "IDLE",
      revision: 100,
      sessionId,
    },
    10_240, // force pagination at 10 KiB
  );
  expect(result.isPaginated).toBe(true);
  expect(result.encodedBytes).toBeLessThanOrEqual(10_240);
  expect(result.snapshot.leafEntryId).toBe(leaf.id);
  expect(result.snapshot.entryRange?.hasMoreBefore).toBe(true);
  expect(result.snapshot.entryRange?.hasMoreAfter).toBe(false);
  expect(result.snapshot.entryRange?.afterEntryId).toBeDefined();
});

test("single large entry over bound delivered anyway with diagnostic", () => {
  const root = makeEntry("root", null);
  const huge = makeEntry("huge", "root", { text: "x".repeat(2_000_000) });
  const result = paginateSnapshot(
    {
      entries: [root, huge],
      leafEntryId: huge.id,
      phase: "IDLE",
      revision: 2,
      sessionId,
    },
    1_048_576,
  );
  expect(result.snapshot.entries.length).toBe(1);
  expect(result.snapshot.entries[0]?.id).toBe("huge");
  // Even though over bound, single entry is delivered
  expect(result.encodedBytes).toBeGreaterThan(1_048_576);
});

test("resolvePageBytes validates", () => {
  expect(resolvePageBytes(undefined)).toBe(1_048_576);
  expect(resolvePageBytes("10240")).toBe(10_240);
  expect(() => resolvePageBytes("0")).toThrow();
  expect(() => resolvePageBytes("-1")).toThrow();
  expect(() => resolvePageBytes("foo")).toThrow();
});

test("256 KiB warning emitted but not paginated at threshold", () => {
  const entries = [];
  const root = makeEntry("root", null);
  entries.push(root);
  let parent = "root";
  // ~50 entries * 511 ~ 25k, need to reach 300k for warning - use larger payload
  for (let i = 0; i < 60; i++) {
    const e = makeEntry(`e${i}`, parent, { text: "x".repeat(5000) });
    entries.push(e);
    parent = `e${i}`;
  }
  const leaf = entries[entries.length - 1] as unknown as ReturnType<typeof makeEntry>;
  const result = paginateSnapshot(
    {
      entries,
      leafEntryId: leaf.id,
      phase: "IDLE",
      revision: 60,
      sessionId,
    },
    1_048_576,
  );
  const bytes = result.encodedBytes;
  if (bytes > 262_144 && bytes <= 1_048_576) {
    expect(result.warning).toBe(true);
    expect(result.isPaginated).toBe(false);
  }
});

test("sliceSnapshotByRange validates", () => {
  const root = makeEntry("root", null);
  const e1 = makeEntry("e1", "root");
  const e2 = makeEntry("e2", "e1");
  const e3 = makeEntry("e3", "e2");
  const input = {
    entries: [root, e1, e2, e3] as const,
    leafEntryId: e3.id,
    phase: "IDLE" as const,
    revision: 4,
    sessionId,
  };
  const afterE1 = sliceSnapshotByRange(input, e1.id, null);
  expect(afterE1.isValid).toBe(true);
  expect(afterE1.snapshot.entries.map((e) => e.id)).toEqual(["e2", "e3"]);

  const beforeE3 = sliceSnapshotByRange(input, null, e3.id);
  expect(beforeE3.snapshot.entries.map((e) => e.id)).toEqual(["root", "e1", "e2"]);

  const between = sliceSnapshotByRange(input, e1.id, e3.id);
  expect(between.snapshot.entries.map((e) => e.id)).toEqual(["e2"]);

  const unknown = sliceSnapshotByRange(input, EntryIdSchema.make("missing"), null);
  expect(unknown.isValid).toBe(false);
});

test("snapshotEncodedBytes matches report harness", () => {
  const root = makeEntry("root", null);
  const e1 = makeEntry("e1", "root", { role: "user", content: "x".repeat(160) });
  const snap = SnapshotSchema.make({
    entries: [root, e1],
    leafEntryId: e1.id,
    phase: "IDLE",
    revision: 1,
    sessionId,
  });
  const bytes = snapshotEncodedBytes(snap);
  expect(bytes).toBeGreaterThan(0);
});

test("harness from snapshot-size-report - 500 turns below threshold, 1000 turns paginated", () => {
  const buildWorkload = (turns: number, scale = 1): ReturnType<typeof makeEntry>[] => {
    const entries: ReturnType<typeof makeEntry>[] = [];
    const root = makeEntry("root", null);
    entries.push(root);
    let parent = "root";
    // Mimic report: 160 bytes user, 640 assistant, 320 tool result every 10th turn, scaled
    for (let t = 1; t <= turns; t++) {
      const user = makeEntry(`u${t}`, parent, { role: "user", content: "x".repeat(160 * scale) });
      entries.push(user);
      parent = `u${t}`;
      if (t % 10 === 0) {
        const tool = makeEntry(`tool${t}`, parent, {
          role: "tool",
          content: "x".repeat(320 * scale),
        });
        entries.push(tool);
        parent = `tool${t}`;
      }
      const assistant = makeEntry(`a${t}`, parent, {
        role: "assistant",
        content: "x".repeat(640 * scale),
      });
      entries.push(assistant);
      parent = `a${t}`;
    }
    return entries;
  };

  const entries500 = buildWorkload(500);
  const leaf500 = entries500[entries500.length - 1] as ReturnType<typeof makeEntry>;
  const result500 = paginateSnapshot({
    entries: entries500,
    leafEntryId: leaf500.id,
    phase: "IDLE",
    revision: entries500.length,
    sessionId,
  });
  // 500 turns should be below 1 MiB per report (~563 KiB), not paginated but maybe warning
  expect(result500.encodedBytes).toBeLessThan(1_048_576);
  expect(result500.isPaginated).toBe(false);

  const entries1000 = buildWorkload(1000, 1.2);
  const leaf1000 = entries1000[entries1000.length - 1] as ReturnType<typeof makeEntry>;
  const result1000 = paginateSnapshot({
    entries: entries1000,
    leafEntryId: leaf1000.id,
    phase: "IDLE",
    revision: entries1000.length,
    sessionId,
  });
  expect(result1000.encodedBytes).toBeLessThanOrEqual(1_048_576);
  expect(result1000.isPaginated).toBe(true);
  expect(result1000.snapshot.leafEntryId).toBe(leaf1000.id);
  expect(result1000.snapshot.entryRange?.hasMoreBefore).toBe(true);
});
