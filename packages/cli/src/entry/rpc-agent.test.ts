/**
 * End-to-end coverage for the rpc create agent field (RFC-04 §4, issue #55)
 * through the real CLI composition: executeCli in rpc mode, the real Plugin
 * pipeline, the real pi-ai Provider against a loopback OpenAI-compatible
 * fixture, and the production Head runtime. The fixture records every request
 * body, so each Session's model, system messages, and offered Tools are read
 * from what actually went over the wire. resume with the agent field is
 * covered the same way.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, expect, test } from "vitest";

import { cleanCliEnvironment } from "../test-support/cli.js";
import { executeCli } from "./cli-entry.js";

const PERSONA = "Reviewer persona body.";
const EFFECT_URL = new URL("../../node_modules/effect/dist/esm/index.js", import.meta.url).href;

const temporaryDirectories: Array<string> = [];
const servers: Array<Server> = [];
/** Every running rpc fixture; afterEach ends its input and awaits its exit on every path. */
const rpcFixtures: Array<{ readonly end: () => Promise<number> }> = [];

afterEach(async () => {
  for (const fixture of rpcFixtures.splice(0)) {
    await fixture.end();
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const tempDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "popeye-rpc-agent-"));
  temporaryDirectories.push(directory);
  return directory;
};

interface RecordedRequest {
  readonly messages: ReadonlyArray<Record<string, unknown>>;
  readonly model: unknown;
  readonly prompt: string;
  readonly system: string;
  readonly tools: ReadonlyArray<string>;
}

const messageText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) =>
            typeof part === "object" && part !== null && "text" in part ? String(part.text) : "",
          )
          .join("")
      : "";

/** A loopback OpenAI-compatible endpoint that answers "ok" and records each request by its prompt. */
const startFixtureEndpoint = async (): Promise<{
  readonly baseUrl: string;
  readonly requests: Map<string, RecordedRequest>;
}> => {
  const requests = new Map<string, RecordedRequest>();
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as {
        readonly messages?: ReadonlyArray<Record<string, unknown>>;
        readonly model?: unknown;
        readonly tools?: ReadonlyArray<{ readonly function?: { readonly name?: string } }>;
      };
      const messages = parsed.messages ?? [];
      const prompt = messageText(messages.findLast((message) => message.role === "user")?.content);
      requests.set(prompt, {
        messages,
        model: parsed.model,
        prompt,
        system: messages
          .filter((message) => message.role === "system" || message.role === "developer")
          .map((message) => messageText(message.content))
          .join("\n"),
        tools: (parsed.tools ?? []).map((tool) => tool.function?.name ?? "").sort(),
      });
      const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        chunk({
          choices: [{ delta: { content: "ok" }, finish_reason: null, index: 0 }],
          id: "fixture",
          model: "fixture",
          object: "chat.completion.chunk",
        }),
      );
      response.write(
        chunk({
          choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
          id: "fixture",
          model: "fixture",
          object: "chat.completion.chunk",
        }),
      );
      response.write(
        chunk({
          choices: [],
          id: "fixture",
          model: "fixture",
          object: "chat.completion.chunk",
          usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
        }),
      );
      response.end("data: [DONE]\n\n");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The fixture endpoint has no TCP address.");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
};

