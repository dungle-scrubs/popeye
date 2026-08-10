/**
 * Owns overflow Compaction policy composed around a turn, not Kernel logic.
 * It exists because D-028 span totality belongs to Journal validation.
 */

import {
  type Entry,
  type EntryId,
  Journal,
  type JournalFailure,
  type JournalService,
  type SessionId,
} from "@peye/journal";
import { Context, Effect, Layer, Stream } from "effect";

import { ProviderError } from "./errors.js";
import { Mailbox, type MailboxFailure } from "./mailbox.js";
import { ProgressHub, type ProgressService } from "./progress.js";
import {
  asContextToolCalls,
  type ContextItem,
  Provider,
  type ProviderService,
} from "./provider.js";

const COMPACTION_INSTRUCTION = "Summarize.";

export interface CompactionPolicyOptions {
  readonly enabled?: boolean;
  readonly retainedTailCount?: number;
  readonly sliceBudget?: number;
}

export interface ResolvedCompactionPolicyOptions {
  readonly enabled: boolean;
  readonly retainedTailCount: number;
  readonly sliceBudget: number;
}

export interface CompactionResult {
  readonly compactionEntryId: EntryId;
  readonly entriesCovered: number;
  readonly sliceCount: number;
  readonly summaryLength: number;
}

export interface CompactBranchInput {
  readonly journal: JournalService;
  readonly options: ResolvedCompactionPolicyOptions;
  readonly progress: ProgressService;
  readonly provider: ProviderService;
  readonly sessionId: SessionId;
  readonly turnOrdinal: number;
}

export interface CompactionService {
  readonly compactNow: (sessionId: SessionId) => Effect.Effect<CompactionResult, CompactionFailure>;
}

export type CompactionFailure = JournalFailure | MailboxFailure | ProviderError;

export class Compaction extends Context.Tag("@peye/kernel/Compaction")<
  Compaction,
  CompactionService
>() {}

export const DEFAULT_COMPACTION_POLICY: ResolvedCompactionPolicyOptions = {
  enabled: true,
  retainedTailCount: 1,
  sliceBudget: 8_000,
};

const validateNonNegativeInteger = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
};

const validateSliceBudget = (value: number): void => {
  if (!Number.isSafeInteger(value) || value <= COMPACTION_INSTRUCTION.length) {
    throw new RangeError(
      `Compaction slice budget must be a safe integer greater than ${COMPACTION_INSTRUCTION.length}.`,
    );
  }
};

export const resolveCompactionPolicyOptions = (
  layerOptions: CompactionPolicyOptions = {},
  turnOptions: CompactionPolicyOptions = {},
): ResolvedCompactionPolicyOptions => {
  const options = {
    enabled: turnOptions.enabled ?? layerOptions.enabled ?? DEFAULT_COMPACTION_POLICY.enabled,
    retainedTailCount:
      turnOptions.retainedTailCount ??
      layerOptions.retainedTailCount ??
      DEFAULT_COMPACTION_POLICY.retainedTailCount,
    sliceBudget:
      turnOptions.sliceBudget ?? layerOptions.sliceBudget ?? DEFAULT_COMPACTION_POLICY.sliceBudget,
  };
  validateNonNegativeInteger("Compaction retained-tail count", options.retainedTailCount);
  validateSliceBudget(options.sliceBudget);
  return options;
};

export const entryToContextItem = (entry: Entry): ContextItem | undefined => {
  if (entry.kind !== "message" || typeof entry.payload !== "object" || entry.payload === null) {
    return undefined;
  }
  const payload = entry.payload as {
    readonly content?: unknown;
    readonly isError?: unknown;
    readonly role?: unknown;
    readonly toolCallId?: unknown;
    readonly toolCalls?: unknown;
    readonly toolName?: unknown;
  };
  if (typeof payload.content !== "string" || typeof payload.role !== "string") {
    return undefined;
  }
  if (payload.role === "assistant") {
    const calls = asContextToolCalls(payload.toolCalls);
    return calls === undefined
      ? { content: payload.content, role: payload.role }
      : { content: payload.content, role: payload.role, toolCalls: calls };
  }
  if (
    payload.role === "toolResult" &&
    typeof payload.toolCallId === "string" &&
    typeof payload.toolName === "string"
  ) {
    return {
      content: payload.content,
      isError: payload.isError === true,
      role: payload.role,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
    };
  }
  return payload.role === "system" || payload.role === "user"
    ? { content: payload.content, role: payload.role }
    : undefined;
};

const withContent = (item: ContextItem, content: string): ContextItem => ({ ...item, content });

