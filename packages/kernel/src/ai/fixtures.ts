/**
 * Owns recorded pi-ai stream fixtures used to detect dependency contract drift.
 * It exists so version bumps exercise pi-ai's real event-stream implementation without network access.
 */

import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";

const usage = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input: 0,
  output: 0,
  totalTokens: 0,
} as const;

export const fixtureModel: Model<"openai-completions"> = {
  api: "openai-completions",
  baseUrl: "http://127.0.0.1.invalid/v1",
  contextWindow: 32_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: "fixture-model",
  input: ["text"],
  maxTokens: 4_096,
  name: "Fixture Model",
  provider: "fixture",
  reasoning: true,
};

export const fixtureMessage = (
  stopReason: AssistantMessage["stopReason"],
  content: AssistantMessage["content"] = [],
  errorMessage?: string,
): AssistantMessage => ({
  api: fixtureModel.api,
  content,
  ...(errorMessage === undefined ? {} : { errorMessage }),
  model: fixtureModel.id,
  provider: fixtureModel.provider,
  role: "assistant",
  stopReason,
  timestamp: 0,
  usage,
});

export interface RecordedFixture {
  readonly final: AssistantMessage;
  readonly stream: AssistantMessageEventStream;
}

export const interleavedFixture = (): RecordedFixture => {
  const stream = createAssistantMessageEventStream();
  const toolCall = {
    arguments: { city: "Bangkok" },
    id: "tool-1",
    name: "weather",
    type: "toolCall",
  } as const;
  const partial = fixtureMessage("pending", [
    { text: "", type: "text" },
    { thinking: "", type: "thinking" },
    toolCall,
  ]);
  const final = fixtureMessage("toolUse", [
    { text: "hello", type: "text" },
    { thinking: "reason", type: "thinking" },
    toolCall,
  ]);

  stream.push({ partial, type: "start" });
  stream.push({ contentIndex: 0, partial, type: "text_start" });
  stream.push({ contentIndex: 0, delta: "hel", partial, type: "text_delta" });
  stream.push({ contentIndex: 0, delta: "lo", partial, type: "text_delta" });
  stream.push({ content: "hello", contentIndex: 0, partial, type: "text_end" });
  stream.push({ contentIndex: 1, partial, type: "thinking_start" });
  stream.push({ contentIndex: 1, delta: "rea", partial, type: "thinking_delta" });
  stream.push({ contentIndex: 1, delta: "son", partial, type: "thinking_delta" });
  stream.push({ content: "reason", contentIndex: 1, partial, type: "thinking_end" });
  stream.push({ contentIndex: 2, partial, type: "toolcall_start" });
  stream.push({ contentIndex: 2, delta: '{"city":"Bang', partial, type: "toolcall_delta" });
  stream.push({ contentIndex: 2, delta: 'kok"}', partial, type: "toolcall_delta" });
  stream.push({ contentIndex: 2, partial, toolCall, type: "toolcall_end" });
  stream.push({ message: final, reason: "toolUse", type: "done" });

  return { final, stream };
};

export const errorFixture = (message = "provider rejected request"): RecordedFixture => {
  const stream = createAssistantMessageEventStream();
  const partial = fixtureMessage("pending");
  const final = fixtureMessage("error", [], message);
  stream.push({ partial, type: "start" });
  stream.push({ error: final, reason: "error", type: "error" });
  return { final, stream };
};

export const abortFixture = (): RecordedFixture => {
  const stream = createAssistantMessageEventStream();
  const final = fixtureMessage("aborted", [], "request aborted by caller");
  stream.push({ partial: fixtureMessage("pending"), type: "start" });
  stream.push({ error: final, reason: "aborted", type: "error" });
  return { final, stream };
};

export const mutatedSettlementFixture = (): RecordedFixture => {
  const stream = createAssistantMessageEventStream();
  const final = fixtureMessage("stop", [{ text: "drifted", type: "text" }]);
  stream.push({ partial: fixtureMessage("pending"), type: "start" });
  stream.push({ message: final, reason: "toolUse", type: "done" });
  return { final, stream };
};
