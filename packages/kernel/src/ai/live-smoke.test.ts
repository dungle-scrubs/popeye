/**
 * Owns the opt-in live evidence that an OpenAI-compatible endpoint completes a full kernel Turn.
 * It exists separately from contract fixtures so normal test runs never require network access.
 */

import { createMemoryJournalBacking, Journal, JournalMemory } from "@popeye/journal";
import { Effect, Layer } from "effect";
import { expect, test } from "vitest";

import { CompactionLive } from "../compaction-policy.js";
import { MailboxLive } from "../mailbox.js";
import { PluginHostNone } from "../plugin-host.js";
import { ProgressHubLive } from "../progress.js";
import { Sessions, SessionsLive } from "../sessions.js";
import { ToolRegistryLive } from "../tool.js";
import { TurnOrchestrator, TurnOrchestratorLive } from "../turn-orchestrator.js";
import { PiAiProviderLive } from "./seam.js";

const liveSmoke =
  process.env.POPEYE_LIVE_SMOKE === "1" &&
  process.env.POPEYE_SMOKE_BASE_URL !== undefined &&
  process.env.POPEYE_SMOKE_MODEL !== undefined
    ? {
        baseUrl: process.env.POPEYE_SMOKE_BASE_URL,
        modelId: process.env.POPEYE_SMOKE_MODEL,
      }
    : undefined;

test.skipIf(liveSmoke === undefined)(
  "live smoke: OpenAI-compatible provider completes one tool-free turn through the pi-ai seam",
  async () => {
    if (liveSmoke === undefined) {
      throw new Error("Live smoke configuration was removed after test selection.");
    }
    const journalLayer = JournalMemory(createMemoryJournalBacking());
    const toolLayer = ToolRegistryLive([]);
    const mailboxLayer = MailboxLive().pipe(Layer.provide(journalLayer));
    const providerLayer = PiAiProviderLive({
      baseUrl: liveSmoke.baseUrl,
      idleTimeoutMs: 30_000,
      modelId: liveSmoke.modelId,
      provider: "lmstudio",
    }).pipe(Layer.provide(toolLayer));
    const dependencies = Layer.mergeAll(
      journalLayer,
      mailboxLayer,
      ProgressHubLive(),
      providerLayer,
      toolLayer,
    );
    const compactionLayer = CompactionLive().pipe(Layer.provide(dependencies));
    const turnDependencies = Layer.mergeAll(dependencies, compactionLayer, PluginHostNone);
    const liveLayer = Layer.mergeAll(
      turnDependencies,
      SessionsLive().pipe(Layer.provide(Layer.mergeAll(journalLayer, mailboxLayer, toolLayer))),
      TurnOrchestratorLive().pipe(Layer.provide(turnDependencies)),
    );

    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal;
        const sessions = yield* Sessions;
        const orchestrator = yield* TurnOrchestrator;
        const session = yield* sessions.create();
        const settled = yield* orchestrator.openTurn(
          session.id,
          "Reply with exactly: popeye live smoke",
        );
        return { branch: yield* journal.readBranch(session.id), settled };
      }).pipe(Effect.provide(liveLayer)),
    );

    expect(output.settled).toEqual({ stopReason: "done" });
    expect(output.branch.at(-1)?.payload).toMatchObject({
      role: "assistant",
      stopReason: "done",
    });
    expect(output.branch.at(-1)?.payload).toHaveProperty("content");
  },
  180_000,
);