/** An agents dir with reviewer (model and tools list) and a Plugin contributing alpha and beta. */
const fixtureFiles = (): {
  readonly agentsDir: string;
  readonly pluginPath: string;
  readonly sessionDir: string;
  readonly userPluginDir: string;
} => {
  const root = tempDirectory();
  const agentsDir = join(root, "agents");
  const userPluginDir = join(root, "user-plugins");
  mkdirSync(agentsDir);
  mkdirSync(userPluginDir);
  writeFileSync(
    join(agentsDir, "reviewer.md"),
    `---\nname: reviewer\ndescription: Reviews diffs.\nmodel: agent-model\ntools: alpha\n---\n${PERSONA}\n`,
    "utf8",
  );
  const pluginPath = join(root, "alpha-beta.mjs");
  writeFileSync(
    pluginPath,
    [
      `import { Effect, Schema } from ${JSON.stringify(EFFECT_URL)};`,
      "const tool = (name) => ({",
      "  kind: 'tool',",
      "  name,",
      "  payload: {",
      "    description: 'Run ' + name + '.',",
      "    execute: () => Effect.succeed({ content: name + '-result' }),",
      "    name,",
      "    parameters: Schema.Struct({}),",
      "  },",
      "  priority: 0,",
      "});",
      "export default () => ({",
      "  contributions: [tool('alpha'), tool('beta')],",
      "  manifest: { capabilities: [], name: 'alpha-beta-tools', version: '1.0.0' },",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  return { agentsDir, pluginPath, sessionDir: join(root, "sessions"), userPluginDir };
};

const environment = (baseUrl: string, files: ReturnType<typeof fixtureFiles>) => ({
  ...cleanCliEnvironment(),
  POPEYE_AGENTS_DIR: files.agentsDir,
  POPEYE_BASE_URL: baseUrl,
  POPEYE_MODEL: "process-model",
  POPEYE_USER_PLUGIN_DIR: files.userPluginDir,
});

type Frame = Readonly<Record<string, unknown>> & {
  readonly error?: Readonly<Record<string, unknown>>;
  readonly id?: string;
  readonly result?: Readonly<Record<string, unknown>>;
};

/**
 * Drives executeCli in rpc mode over in-memory stdio and pairs responses with requests by id.
 * The fixture registers itself for afterEach cleanup, and a CLI exit rejects every request
 * still waiting, with the exit code and stderr, instead of leaving it to the test timeout.
 */
const startRpc = (argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv) => {
  const input = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const waiters = new Map<
    string,
    { readonly reject: (error: Error) => void; readonly resolve: (frame: Frame) => void }
  >();
  let pending = "";
  let errors = "";
  let exited: string | undefined;
  stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }
      const frame = JSON.parse(line) as Frame;
      if (typeof frame.id === "string") {
        waiters.get(frame.id)?.resolve(frame);
        waiters.delete(frame.id);
      }
    }
  });
  stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString("utf8");
  });
  const exit = executeCli(argv, env, { input, stderr, stdout }).then(
    (code) => {
      exited = `the rpc CLI exited with code ${code}`;
      return code;
    },
    (error: unknown) => {
      exited = `the rpc CLI rejected: ${String(error)}`;
      throw error;
    },
  );
  const rejectWaiters = () => {
    for (const [id, waiter] of waiters) {
      waiter.reject(
        new Error(`${exited ?? "the rpc CLI exited"} before answering ${id}. stderr:\n${errors}`),
      );
    }
    waiters.clear();
  };
  void exit.then(rejectWaiters, rejectWaiters);
  const end = (): Promise<number> => {
    if (!input.writableEnded) {
      input.end();
    }
    return exit;
  };
  rpcFixtures.push({ end: () => end().catch(() => -1) });
  return {
    end,
    request: (frame: Readonly<Record<string, unknown>> & { readonly id: string }) =>
      new Promise<Frame>((resolve, reject) => {
        if (exited !== undefined) {
          reject(new Error(`${exited} before ${frame.id} was sent. stderr:\n${errors}`));
          return;
        }
        waiters.set(frame.id, { reject, resolve });
        input.write(`${JSON.stringify(frame)}\n`);
      }),
    stderr: () => errors,
  };
};

const rpcArgv = (files: ReturnType<typeof fixtureFiles>) => [
  "-p",
  "--mode",
  "rpc",
  "--session-dir",
  files.sessionDir,
  "--no-project-plugins",
  "--plugin",
  files.pluginPath,
];

const sessionIdOf = (frame: Frame): string => {
  const sessionId = frame.result?.sessionId;
  if (typeof sessionId !== "string") {
    throw new Error(`Expected a snapshot response, received ${JSON.stringify(frame)}.`);
  }
  return sessionId;
};

