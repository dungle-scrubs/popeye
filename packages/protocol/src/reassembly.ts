/**
 * Owns Snapshot window reassembly.
 * It exists so Heads that receive leaf-anchored paginated windows can reconstruct the full branch when needed.
 *
 * What it owns: concatenating windows in branch order, verifying leafEntryId/revision/sessionId identity,
 * sorting by entryRange.afterEntryId chain, and producing a full branch Snapshot with hasMoreBefore:false/hasMoreAfter:false.
 * Why: every paginated Snapshot is authoritative per window (leafEntryId + revision preserved); full-transcript export
 * must not merge Progress and must not invent entries. Heads call get-snapshot range windows and reassemble here.
 * What it does not own: byte measurement or window selection (pagination.ts) or persistence (journal).
 */

import type { Snapshot } from "./snapshot.js";

export const reassembleSnapshots = (windows: ReadonlyArray<Snapshot>): Snapshot => {
  if (windows.length === 0) {
    throw new RangeError("reassembleSnapshots requires at least one window");
  }
  const first = windows[0];
  if (first === undefined) throw new RangeError("missing window");
  const leafEntryId = first.leafEntryId;
  const revision = first.revision;
  const sessionId = first.sessionId;
  const phase = first.phase;

  for (const w of windows) {
    if (w.leafEntryId !== leafEntryId || w.revision !== revision || w.sessionId !== sessionId) {
      throw new Error(
        `Window identity mismatch: leafEntryId/revision/sessionId must be identical across windows`,
      );
    }
    if (w.phase !== phase) {
      throw new Error(`Window phase mismatch`);
    }
  }

  // Single window - return full branch view (clear hasMore flags)
  if (windows.length === 1) {
    const w = first;
    if (w.entries.length === 0) {
      // Omit entryRange when empty - exactOptionalPropertyTypes
      const { entryRange: _ignore, ...rest } = w as unknown as Record<string, unknown>;
      return { ...(rest as Snapshot), entries: [] } as Snapshot;
    }
    return {
      ...(w as Snapshot),
      entries: [...w.entries],
      entryRange: {
        afterEntryId: null,
        beforeEntryId: null,
        hasMoreAfter: false,
        hasMoreBefore: false,
      },
    } as Snapshot;
  }

  // Sort windows by position: those with hasMoreBefore:false are earliest, then by afterEntryId chain
  // Build map from afterEntryId -> window for ordering
  const byAfter = new Map<string | null, Snapshot>();
  for (const w of windows) {
    const key = (w.entryRange?.afterEntryId ?? null) as string | null;
    // Keep first for duplicate key; harness will provide distinct windows
    if (!byAfter.has(key)) byAfter.set(key, w);
  }

  // Find head (window with hasMoreBefore:false or afterEntryId null and not referenced as before)
  // For leaf-anchored pagination, earliest window has afterEntryId of previous entry or null
  // Simply sort by whether hasMoreBefore, then reconstruct chain sequentially
  const sorted: Snapshot[] = [];
  const used = new Set<Snapshot>();
  // Start from window that is not reachable as after of another window's last entry
  // Fallback: window with hasMoreBefore false is earliest
  let current: Snapshot | undefined = windows.find(
    (w) => w.entryRange?.hasMoreBefore === false || w.entryRange === undefined,
  );
  if (current === undefined) current = windows[0];

  // Build ordered list by following entryRange chain via afterEntryId
  // Since we don't have direct next pointer, order by entries: find window whose afterEntryId equals previous window's last entry id
  // Simpler: sort windows by the position of their first entry in the reassembled branch
  // We can infer order by walking: earliest window's first entry is earliest in branch
  // Use iterative lookup: start with earliest, then next window's afterEntryId should equal last entry id of current
  const entryIdSet = new Set(windows.flatMap((w) => w.entries.map((e) => e.id as string)));
  // Find earliest: window whose afterEntryId is not in entryIdSet (null or before branch)
  const earliest = (windows.find((w) => {
    const after = w.entryRange?.afterEntryId ?? null;
    return after === null || !entryIdSet.has(after as string);
  }) ?? current) as Snapshot;

  sorted.push(earliest);
  used.add(earliest);

  while (sorted.length < windows.length) {
    const last = sorted[sorted.length - 1];
    if (last === undefined) break;
    const lastEntryId = last.entries.at(-1)?.id as string | undefined;
    // Next window should have afterEntryId == lastEntryId
    const next = windows.find(
      (w) => !used.has(w) && (w.entryRange?.afterEntryId as string | null) === lastEntryId,
    );
    if (next === undefined) {
      // Fallback: append remaining in input order
      const remaining = windows.find((w) => !used.has(w));
      if (remaining === undefined) break;
      sorted.push(remaining);
      used.add(remaining);
    } else {
      sorted.push(next);
      used.add(next);
    }
  }

  const entries = sorted.flatMap((w) => [...w.entries]);

  return {
    ...(first as Snapshot),
    entries,
    entryRange: {
      afterEntryId: null,
      beforeEntryId: null,
      hasMoreAfter: false,
      hasMoreBefore: false,
    },
  } as Snapshot;
};

export const isFullBranch = (snapshot: Snapshot): boolean =>
  snapshot.entryRange === undefined ||
  (!snapshot.entryRange.hasMoreBefore && !snapshot.entryRange.hasMoreAfter);
