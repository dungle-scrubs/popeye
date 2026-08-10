/**
 * Owns the opt-in live evidence that an OpenAI-compatible endpoint completes a tool-free turn.
 * It exists separately from contract fixtures so normal test runs never require network access.
 */

import { Chunk, Effect, Stream } from "effect";
import { expect, test } from "vitest";

import { Provider } from "../provider.js";
import { ToolRegistryLive } from "../tool.js";
import { PiAiProviderLive } from "./seam.js";

const liveSmoke =
  process.env.PEYE_LIVE_SMOKE === "1" &&
  process.env.PEYE_SMOKE_BASE_URL !== undefined &&
  process.env.PEYE_SMOKE_MODEL !== undefined
    ? {
        baseUrl: process.env.PEYE_SMOKE_BASE_URL,
        modelId: process.env.PEYE_SMOKE_MODEL,
      }
    : undefined;

test.skipIf(liveSmoke === undefined)(
  "live smoke: OpenAI-compatible provider completes one tool-free turn through the pi-ai seam",
  async () => {
    if (liveSmoke === undefined) {
      throw new Error("Live smoke configuration was removed after test selection.");
    }
    const providerLayer = PiAiProviderLive({
      baseUrl: liveSmoke.baseUrl,
      idleTimeoutMs: 30_000,
      modelId: liveSmoke.modelId,
      provider: "lmstudio",
    });

    const items = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Provider;
        return yield* Stream.runCollect(
          provider.streamAssistant(
            [{ content: "Reply with exactly: peye live smoke", role: "user" }],
            { attempt: 1, turnOrdinal: 1 },
          ),
        );
      }).pipe(Effect.provide(providerLayer), Effect.provide(ToolRegistryLive([]))),
    );
    const output = Chunk.toArray(items);

    expect(output.some((item) => item._tag === "textDelta" && item.text.length > 0)).toBe(true);
    expect(output.at(-1)).toEqual({ _tag: "done", stopReason: "done" });
  },
  180_000,
);