test("an Agent Session and a plain Session hold their own persona, model, and Tools; close then resume returns the Agent Session to the process view", async () => {
  const endpoint = await startFixtureEndpoint();
  const files = fixtureFiles();
  const rpc = startRpc(rpcArgv(files), environment(endpoint.baseUrl, files));

  const [agentCreate, plainCreate] = await Promise.all([
    rpc.request({ _tag: "create", agent: "reviewer", id: "create-agent" }),
    rpc.request({ _tag: "create", id: "create-plain" }),
  ]);
  const agentId = sessionIdOf(agentCreate);
  const plainId = sessionIdOf(plainCreate);
  // Issue #55 acceptance: both Sessions are attached at once while they run.
  const [agentAttach, plainAttach] = await Promise.all([
    rpc.request({ _tag: "attach", id: "attach-agent", sessionId: agentId }),
    rpc.request({ _tag: "attach", id: "attach-plain", sessionId: plainId }),
  ]);
  expect(agentAttach).toMatchObject({
    result: { _tag: "snapshot", attached: true, sessionId: agentId },
  });
  expect(plainAttach).toMatchObject({
    result: { _tag: "snapshot", attached: true, sessionId: plainId },
  });
  await Promise.all([
    rpc.request({
      _tag: "prompt",
      content: "agent-prompt",
      id: "prompt-agent",
      sessionId: agentId,
    }),
    rpc.request({
      _tag: "prompt",
      content: "plain-prompt",
      id: "prompt-plain",
      sessionId: plainId,
    }),
  ]);
  const closed = await rpc.request({ _tag: "close", id: "close-agent", sessionId: agentId });
  const resumed = await rpc.request({ _tag: "resume", id: "resume-agent", sessionId: agentId });
  await rpc.request({
    _tag: "prompt",
    content: "resumed-prompt",
    id: "prompt-resumed",
    sessionId: agentId,
  });
  const exitCode = await rpc.end();

  expect(exitCode, rpc.stderr()).toBe(0);
  expect(closed).toMatchObject({ result: { _tag: "closed", cause: "clean" } });
  expect(resumed).toMatchObject({ result: { _tag: "snapshot", sessionId: agentId } });
  const agent = endpoint.requests.get("agent-prompt");
  const plain = endpoint.requests.get("plain-prompt");
  const resumedRequest = endpoint.requests.get("resumed-prompt");
  // The plain Session keeps the process view: process model, no persona, every granted Tool.
  expect(plain?.model).toBe("process-model");
  expect(plain?.system).not.toContain(PERSONA);
  expect(plain?.tools).toEqual(expect.arrayContaining(["alpha", "beta"]));
  // The Agent Session runs as the definition: its model, its body, its tools list.
  expect(agent?.model).toBe("agent-model");
  expect(agent?.system).toContain(PERSONA);
  expect(agent?.tools).toEqual(["alpha"]);
  // rpc close released the binding from the store the registry reads: resume is plain.
  expect(resumedRequest?.model).toBe("process-model");
  expect(resumedRequest?.system).not.toContain(PERSONA);
  expect(resumedRequest?.tools).toEqual(plain?.tools);
}, 30_000);

test("an rpc Agent Session sends the same model, system messages, and Tools as --agent", async () => {
  const endpoint = await startFixtureEndpoint();
  const files = fixtureFiles();
  const env = environment(endpoint.baseUrl, files);

  const printStdout = new PassThrough();
  const printStderr = new PassThrough();
  let printErrors = "";
  printStderr.on("data", (chunk: Buffer) => {
    printErrors += chunk.toString("utf8");
  });
  printStdout.resume();
  const printInput = new PassThrough();
  printInput.end();
  const printCode = await executeCli(
    [
      "-p",
      "--agent",
      "reviewer",
      "--session-dir",
      files.sessionDir,
      "--no-project-plugins",
      "--plugin",
      files.pluginPath,
      "parity-prompt",
    ],
    env,
    { input: printInput, stderr: printStderr, stdout: printStdout },
  );
  expect(printCode, printErrors).toBe(0);
  const viaFlag = endpoint.requests.get("parity-prompt");
  endpoint.requests.clear();

  const rpc = startRpc(rpcArgv(files), env);
  const created = await rpc.request({ _tag: "create", agent: "reviewer", id: "create-agent" });
  await rpc.request({
    _tag: "prompt",
    content: "parity-prompt",
    id: "prompt-parity",
    sessionId: sessionIdOf(created),
  });
  const exitCode = await rpc.end();
  const viaField = endpoint.requests.get("parity-prompt");

  expect(exitCode, rpc.stderr()).toBe(0);
  expect(viaFlag).toBeDefined();
  expect(viaField?.model).toEqual(viaFlag?.model);
  expect(viaField?.messages).toEqual(viaFlag?.messages);
  expect(viaField?.tools).toEqual(viaFlag?.tools);
}, 30_000);

