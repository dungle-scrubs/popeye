import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeProgress, decodeSnapshot } from "@dungle-scrubs/popeye-protocol";
import { Effect } from "effect";
import { expect, test } from "vitest";

import { FAKE_PROVIDER_PROMPT, fakeProviderEnvironment, runBuiltBin } from "../test-support/cli.js";
import { normalizeJsonLines, normalizeJsonStream } from "../test-support/json.js";

const FIXTURE_PATH = new URL("../../test-fixtures/cli-json-stream.jsonl", import.meta.url).pathname;
const HCN_FIXTURE_PATH = new URL("../../test-fixtures/cli-hcn-stream.jsonl", import.meta.url)
  .pathname;
const TOOL_FIXTURE_PATH = new URL("../../test-fixtures/cli-json-tool-stream.jsonl", import.meta.url)
  .pathname;
const TOOL_FIXTURE_PROMPT = "Call project-echo once with the fixture value.";

const lines = (stream: string): ReadonlyArray<string> => stream.trimEnd().split("\n");

const decodeWireStream = async (stream: string): Promise<void> => {
  const [sessionLine, ...rest] = lines(stream);
  const sessionFrame = JSON.parse(sessionLine ?? "null") as unknown;
  expect(sessionFrame).toMatchObject({ _tag: "sessionId", sessionId: expect.any(String) });
  for (const line of rest) {
    const frame = JSON.parse(line) as unknown;
    if (typeof frame === "object" && frame !== null && "_tag" in frame) {
      await Effect.runPromise(decodeProgress(frame));
    } else {
      await Effect.runPromise(decodeSnapshot(frame));
    }
  }
};

