/**
 * Owns SnapshotView deep module for bounded Snapshot pagination.
 * It exists so leaf-anchored windowing, byte measurement, 1 MiB bound, entryRange addressing, and window reassembly hide behind one deep interface.
 *
 * Why this module: paginateSnapshot (222 lines, estimate-then-verify windowing) and reassembleSnapshots (128 lines, entryRange chain sort + identity verification) and shared.protocolSnapshot (DriverSnapshot → Snapshot conversion + warning logs) were three seams sharing the entryRange contract (afterEntryId / hasMoreBefore / leafEntryId+revision preserved). Every Head that needed a full transcript (rpc, json, print) re-derived range slicing or concatenation differently, and snapshot-size.ts duplicated SnapshotSchema.encode → JSON.stringify → UTF-8 measurement. Adding a Snapshot field touched pagination, schema, and all Heads — 6 hops for one concept.
 *
 * This module owns the one Snapshot fold: pagination (private seam: pagination.ts), range slicing (private seam: pagination.sliceSnapshotByRange), and reassembly (private seam: reassembly.ts) behind paginate / slice / reassemble. Callers depend on SnapshotView, not on entryRange flags. Byte accounting lives once via snapshotEncodedBytes.
 *
 * Not responsible for Journal persistence or compaction — those live in @dungle-scrubs/popeye-journal — or for Branch folding (SessionView/Driver own that). The seam is Snapshot bytes: two adapters justify it — LiveSnapshotView over real SnapshotSchema encoding and FakeSnapshotView over fixture Snapshot arrays in tests. Heads never touch entryRange directly.
 */

import type { EntryId } from "#journal";

import {
  snapshotEncodedBytes as encodedBytes,
  type PaginationInput,
  type PaginationResult,
  paginateSnapshot as paginate,
  resolvePageBytes as resolve,
  sliceSnapshotByRange as slice,
} from "./pagination.js";
import { isFullBranch, reassembleSnapshots as reassemble } from "./reassembly.js";
import type { Snapshot } from "./snapshot.js";

export type SnapshotPaginationInput = PaginationInput;
export type SnapshotPaginatedResult = PaginationResult;

export interface SnapshotViewService {
  /** Leaf-anchored bounded emission — enforces POPEYE_SNAPSHOT_PAGE_BYTES (default 1 MiB) with estimate-then-verify. */
  readonly paginateSnapshot: (input: PaginationInput, pageBytes?: number) => PaginationResult;
  /** Range addressing — suffix afterEntryId / prefix beforeEntryId / slice between. */
  readonly sliceSnapshotByRange: (
    input: PaginationInput,
    afterEntryId: EntryId | null | undefined,
    beforeEntryId: EntryId | null | undefined,
  ) => { readonly snapshot: Snapshot; readonly isValid: boolean; readonly error?: string };
  /** Window reassembly — concatenates paginated windows in branch order, verifies leaf+revision identity. */
  readonly reassembleSnapshots: (windows: ReadonlyArray<Snapshot>) => Snapshot;
  /** Byte measurement via SnapshotSchema encoding. */
  readonly snapshotEncodedBytes: (snapshot: Snapshot) => number;
  /** Threshold resolution for POPEYE_SNAPSHOT_PAGE_BYTES env. */
  readonly resolvePageBytes: (raw: string | undefined) => number;
  /** Branch completeness predicate. */
  readonly isFullBranch: (snapshot: Snapshot) => boolean;
}

export class SnapshotView extends globalThis.Object {
  static readonly Tag = "@dungle-scrubs/popeye-protocol/SnapshotView" as const;
}

const viewService: SnapshotViewService = {
  isFullBranch,
  paginateSnapshot: paginate,
  reassembleSnapshots: reassemble,
  resolvePageBytes: resolve,
  sliceSnapshotByRange: slice,
  snapshotEncodedBytes: encodedBytes,
};

export const snapshotView: SnapshotViewService = viewService;

/** @deprecated Use SnapshotView.paginateSnapshot via snapshotView */
export const paginateSnapshot = paginate;
/** @deprecated Use SnapshotView.sliceSnapshotByRange via snapshotView */
export const sliceSnapshotByRange = slice;
/** @deprecated Use SnapshotView.reassembleSnapshots via snapshotView */
export const reassembleSnapshots = reassemble;
/** @deprecated Use SnapshotView.snapshotEncodedBytes via snapshotView */
export const snapshotEncodedBytes = encodedBytes;
export const resolvePageBytes = resolve;

// Test helper: build a SnapshotView over a fake in-memory branch without Journal
export const makeSnapshotViewForTest = (): SnapshotViewService => viewService;
