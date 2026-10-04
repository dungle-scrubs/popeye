import { appendFileSync } from "node:fs";

// This preload replaces transport only. The built CLI still uses the real pi-ai adapter.
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const isResponses = request.url === "http://127.0.0.1:1/v1/responses";
  if (
    (request.url !== "http://127.0.0.1:1/v1/chat/completions" && !isResponses) ||
    request.method !== "POST"
  ) {
    const error = new Error(`Unexpected offline wire request: ${request.method} ${request.url}`);
    error.code = "UNEXPECTED_WIRE_REQUEST";
    throw error;
  }
  const capturePath = process.env.POPEYE_TEST_WIRE_CAPTURE;
  if (capturePath === undefined) {
    const error = new Error("POPEYE_TEST_WIRE_CAPTURE is required by the offline preload.");
    error.code = "MISSING_WIRE_CAPTURE";
    throw error;
  }
  const body = await request.json();
  appendFileSync(capturePath, `${JSON.stringify(body)}\n`);
  if (isResponses) {
    const error = new Error("Registry non-reasoning request reached offline transport.");
    error.code = "UNEXPECTED_REASONING_TRANSPORT";
    throw error;
  }
  const chunk = {
    choices: [{ delta: { content: "Offline wire answer." }, finish_reason: "stop", index: 0 }],
    id: "offline-reasoning",
    model: body.model,
    object: "chat.completion.chunk",
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  });
};