const captureBuiltStream = (mode: "hcn" | "json" = "json"): string => {
  const directory = mkdtempSync(join(tmpdir(), `popeye-cli-${mode}-stream-`));
  try {
    const result = runBuiltBin(
      ["-p", "--mode", mode, "--session-dir", directory, FAKE_PROVIDER_PROMPT],
      { env: fakeProviderEnvironment() },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

const expectStableRecordedFixture = (capture: () => string, fixturePath: string): void => {
  const first = capture();
  const second = capture();

  expect(normalizeJsonStream(first)).toEqual(normalizeJsonStream(second));
  if (process.env.POPEYE_UPDATE_RECORDED_FIXTURES === "1") {
    writeFileSync(fixturePath, normalizeJsonLines(first));
  }
  const fixture = readFileSync(fixturePath, "utf8");
  expect(normalizeJsonStream(first)).toEqual(normalizeJsonStream(fixture));
};

const captureBuiltToolStream = (): string => {
  const projectPath = mkdtempSync(join(tmpdir(), "popeye-cli-tool-stream-"));
  const projectPluginDir = join(projectPath, ".popeye", "plugins");
  const providerScriptPath = join(projectPath, "tool-provider.json");
  const sessionDir = join(projectPath, "sessions");
  const userPluginDir = join(projectPath, "user-plugins");
  try {
    mkdirSync(projectPluginDir, { recursive: true });
    mkdirSync(userPluginDir, { recursive: true });
    writeFileSync(
      join(projectPluginDir, "project-echo.ts"),
      [
        `import { Effect, Schema } from ${JSON.stringify(new URL("../../node_modules/effect/dist/esm/index.js", import.meta.url).href)};`,
        "export default () => ({",
        "  contributions: [{",
        "    kind: 'tool',",
        "    name: 'project-echo',",
        "    payload: {",
        "      description: 'Echo a project value.',",
        "      execute: ({ value }) => Effect.succeed({ content: 'echo:' + value }),",
        "      name: 'project-echo',",
        "      parameters: Schema.Struct({ value: Schema.String }),",
        "    },",
        "    priority: 0,",
        "  }],",
        "  manifest: { capabilities: [], name: 'project-echo-plugin', version: '1.0.0' },",
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(
      providerScriptPath,
      JSON.stringify({
        responses: [
          {
            items: [
              {
                _tag: "toolCall",
                argumentsJson: JSON.stringify({ value: "fixture-value" }),
                id: "project-echo-call",
                name: "project-echo",
              },
              { _tag: "done", stopReason: "toolCalls" },
            ],
            prompt: TOOL_FIXTURE_PROMPT,
          },
          {
            items: [
              { _tag: "textDelta", text: "Provider observed echo:fixture-value." },
              { _tag: "done", stopReason: "done" },
            ],
            prompt: TOOL_FIXTURE_PROMPT,
          },
        ],
      }),
    );

    const result = runBuiltBin(
      ["-p", "--mode", "json", "--session-dir", sessionDir, TOOL_FIXTURE_PROMPT],
      {
        cwd: projectPath,
        env: {
          ...fakeProviderEnvironment(),
          POPEYE_FAKE_PROVIDER_SCRIPT: providerScriptPath,
          POPEYE_USER_PLUGIN_DIR: userPluginDir,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  } finally {
    rmSync(projectPath, { force: true, recursive: true });
  }
};

test("the committed CLI JSON stream decodes as Progress followed by a Snapshot", async () => {
  const fixture = readFileSync(FIXTURE_PATH, "utf8");
  const snapshot = JSON.parse(lines(fixture).at(-1) ?? "null") as Record<string, unknown>;

  await expect(decodeWireStream(fixture)).resolves.toBeUndefined();
  expect(snapshot.entries).toBeDefined();
  expect(snapshot).toMatchObject({
    capabilityGrants: [],
    loadedGeneration: {
      id: expect.any(String),
      plugins: ["compact", "reload", "session-name"],
    },
  });
});

test("the normalized CLI JSON stream is stable across 2 built-bin runs", () => {
  expectStableRecordedFixture(() => captureBuiltStream("json"), FIXTURE_PATH);
}, 15_000);

test("the committed CLI HCN stream carries identity-first HarnessEvents", () => {
  const fixture = readFileSync(HCN_FIXTURE_PATH, "utf8");
  const [identity, _token, message, done] = lines(fixture).map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  const kinds = [identity, _token, message, done].map((event) => event?.kind);

  expect(kinds).toEqual(["identity", "token", "message", "done"]);
  expect(identity).toMatchObject({ kind: "identity", authority: "harness-minted" });
  expect(message).toMatchObject({
    kind: "message",
    role: "assistant",
    text: "Fake provider answer.",
  });
  expect(done).toMatchObject({ kind: "done", exitCode: 0, cause: "clean" });
});

test("the normalized CLI HCN stream is stable across 2 built-bin runs", () => {
  expectStableRecordedFixture(() => captureBuiltStream("hcn"), HCN_FIXTURE_PATH);
}, 15_000);

test("the committed CLI JSON Tool stream decodes as Progress followed by a Snapshot", async () => {
  const fixture = readFileSync(TOOL_FIXTURE_PATH, "utf8");
  const snapshot = JSON.parse(lines(fixture).at(-1) ?? "null") as Record<string, unknown>;

  await expect(decodeWireStream(fixture)).resolves.toBeUndefined();
  expect(snapshot.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({
          content: "echo:fixture-value",
          role: "toolResult",
          toolName: "project-echo",
        }),
      }),
    ]),
  );
  expect(snapshot).toMatchObject({
    capabilityGrants: [],
    loadedGeneration: {
      id: expect.any(String),
      plugins: ["compact", "reload", "session-name", "project-echo-plugin"],
    },
  });
});

test("the normalized CLI JSON Tool stream is stable across 2 built-bin runs", () => {
  const first = captureBuiltToolStream();
  const second = captureBuiltToolStream();

  expect(normalizeJsonStream(first)).toEqual(normalizeJsonStream(second));
  if (process.env.POPEYE_UPDATE_RECORDED_FIXTURES === "1") {
    writeFileSync(TOOL_FIXTURE_PATH, normalizeJsonLines(first));
  }
  const fixture = readFileSync(TOOL_FIXTURE_PATH, "utf8");
  expect(normalizeJsonStream(first)).toEqual(normalizeJsonStream(fixture));
}, 15_000);
