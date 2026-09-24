/**
 * Owns Compaction policy composed around turn execution.
 * It exists because Compaction is policy composed around the turn so the kernel core stays
 * policy-free.
 * In-turn Compaction remains in ASSEMBLING because it is Context assembly. Manual compactNow
 * publishes progress items without changing the session phase because it is not a turn.
 */

import {
  type CompactionPayload,
  type Entry,
  EntryIdSchema,
  Journal,
  type JournalFailure,
  type JournalService,
  type SessionId,
} from "@dungle-scrubs/popeye-journal";
import { Context, Effect, Layer, Schema, Stream } from "effect";

import { CompactionDisabled, NothingToCompact, ProviderError } from "./errors.js";
import { Mailbox, type MailboxFailure } from "./mailbox.js";
import { ProgressHub, type ProgressService } from "./progress.js";
import {
  asContextToolCalls,
  type ContextItem,
  Provider,
  type ProviderService,
} from "./provider.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_PROVIDER_ROUNDS,
  makeProviderRequestRuntime,
  type ProviderRequestRuntime,
} from "./provider-retry.js";

const MINIMUM_SLICE_BUDGET = 200;
const PRIOR_SUMMARY_LABEL = "Prior summary:\n";
const DEFAULT_SUMMARIZATION_INSTRUCTION =
  "Summarize the conversation while preserving decisions, open tool state, file paths, and user intent.";

export const CompactionPolicyOptionsSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  retainedTailCount: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
  sliceBudget: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  /** System instruction repeated on every bounded summarization slice. */
  summarizationInstruction: Schema.optional(Schema.String),
});

export type CompactionPolicyOptions = Schema.Schema.Type<typeof CompactionPolicyOptionsSchema>;

export interface ResolvedCompactionPolicyOptions {
  readonly enabled: boolean;
  readonly retainedTailCount: number;
  readonly sliceBudget: number;
  readonly summarizationInstruction: string;
}

export const CompactionResultSchema = Schema.Struct({
  compactionEntryId: EntryIdSchema,
  entriesCovered: Schema.Number.pipe(Schema.int(), Schema.positive()),
  sliceCount: Schema.Number.pipe(Schema.int(), Schema.positive()),
  summaryLength: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});

export type CompactionResult = Schema.Schema.Type<typeof CompactionResultSchema>;

export interface CompactBranchInput {
  readonly journal: JournalService;
  readonly options: ResolvedCompactionPolicyOptions;
  readonly progress: ProgressService;
  readonly provider: ProviderService;
  readonly providerRuntime?: ProviderRequestRuntime;
  readonly sessionId: SessionId;
  readonly turnOrdinal: number;
}

export interface CompactionService {
  readonly compactNow: (
    sessionId: SessionId,
    expectedRevision?: number,
  ) => Effect.Effect<CompactionResult, CompactionFailure>;
  readonly policy: ResolvedCompactionPolicyOptions;
}

export type CompactionFailure =
  | CompactionDisabled
  | JournalFailure
  | MailboxFailure
  | NothingToCompact
  | ProviderError;

export class Compaction extends Context.Tag("@dungle-scrubs/popeye-kernel/Compaction")<
  Compaction,
  CompactionService
>() {}

export const DEFAULT_COMPACTION_POLICY: ResolvedCompactionPolicyOptions = {
  enabled: true,
  retainedTailCount: 1,
  sliceBudget: 8_000,
  summarizationInstruction: DEFAULT_SUMMARIZATION_INSTRUCTION,
};

const validateNonNegativeInteger = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
};

