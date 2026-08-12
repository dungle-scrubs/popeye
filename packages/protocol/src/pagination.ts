/**
 * Owns bounded Snapshot pagination.
 * It exists so a 1 MiB wire bound can be enforced without losing snapshot authority.
 *
 * What it owns: leaf-anchored windowing, entryRange flags, byte measurement via SnapshotSchema,
 * and threshold config (default 1,048,576, env PEYE_SNAPSHOT_PAGE_BYTES). <!-- D-002 --><!-- D-003 -->
 * Why: every paginated Snapshot must carry true leafEntryId + revision for its window,
 * with hasMoreBefore/After signaling the branch extends beyond the window. Estimate-then-verify
 * keeps emission under bound without full-branch encode when below threshold. <!-- D-007 -->
 * What it does not own: Journal persistence or compaction - those live in @pop-eye/journal.
 */

import { Schema } from "effect";

import type { Entry, EntryId } from "#journal";

import { type Snapshot, SnapshotSchema } from "./snapshot.js";

export const DEFAULT_PAGE_BYTES = 1_048_576;
export const WARNING_BYTES = 262_144;

export const resolvePageBytes = (raw: string | undefined): number => {
  if (raw === undefined || raw.length === 0) return DEFAULT_PAGE_BYTES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `PEYE_SNAPSHOT_PAGE_BYTES must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
};

export const snapshotEncodedBytes = (snapshot: Snapshot): number => {
  const encoded = Schema.encodeSync(SnapshotSchema)(snapshot);
  return new TextEncoder().encode(JSON.stringify(encoded)).length;
};

export interface PaginationInput {
  readonly entries: ReadonlyArray<Entry>;
  readonly leafEntryId: EntryId;
  readonly phase: Snapshot["phase"];
  readonly revision: number;
  readonly sessionId: Snapshot["sessionId"];
  readonly model?: string;
  readonly name?: string;
  readonly thinkingLevel?: Snapshot["thinkingLevel"];
  readonly capabilityGrants?: Snapshot["capabilityGrants"];
  readonly loadedGeneration?: Snapshot["loadedGeneration"];
}

export interface PaginationResult {
  readonly snapshot: Snapshot;
  readonly isPaginated: boolean;
  readonly warning: boolean;
  readonly encodedBytes: number;
}

const buildSnapshot = (
  entries: ReadonlyArray<Entry>,
  input: PaginationInput,
  entryRange: Snapshot["entryRange"],
): Snapshot =>
  SnapshotSchema.make({
    ...(input.capabilityGrants === undefined ? {} : { capabilityGrants: input.capabilityGrants }),
    entries: [...entries],
    ...(entryRange === undefined ? {} : { entryRange }),
    leafEntryId: input.leafEntryId,
    ...(input.loadedGeneration === undefined ? {} : { loadedGeneration: input.loadedGeneration }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.name === undefined ? {} : { name: input.name }),
    phase: input.phase,
    revision: input.revision,
    sessionId: input.sessionId,
    ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
  });

// Estimate bytes per entry from the branch or fallback to ~511 from report
const estimateBytesPerEntry = (_entries: ReadonlyArray<Entry>): number => 511;

const getEnvPageBytes = (): string | undefined => {
  try {
    const maybeProcess = globalThis as unknown as {
      process?: { env?: Record<string, string | undefined> };
    };
    return maybeProcess.process?.env?.PEYE_SNAPSHOT_PAGE_BYTES;
  } catch {
    return undefined;
  }
};

export const paginateSnapshot = (
  input: PaginationInput,
  pageBytes: number = resolvePageBytes(getEnvPageBytes()),
): PaginationResult => {
  const full: Snapshot = buildSnapshot(input.entries, input, undefined);
  const fullBytes = snapshotEncodedBytes(full);
  const warning = fullBytes > WARNING_BYTES;

  if (fullBytes <= pageBytes) {
    return { encodedBytes: fullBytes, isPaginated: false, snapshot: full, warning };
  }

  // Need to paginate - leaf-anchored suffix under bound, estimate-then-verify <!-- D-007 -->
  const perEntry = estimateBytesPerEntry(input.entries);
  // Also account for snapshot overhead (leafEntryId, revision etc) - conservatively leave 1 KiB overhead
  const overhead = 1024;
  const adjusted = Math.max(1, Math.floor((pageBytes - overhead) / perEntry));
  const startEstimated = Math.max(0, input.entries.length - adjusted);

  // Verify loop: try suffix from startEstimated, measure, shrink if still over
  let start = startEstimated;
  let result: Snapshot | undefined;
  let bytes = Number.POSITIVE_INFINITY;

  while (start < input.entries.length) {
    const window = input.entries.slice(start);
    // Single large entry case: if window is 1 entry and still over, deliver it anyway with diagnostic <!-- D-004 -->
    if (window.length === 1) {
      const single = buildSnapshot(window, input, {
        afterEntryId: start > 0 ? ((input.entries[start - 1]?.id as EntryId) ?? null) : null,
        beforeEntryId: null,
        hasMoreAfter: false,
        hasMoreBefore: start > 0,
      });
      const singleBytes = snapshotEncodedBytes(single);
      return { encodedBytes: singleBytes, isPaginated: true, snapshot: single, warning };
    }

    const candidate = buildSnapshot(window, input, {
      afterEntryId: start > 0 ? ((input.entries[start - 1]?.id as EntryId) ?? null) : null,
      beforeEntryId: null,
      hasMoreAfter: false,
      hasMoreBefore: start > 0,
    });
    const candidateBytes = snapshotEncodedBytes(candidate);
    if (candidateBytes <= pageBytes) {
      result = candidate;
      bytes = candidateBytes;
      break;
    }
    // Still over - move start forward (shrink window)
    // Estimate next step: how many bytes over, convert to entries
    const over = candidateBytes - pageBytes;
    const step = Math.max(1, Math.ceil(over / perEntry));
    start += step;
  }

  // Fallback - should have found a window, but if not, deliver leaf-anchored single entry
  if (result === undefined) {
    const last = input.entries.at(-1);
    if (last === undefined) {
      return { encodedBytes: fullBytes, isPaginated: false, snapshot: full, warning };
    }
    const single = buildSnapshot([last], input, {
      afterEntryId:
        input.entries.length > 1
          ? ((input.entries[input.entries.length - 2]?.id as EntryId) ?? null)
          : null,
      beforeEntryId: null,
      hasMoreAfter: false,
      hasMoreBefore: input.entries.length > 1,
    });
    const singleBytes = snapshotEncodedBytes(single);
    return { encodedBytes: singleBytes, isPaginated: true, snapshot: single, warning };
  }

  return { encodedBytes: bytes, isPaginated: true, snapshot: result, warning };
};

export const sliceSnapshotByRange = (
  input: PaginationInput,
  afterEntryId: EntryId | null | undefined,
  beforeEntryId: EntryId | null | undefined,
): { readonly snapshot: Snapshot; readonly isValid: boolean; readonly error?: string } => {
  const branch = input.entries;
  const indexById = new Map(branch.map((e, i) => [e.id as string, i]));
  let start = 0;
  let end = branch.length;

  if (afterEntryId !== undefined && afterEntryId !== null) {
    const idx = indexById.get(afterEntryId as string);
    if (idx === undefined) {
      return {
        isValid: false,
        error: `afterEntryId ${afterEntryId} not on branch`,
        snapshot: buildSnapshot([], input, undefined),
      };
    }
    start = idx + 1;
  }

  if (beforeEntryId !== undefined && beforeEntryId !== null) {
    const idx = indexById.get(beforeEntryId as string);
    if (idx === undefined) {
      return {
        isValid: false,
        error: `beforeEntryId ${beforeEntryId} not on branch`,
        snapshot: buildSnapshot([], input, undefined),
      };
    }
    end = idx;
  }

  if (start >= end) {
    return {
      isValid: false,
      error: `Range afterEntryId ${afterEntryId} before beforeEntryId ${beforeEntryId} is empty or reversed`,
      snapshot: buildSnapshot([], input, undefined),
    };
  }

  const window = branch.slice(start, end);
  const snapshot = buildSnapshot(window, input, {
    afterEntryId: start > 0 ? ((branch[start - 1]?.id as EntryId) ?? null) : (afterEntryId ?? null),
    beforeEntryId:
      end < branch.length ? ((branch[end]?.id as EntryId) ?? null) : (beforeEntryId ?? null),
    hasMoreAfter: end < branch.length,
    hasMoreBefore: start > 0,
  });

  return { isValid: true, snapshot };
};
