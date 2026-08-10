/**
 * Owns the Context fold and why model visibility is decided in one place.
 * It exists so a Branch has one deterministic model-visible sequence under a budget.
 * Records cannot enter this fold by construction because its input contains only Entry values.
 */
import { Effect } from "effect";

import { ContextBudgetExceeded } from "./errors.js";
import type { CompactionPayload, Entry, EntryId } from "./shapes.js";

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
  readonly sizeOf?: (entry: Entry) => number;
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

const isCompaction = (entry: Entry): entry is Entry & { readonly payload: CompactionPayload } =>
  entry.kind === "compaction";

const visibleEntries = (
  entries: ReadonlyArray<Entry>,
  visibility: FoldOptions["visibility"],
): ReadonlyArray<VisibleEntry> =>
  entries.flatMap((entry): ReadonlyArray<VisibleEntry> => {
    if (entry.kind === "session_root" || isCompaction(entry)) {
      return [];
    }
    const item = visibility(entry);
    return item === undefined ? [] : [{ entry, item }];
  });

interface CompactionScope {
  readonly compaction: (Entry & { readonly payload: CompactionPayload }) | undefined;
  readonly later: ReadonlyArray<Entry>;
}

const newestCompactionScope = (branch: ReadonlyArray<Entry>): CompactionScope => {
  const later: Array<Entry> = [];
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry === undefined) {
      continue;
    }
    if (isCompaction(entry)) {
      return { compaction: entry, later: later.reverse() };
    }
    later.push(entry);
  }
  return { compaction: undefined, later: later.reverse() };
};

export const foldContext = (
  branch: ReadonlyArray<Entry>,
  options: FoldOptions,
): Effect.Effect<FoldResult, ContextBudgetExceeded> =>
  Effect.suspend(() => {
    const { compaction, later } = newestCompactionScope(branch);
    const retained =
      compaction === undefined
        ? []
        : compaction.payload.retainedTailIds.flatMap((id): ReadonlyArray<Entry> => {
            const entry = branch.find((candidate) => candidate.id === id);
            return entry === undefined ? [] : [entry];
          });
    const retainedItems = visibleEntries(retained, options.visibility);
    const laterItems = visibleEntries(later, options.visibility);
    const summary =
      compaction === undefined
        ? []
        : [{ entry: compaction, item: { content: compaction.payload.summary, role: "system" } }];
    const included = [...summary, ...retainedItems, ...laterItems];
    const usedBudget = included.reduce(
      (total, candidate) =>
        total + (options.sizeOf?.(candidate.entry) ?? candidate.item.content.length),
      0,
    );

    if (usedBudget > options.budget) {
      return Effect.fail(
        new ContextBudgetExceeded({
          budget: options.budget,
          optionsDiagnostic: "branch, manual truncation",
          required: usedBudget,
        }),
      );
    }

    return Effect.succeed({
      accounting:
        compaction === undefined
          ? { usedBudget }
          : { compactionApplied: compaction.id, usedBudget },
      items: included.map((candidate) => candidate.item),
    });
  });