const boundedSlices = (
  branch: ReadonlyArray<Entry>,
  sliceBudget: number,
): ReadonlyArray<ReadonlyArray<ContextItem>> => {
  const contentBudget = sliceBudget - COMPACTION_INSTRUCTION.length;
  const fragments = branch.flatMap((entry): ReadonlyArray<ContextItem> => {
    const item = entryToContextItem(entry);
    if (item === undefined) {
      return [];
    }
    if (item.content.length === 0) {
      return [item];
    }
    const parts: Array<ContextItem> = [];
    for (let offset = 0; offset < item.content.length; offset += contentBudget) {
      parts.push(withContent(item, item.content.slice(offset, offset + contentBudget)));
    }
    return parts;
  });
  const slices: Array<Array<ContextItem>> = [];
  let current: Array<ContextItem> = [{ content: COMPACTION_INSTRUCTION, role: "system" }];
  let used = COMPACTION_INSTRUCTION.length;
  for (const fragment of fragments) {
    if (current.length > 1 && used + fragment.content.length > sliceBudget) {
      slices.push(current);
      current = [{ content: COMPACTION_INSTRUCTION, role: "system" }];
      used = COMPACTION_INSTRUCTION.length;
    }
    current.push(fragment);
    used += fragment.content.length;
  }
  if (current.length > 1 || slices.length === 0) {
    slices.push(current);
  }
  return slices;
};

const summarizeSlice = (
  provider: ProviderService,
  context: ReadonlyArray<ContextItem>,
  attempt: number,
  turnOrdinal: number,
): Effect.Effect<string, ProviderError> =>
  Effect.gen(function* () {
    let summary = "";
    let completed = false;
    yield* Stream.runForEach(
      provider.streamAssistant(context, { attempt, purpose: "compaction", turnOrdinal }),
      (item) => {
        if (item._tag === "textDelta") {
          summary += item.text;
        }
        if (item._tag === "done") {
          completed = item.stopReason === "done";
        }
        return Effect.void;
      },
    );
    if (!completed || summary.trim().length === 0) {
      return yield* new ProviderError({
        message: "Provider did not return a non-empty Compaction summary.",
        transient: false,
      });
    }
    return summary;
  });

export const compactBranch = (
  input: CompactBranchInput,
): Effect.Effect<CompactionResult, JournalFailure | ProviderError> =>
  Effect.gen(function* () {
    const branch = yield* input.journal.readBranch(input.sessionId);
    const newestCompactionIndex = branch.findLastIndex((entry) => entry.kind === "compaction");
    const unsummarized = branch.slice(newestCompactionIndex < 0 ? 1 : newestCompactionIndex + 1);
    const first = unsummarized[0];
    const last = unsummarized.at(-1);
    if (first === undefined || last === undefined) {
      return yield* new ProviderError({
        message: "Compaction requires at least one unsummarized Entry.",
        transient: false,
      });
    }
    const slices = boundedSlices(unsummarized, input.options.sliceBudget);
    const started = {
      entriesCovered: unsummarized.length,
      sliceCount: slices.length,
    };
    yield* Effect.annotateCurrentSpan(started);
    yield* input.progress.publish(input.sessionId, {
      _tag: "compactionStarted",
      ...started,
    });
    const summaries = yield* Effect.forEach(
      slices,
      (slice, index) => summarizeSlice(input.provider, slice, index + 1, input.turnOrdinal),
      { concurrency: 1 },
    );
    const summary = summaries.join("\n");
    yield* Effect.annotateCurrentSpan({ summaryLength: summary.length });
    const retainedTailIds = unsummarized
      .slice(Math.max(0, unsummarized.length - input.options.retainedTailCount))
      .map((entry) => entry.id);
    const compaction = yield* input.journal.appendCompaction(input.sessionId, {
      firstSummarizedId: first.id,
      lastSummarizedId: last.id,
      retainedTailIds,
      summary,
    });
    const result = {
      compactionEntryId: compaction.id,
      ...started,
      summaryLength: summary.length,
    } satisfies CompactionResult;
    yield* input.progress.publish(input.sessionId, {
      _tag: "compactionApplied",
      ...result,
    });
    return result;
  }).pipe(
    Effect.withSpan("kernel.compaction", {
      attributes: { sessionId: input.sessionId },
    }),
  );

export const CompactionLive = (
  options: CompactionPolicyOptions = {},
): Layer.Layer<Compaction, never, Journal | Mailbox | ProgressHub | Provider> => {
  const resolved = resolveCompactionPolicyOptions(options);
  return Layer.effect(
    Compaction,
    Effect.gen(function* () {
      const journal = yield* Journal;
      const mailbox = yield* Mailbox;
      const progress = yield* ProgressHub;
      const provider = yield* Provider;
      return Compaction.of({
        compactNow: (sessionId) =>
          mailbox
            .enqueue(sessionId, {
              name: "compact",
              run: () =>
                compactBranch({
                  journal,
                  options: resolved,
                  progress,
                  provider,
                  sessionId,
                  turnOrdinal: 0,
                }),
            })
            .pipe(Effect.map((result) => result.value)),
      });
    }),
  );
};
