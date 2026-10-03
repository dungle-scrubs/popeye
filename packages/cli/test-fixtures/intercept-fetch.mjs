// Preloaded with `node --import` by credential tests. It replaces global fetch so a run makes no
// network request: each request's method, URL, and auth headers append to FETCH_INTERCEPT_LOG as
// one JSON line, and the reply is a one-chunk OpenAI-compatible stream that settles the Turn.
import { appendFileSync } from "node:fs";

const logPath = process.env.FETCH_INTERCEPT_LOG;
if (logPath === undefined || logPath.length === 0) {
  throw new Error("intercept-fetch.mjs requires FETCH_INTERCEPT_LOG.");
}

const chunk = {
  choices: [{ delta: { content: "intercepted" }, finish_reason: "stop", index: 0 }],
  id: "completion-intercepted",
  model: "synthetic-model",
  object: "chat.completion.chunk",
};

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  appendFileSync(
    logPath,
    `${JSON.stringify({
      authorization: request.headers.get("authorization"),
      method: request.method,
      url: request.url,
      xApiKey: request.headers.get("x-api-key"),
    })}\n`,
  );
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  });
};
