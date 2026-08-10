/**
 * Owns the Journal interface and its tree rules independently from durable adapters.
 * It exists so callers and conformance checks use one seam for every Journal implementation.
 */
import { Context, type Effect } from "effect";

import type { JournalNotFound } from "./errors.js";
import type { Entry, EntryDraft, JournalLine, Record, RecordDraft } from "./shapes.js";

export interface CreatedSession {
  readonly id: string;
  readonly rootEntry: Entry;
}

export interface JournalService {
  readonly appendEntry: (
    sessionId: string,
    entry: EntryDraft,
  ) => Effect.Effect<Entry, JournalNotFound>;
  readonly appendRecord: (
    sessionId: string,
    record: RecordDraft,
  ) => Effect.Effect<Record, JournalNotFound>;
  readonly createSession: () => Effect.Effect<CreatedSession>;
  readonly getLeaf: (sessionId: string) => Effect.Effect<Entry, JournalNotFound>;
  readonly listSessions: () => Effect.Effect<ReadonlyArray<CreatedSession>>;
  readonly moveLeaf: (
    sessionId: string,
    toEntryId: string,
  ) => Effect.Effect<Record, JournalNotFound>;
  readonly readBranch: (sessionId: string) => Effect.Effect<ReadonlyArray<Entry>, JournalNotFound>;
  readonly readRecords: (
    sessionId: string,
  ) => Effect.Effect<ReadonlyArray<Record>, JournalNotFound>;
}

export class Journal extends Context.Tag("@peye/journal/Journal")<Journal, JournalService>() {}

export const isEntry = (item: Entry | Record): item is Entry => "parentId" in item;

export const entriesFor = (lines: ReadonlyArray<JournalLine>): ReadonlyArray<Entry> =>
  lines.flatMap((line) => (isEntry(line.item) ? [line.item] : []));

export const recordsFor = (lines: ReadonlyArray<JournalLine>): ReadonlyArray<Record> =>
  lines.flatMap((line) => (isEntry(line.item) ? [] : [line.item]));

export const leafFor = (lines: ReadonlyArray<JournalLine>): Entry | undefined => {
  const entries = new Map(entriesFor(lines).map((entry) => [entry.id, entry]));
  let leaf: Entry | undefined;

  for (const { item } of lines) {
    if (isEntry(item)) {
      leaf = item;
      continue;
    }

    if (item.kind === "leaf_moved" && typeof item.payload === "object" && item.payload !== null) {
      const toEntryId = (item.payload as { readonly toEntryId?: unknown }).toEntryId;
      if (typeof toEntryId === "string") {
        leaf = entries.get(toEntryId) ?? leaf;
      }
    }
  }

  return leaf;
};

export const branchFor = (lines: ReadonlyArray<JournalLine>): ReadonlyArray<Entry> => {
  const entries = new Map(entriesFor(lines).map((entry) => [entry.id, entry]));
  const branch: Array<Entry> = [];
  let entry = leafFor(lines);

  while (entry !== undefined) {
    branch.push(entry);
    entry = entry.parentId === null ? undefined : entries.get(entry.parentId);
  }

  return branch.reverse();
};