const validateSliceBudget = (value: number, instruction: string): void => {
  if (!Number.isSafeInteger(value) || value < MINIMUM_SLICE_BUDGET) {
    throw new RangeError(
      `Compaction slice budget must be a safe integer of at least ${MINIMUM_SLICE_BUDGET}.`,
    );
  }
  if (instruction.length >= value) {
    throw new RangeError("Compaction summarization instruction must be shorter than slice budget.");
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
    summarizationInstruction:
      turnOptions.summarizationInstruction ??
      layerOptions.summarizationInstruction ??
      DEFAULT_COMPACTION_POLICY.summarizationInstruction,
  };
  if (options.summarizationInstruction.trim().length === 0) {
    throw new RangeError("Compaction summarization instruction must be non-empty.");
  }
  validateNonNegativeInteger("Compaction retained-tail count", options.retainedTailCount);
  validateSliceBudget(options.sliceBudget, options.summarizationInstruction);
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

interface CompactionFragmentSource {
  readonly content: string;
}

const priorSummary = (entry: Entry | undefined): CompactionFragmentSource | undefined => {
  if (entry?.kind !== "compaction" || typeof entry.payload !== "object" || entry.payload === null) {
    return undefined;
  }
  const payload = entry.payload as Partial<CompactionPayload>;
  return typeof payload.summary === "string"
    ? { content: `${PRIOR_SUMMARY_LABEL}${payload.summary}` }
    : undefined;
};

const boundedSlices = (
  sources: ReadonlyArray<CompactionFragmentSource>,
  sliceBudget: number,
  instruction: string,
): ReadonlyArray<ReadonlyArray<ContextItem>> => {
  const slices: Array<Array<ContextItem>> = [];
  let current: Array<ContextItem> = [{ content: instruction, role: "system" }];
  let used = instruction.length;
  for (const source of sources) {
    if (source.content.length === 0) {
      current.push({ content: "", role: "user" });
      continue;
    }
    let offset = 0;
    while (offset < source.content.length) {
      if (used === sliceBudget) {
        slices.push(current);
        current = [{ content: instruction, role: "system" }];
        used = instruction.length;
      }
      const length = Math.min(sliceBudget - used, source.content.length - offset);
      current.push({ content: source.content.slice(offset, offset + length), role: "user" });
      offset += length;
      used += length;
    }
    if (used === sliceBudget) {
      slices.push(current);
      current = [{ content: instruction, role: "system" }];
      used = instruction.length;
    }
  }
  if (current.length > 1 || slices.length === 0) {
    slices.push(current);
  }
  return slices;
};

const summarizeSlice = (
  provider: ProviderService,
  providerRuntime: ProviderRequestRuntime,
  context: ReadonlyArray<ContextItem>,
  sliceIndex: number,
  turnOrdinal: number,
): Effect.Effect<string, ProviderError> =>
  providerRuntime.run((attempt) =>
    Effect.gen(function* () {
      let summary = "";
      let completed = false;
      yield* Stream.runForEach(
        provider.streamAssistant(context, {
          attempt,
          purpose: "compaction",
          sliceIndex,
          turnOrdinal,
        }),
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
    }),
  );

const retainedTail = (branch: ReadonlyArray<Entry>, count: number): ReadonlyArray<Entry> => {
  if (count === 0) {
    return [];
  }
  let start = Math.max(0, branch.length - count);
  const firstItem = entryToContextItem(branch[start] as Entry);
  if (firstItem?.role === "user") {
    return branch.slice(start);
  }
  if (
    firstItem?.role === "assistant" &&
    firstItem.toolCalls !== undefined &&
    branch.slice(start + 1).some((entry) => {
      const item = entryToContextItem(entry);
      return (
        item?.role === "toolResult" &&
        firstItem.toolCalls?.some((call) => call.id === item.toolCallId) === true
      );
    })
  ) {
    return branch.slice(start);
  }
  if (firstItem?.role === "toolResult") {
    for (let index = start - 1; index >= 0; index -= 1) {
      const item = entryToContextItem(branch[index] as Entry);
      if (
        item?.role === "assistant" &&
        item.toolCalls?.some((call) => call.id === firstItem.toolCallId) === true
      ) {
        start = index;
        return branch.slice(start);
      }
      if (item?.role === "user") {
        start = index;
        return branch.slice(start);
      }
    }
  }
  for (let index = start - 1; index >= 0; index -= 1) {
    if (entryToContextItem(branch[index] as Entry)?.role === "user") {
      start = index;
      break;
    }
  }
  return branch.slice(start);
};

export const compactBranch = (
  input: CompactBranchInput,
): Effect.Effect<
  CompactionResult,
  CompactionDisabled | JournalFailure | NothingToCompact | ProviderError
> =>
  Effect.gen(function* () {
    if (!input.options.enabled) {
      return yield* new CompactionDisabled({
        message: "Compaction is disabled by policy.",
        sessionId: input.sessionId,
      });
    }
    const branch = yield* input.journal.readBranch(input.sessionId);
    const newestCompactionIndex = branch.findLastIndex((entry) => entry.kind === "compaction");
    const unsummarized = branch.slice(newestCompactionIndex < 0 ? 1 : newestCompactionIndex + 1);
    const first = unsummarized[0];
    const last = unsummarized.at(-1);
    if (first === undefined || last === undefined) {
      return yield* new NothingToCompact({
        message: "Compaction requires at least one unsummarized Entry.",
        sessionId: input.sessionId,
      });
    }
    const providerRuntime =
      input.providerRuntime ??
      (yield* makeProviderRequestRuntime({
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        maxProviderRounds: DEFAULT_MAX_PROVIDER_ROUNDS,
        onRetry: (attempt, delayMs) =>
          input.progress.publish(input.sessionId, {
            _tag: "providerRetryScheduled",
            attempt,
            delayMs,
          }),
      }));
    const sources = [
      ...(newestCompactionIndex < 0
        ? []
        : [priorSummary(branch[newestCompactionIndex])].filter(
            (item): item is CompactionFragmentSource => item !== undefined,
          )),
      ...unsummarized.flatMap((entry): ReadonlyArray<CompactionFragmentSource> => {
        const item = entryToContextItem(entry);
        return item === undefined ? [] : [{ content: item.content }];
      }),
    ];
    const slices = boundedSlices(
      sources,
      input.options.sliceBudget,
      input.options.summarizationInstruction,
    );
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
      (slice, index) =>
        summarizeSlice(input.provider, providerRuntime, slice, index + 1, input.turnOrdinal),
      { concurrency: 1 },
    );
    const summary = summaries.join("\n");
    yield* Effect.annotateCurrentSpan({ summaryLength: summary.length });
    const retainedTailIds = retainedTail(unsummarized, input.options.retainedTailCount).map(
      (entry) => entry.id,
    );
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
        compactNow: (sessionId, expectedRevision) =>
          mailbox
            .enqueue(sessionId, {
              ...(expectedRevision === undefined ? {} : { expectedRevision }),
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
        policy: resolved,
      });
    }),
  );
};
