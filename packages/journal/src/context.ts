/**
 * Owns the Context fold and why model visibility is decided in one place.
 * It exists so a Branch has one deterministic model-visible sequence under a budget.
 * Records cannot enter this fold by construction because its input contains only Entry values.
 * The fold decides root exclusion and compaction position; callers shape every visible item,
 * including compaction summaries.
 */
import { Effect, Schema } from "effect";

import { ContextBudgetExceeded, JournalError } from "./errors.js";
import {
  type CompactionEntry,
  CompactionEntrySchema,
  type CompactionPayload,
  CompactionPayloadSchema,
  type Entry,
  type EntryId,
} from "./shapes.js";

const strict: { readonly onExcessProperty: "error" } = { onExcessProperty: "error" };
const decodeCompactionEntry = (input: unknown): Effect.Effect<CompactionEntry, unknown> =>
  Schema.decodeUnknown(CompactionEntrySchema, strict)(input);
const decodeCompactionPayload = Schema.decodeUnknown(CompactionPayloadSchema, strict);

export interface ContextItem {
  readonly content: string;
  readonly role: string;
}

export interface FoldAccounting {
  readonly compactionApplied?: EntryId;
  readonly usedBudget: number;
}

export interface FoldOptions {
  readonly budget: number;
  /** A negative or non-finite result is a programmer defect and terminates the fold. */
  readonly sizeOf?: (entry: Entry) => number;
  readonly summaryItem?: (payload: CompactionPayload) => ContextItem;
  readonly visibility: (entry: Entry) => ContextItem | undefined;
}

export interface FoldResult {
  readonly accounting: FoldAccounting;
  readonly items: ReadonlyArray<ContextItem>;
}

interface VisibleEntry {
  readonly entry: Entry;
  readonly item: ContextItem;
}

const invalidCompaction = (message: string, cause?: unknown): JournalError =>
  new JournalError({
    ...(cause === undefined ? {} : { cause }),
    corruptionClass: "invalid_compaction",
    message,
  });

const visibleEntries = (
  entries: ReadonlyArray<Entry>,
  visibility: FoldOptions["visibility"],
): ReadonlyArray<VisibleEntry> =>
  entries.flatMap((entry): ReadonlyArray<VisibleEntry> => {
    if (entry.kind === "session_root" || entry.kind === "compaction") {
      return [];
    }
    const item = visibility(entry);
    return item === undefined ? [] : [{ entry, item }];
  });

interface CompactionScope {
  readonly compaction: Entry | undefined;
  readonly compactionIndex: number;
  readonly later: ReadonlyArray<Entry>;
}

const newestCompactionScope = (branch: ReadonlyArray<Entry>): CompactionScope => {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.kind === "compaction") {
      return { compaction: entry, compactionIndex: index, later: branch.slice(index + 1) };
    }
  }
  return { compaction: undefined, compactionIndex: -1, later: branch };
};

const defaultSummaryItem = (payload: CompactionPayload): ContextItem => ({
  content: payload.summary,
  role: "system",
});

export const foldContext = (
  branch: ReadonlyArray<Entry>,
  options: FoldOptions,
): Effect.Effect<FoldResult, ContextBudgetExceeded | JournalError> =>
  Effect.gen(function* () {
    const { compaction, compactionIndex, later } = newestCompactionScope(branch);
    if (compaction === undefined) {
      return yield* completeFold([], visibleEntries(later, options.visibility), options, undefined);
    }

    const decoded = yield* decodeCompactionEntry(compaction).pipe(
      Effect.mapError((cause) =>
        invalidCompaction(`Compaction entry ${compaction.id} has an invalid payload.`, cause),
      ),
    );
    const payload = yield* decodeCompactionPayload(decoded.payload).pipe(
      Effect.mapError((cause) =>
        invalidCompaction(`Compaction entry ${decoded.id} has an invalid payload.`, cause),
      ),
    );
    const retainedIds = new Set(payload.retainedTailIds);
    for (const retainedTailId of payload.retainedTailIds) {
      const retainedIndex = branch.findIndex((entry) => entry.id === retainedTailId);
      if (retainedIndex < 0 || retainedIndex >= compactionIndex) {
        return yield* Effect.fail(
          invalidCompaction(
            `Compaction entry ${decoded.id} retains unresolved entry ${retainedTailId}.`,
          ),
        );
      }
    }

    // The durable payload is validated in branch order, but replayed content can be corrupt.
    // Select from the branch so the fold remains deterministic even for that content.
    const retained = branch.slice(0, compactionIndex).filter((entry) => retainedIds.has(entry.id));
    const retainedItems = visibleEntries(retained, options.visibility);
    const laterItems = visibleEntries(later, options.visibility);
    const summaryItem = (options.summaryItem ?? defaultSummaryItem)(payload);
    return yield* completeFold(
      [{ entry: decoded, item: summaryItem }],
      [...retainedItems, ...laterItems],
      options,
      decoded.id,
    );
  });

const completeFold = (
  prefix: ReadonlyArray<VisibleEntry>,
  entries: ReadonlyArray<VisibleEntry>,
  options: FoldOptions,
  compactionApplied: EntryId | undefined,
): Effect.Effect<FoldResult, ContextBudgetExceeded> =>
  Effect.gen(function* () {
    const included = [...prefix, ...entries];
    let usedBudget = 0;
    for (const candidate of included) {
      const size = options.sizeOf?.(candidate.entry) ?? candidate.item.content.length;
      if (!Number.isFinite(size) || size < 0) {
        return yield* Effect.die(
          `foldContext sizeOf must return a finite, non-negative number for entry ${candidate.entry.id}; received ${String(size)}.`,
        );
      }
      usedBudget += size;
    }

    if (usedBudget > options.budget) {
      return yield* Effect.fail(
        new ContextBudgetExceeded({
          ...(compactionApplied === undefined ? {} : { compactionApplied }),
          budget: options.budget,
          optionsDiagnostic: "branch to an earlier entry or start a new session",
          required: usedBudget,
        }),
      );
    }

    return {
      accounting:
        compactionApplied === undefined ? { usedBudget } : { compactionApplied, usedBudget },
      items: included.map((candidate) => candidate.item),
    };
  });
