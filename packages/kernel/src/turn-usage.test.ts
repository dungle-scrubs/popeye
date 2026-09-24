import { createMemoryJournalBacking, Journal, JournalMemory } from "@dungle-scrubs/popeye-journal";
import { Effect, Layer, Stream } from "effect";
import { expect, test } from "vitest";

import { CompactionLive, type CompactionPolicyOptions } from "./compaction-policy.js";
import { ProviderError } from "./errors.js";
import { MailboxLive } from "./mailbox.js";
import { PluginHostNone } from "./plugin-host.js";
import { ProgressHubLive } from "./progress.js";
import type { AssistantItem, ProviderService } from "./provider.js";
import { Provider } from "./provider.js";
import { Sessions, SessionsLive } from "./sessions.js";
import { ToolRegistryLive } from "./tool.js";
import { TurnOrchestrator, TurnOrchestratorLive } from "./turn-orchestrator.js";

const providerLayer = (service: ProviderService) => Layer.succeed(Provider, service);

const testLayer = (service: ProviderService, compactionOptions: CompactionPolicyOptions = {}) => {
  const journalLayer = JournalMemory(createMemoryJournalBacking());
  const mailboxLayer = MailboxLive().pipe(Layer.provide(journalLayer));
  const sessionsLayer = SessionsLive().pipe(
    Layer.provide(Layer.mergeAll(journalLayer, mailboxLayer, ToolRegistryLive([]))),
  );
  const dependencies = Layer.mergeAll(
    journalLayer,
    mailboxLayer,
    ProgressHubLive(),
    providerLayer(service),
    ToolRegistryLive([]),
  );
  const compactionLayer = CompactionLive(compactionOptions).pipe(Layer.provide(dependencies));
  const turnDependencies = Layer.mergeAll(dependencies, compactionLayer, PluginHostNone);
  return Layer.mergeAll(
    turnDependencies,
    sessionsLayer,
    TurnOrchestratorLive().pipe(Layer.provide(turnDependencies)),
  );
};

test("terminal usage reaches the provider_error diagnostic detail", async () => {
  const items: ReadonlyArray<AssistantItem> = [
    { _tag: "textDelta", text: "Partial." },
    {
      _tag: "done",
      stopReason: "toolCalls",
      usage: { contextWindowTokens: 128_000, inputTokens: 90_000, source: "provider" },
    },
  ];
  const provider: ProviderService = {
    streamAssistant: () =>
      Stream.fromIterable(items).pipe(
        Stream.concat(
          Stream.fail(new ProviderError({ message: "Upstream overflow.", transient: false })),
        ),
      ),
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;
      const sessions = yield* Sessions;
      const orchestrator = yield* TurnOrchestrator;
      const session = yield* sessions.create();
      const settled = yield* orchestrator.openTurn(session.id, "Use a tool", undefined, {});
      return { branch: yield* journal.readBranch(session.id), settled };
    }).pipe(Effect.provide(testLayer(provider))),
  );

  expect(result.settled).toEqual({ stopReason: "error" });
  expect(result.branch.at(-1)).toMatchObject({
    payload: {
      diagnostic: {
        detail: expect.stringContaining("prompt ~90000 tokens of 128000, measured by provider"),
        reason: "provider_error",
      },
    },
  });
});
