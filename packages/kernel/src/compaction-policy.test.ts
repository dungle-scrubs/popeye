import {
  createMemoryJournalBacking,
  EntryDraftSchema,
  Journal,
  JournalMemory,
} from "@peye/journal";
import { Effect, type Exit, Layer, Stream, Tracer } from "effect";
import { expect, test } from "vitest";

import { Compaction, CompactionLive } from "./compaction-policy.js";
import { Mailbox, MailboxLive } from "./mailbox.js";
import { ProgressHubLive } from "./progress.js";
import { Provider, type ProviderService } from "./provider.js";

interface CapturedSpan {
  readonly attributes: Map<string, unknown>;
  exit: Exit.Exit<unknown, unknown> | undefined;
  readonly name: string;
}

const tracerLayer = (spans: Array<CapturedSpan>): Layer.Layer<never> => {
  const tracer = Tracer.make({
    context: (evaluate) => evaluate(),
    span: (name, parent, context, links, startTime, kind, options) => {
      const captured: CapturedSpan = {
        attributes: new Map(Object.entries(options?.attributes ?? {})),
        exit: undefined,
        name,
      };
      spans.push(captured);
      return {
        _tag: "Span",
        addLinks: () => undefined,
        attribute: (key, value) => captured.attributes.set(key, value),
        attributes: captured.attributes,
        context,
        end: (_endTime, exit) => {
          captured.exit = exit;
        },
        event: () => undefined,
        kind,
        links,
        name,
        parent,
        sampled: true,
        spanId: `${spans.length}`,
        status: { _tag: "Started", startTime },
        traceId: "captured",
      } satisfies Tracer.Span;
    },
  });
  return Layer.merge(Layer.setTracer(tracer), Layer.setTracerEnabled(true));
};

test("manual Compaction compactNow runs through the mailbox with span diagnostics", async () => {
  const spans: Array<CapturedSpan> = [];
  const provider: ProviderService = {
    streamAssistant: () =>
      Stream.fromIterable([
        { _tag: "textDelta" as const, text: "manual summary" },
        { _tag: "done" as const, stopReason: "done" as const },
      ]),
  };
  const journalLayer = JournalMemory(createMemoryJournalBacking());
  const mailboxLayer = MailboxLive().pipe(Layer.provide(journalLayer));
  const dependencies = Layer.mergeAll(
    journalLayer,
    mailboxLayer,
    ProgressHubLive(),
    Layer.succeed(Provider, provider),
  );
  const layer = Layer.mergeAll(
    dependencies,
    CompactionLive({ retainedTailCount: 0, sliceBudget: 64 }).pipe(Layer.provide(dependencies)),
  );

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const compaction = yield* Compaction;
      const journal = yield* Journal;
      const mailbox = yield* Mailbox;
      const session = yield* journal.createSession();
      yield* mailbox.activate(session.id);
      yield* journal.appendEntry(
        session.id,
        EntryDraftSchema.make({
          kind: "message",
          payload: { content: "Manual Context.", role: "user" },
        }),
      );
      const compacted = yield* compaction.compactNow(session.id);
      return { branch: yield* journal.readBranch(session.id), compacted };
    }).pipe(Effect.provide(layer), Effect.provide(tracerLayer(spans))),
  );

  expect(result.branch.filter((entry) => entry.kind === "compaction")).toHaveLength(1);
  const commandSpan = spans.find(
    (span) => span.name === "kernel.command" && span.attributes.get("command") === "compact",
  );
  expect(commandSpan).toBeDefined();
  const compactionSpan = spans.find((span) => span.name === "kernel.compaction");
  expect(compactionSpan?.attributes.get("entriesCovered")).toBe(1);
  expect(compactionSpan?.attributes.get("sessionId")).toEqual(expect.any(String));
  expect(compactionSpan?.attributes.get("sliceCount")).toBe(1);
  expect(compactionSpan?.attributes.get("summaryLength")).toBe(14);
  expect(result.compacted).toMatchObject({
    entriesCovered: 1,
    sliceCount: 1,
    summaryLength: 14,
  });
});