test("an unknown agent fails the rpc create with agent_error and the process keeps serving", async () => {
  const endpoint = await startFixtureEndpoint();
  const files = fixtureFiles();
  const rpc = startRpc(rpcArgv(files), environment(endpoint.baseUrl, files));

  const failed = await rpc.request({ _tag: "create", agent: "ghost", id: "create-ghost" });
  const listed = await rpc.request({ _tag: "list", id: "list-1" });
  const plain = await rpc.request({ _tag: "create", id: "create-plain" });
  const exitCode = await rpc.end();

  expect(exitCode, rpc.stderr()).toBe(0);
  expect(failed).toEqual({
    error: {
      code: "agent_error",
      details: {
        agent: "ghost",
        available: ["reviewer"],
        reason: "unknown_agent",
        tag: "AgentSessionError",
      },
      message: 'Unknown agent "ghost". Available agents: reviewer (user).',
    },
    id: "create-ghost",
  });
  expect(listed).toMatchObject({ result: { _tag: "sessionList", sessions: [] } });
  expect(plain).toMatchObject({ result: { _tag: "snapshot" } });
}, 30_000);

test("resume with agent re-applies the Agent after close; an unknown name fails with agent_error and leaves the Session unresumed", async () => {
  const endpoint = await startFixtureEndpoint();
  const files = fixtureFiles();
  const rpc = startRpc(rpcArgv(files), environment(endpoint.baseUrl, files));

  const created = await rpc.request({ _tag: "create", agent: "reviewer", id: "create-agent" });
  const sessionId = sessionIdOf(created);
  await rpc.request({ _tag: "close", id: "close-1", sessionId });
  const resumed = await rpc.request({
    _tag: "resume",
    agent: "reviewer",
    id: "resume-agent",
    sessionId,
  });
  await rpc.request({
    _tag: "prompt",
    content: "agent-resumed-prompt",
    id: "prompt-agent-resumed",
    sessionId,
  });
  await rpc.request({ _tag: "close", id: "close-2", sessionId });
  const failed = await rpc.request({
    _tag: "resume",
    agent: "ghost",
    id: "resume-ghost",
    sessionId,
  });
  const promptAfterFailure = await rpc.request({
    _tag: "prompt",
    content: "never-sent",
    id: "prompt-after-failure",
    sessionId,
  });
  const exitCode = await rpc.end();

  expect(exitCode, rpc.stderr()).toBe(0);
  expect(resumed).toMatchObject({ result: { _tag: "snapshot", sessionId } });
  const agentResumed = endpoint.requests.get("agent-resumed-prompt");
  expect(agentResumed?.model).toBe("agent-model");
  expect(agentResumed?.system).toContain(PERSONA);
  expect(agentResumed?.tools).toEqual(["alpha"]);
  expect(failed).toEqual({
    error: {
      code: "agent_error",
      details: {
        agent: "ghost",
        available: ["reviewer"],
        reason: "unknown_agent",
        tag: "AgentSessionError",
      },
      message: 'Unknown agent "ghost". Available agents: reviewer (user).',
    },
    id: "resume-ghost",
  });
  expect(promptAfterFailure).toMatchObject({ error: { code: "session_not_found" } });
  expect(endpoint.requests.has("never-sent")).toBe(false);
}, 30_000);
