import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeProgress, decodeSnapshot } from "@pop-eye/protocol";
import { Effect } from "effect";
import { expect, test } from "vitest";

import { FAKE_PROVIDER_PROMPT, fakeProviderEnvironment, runBuiltBin } from "../test-support/cli.js";
import { normalizeJsonStream } from "../test-support/json.js";

const FIXTURE_PATH = new URL("../../test-fixtures/cli-json-stream.jsonl", import.meta.url).pathname;

const lines = (stream: string): ReadonlyArray<string> => stream.trimEnd().split("\n");

const decodeWireStream = async (stream: string): Promise<void> => {
  for (const line of lines(stream)) {
    const frame = JSON.parse(line) as unknown;
    if (typeof frame === "object" && frame !== null && "_tag" in frame) {
      await Effect.runPromise(decodeProgress(frame));
    } else {
      await Effect.runPromise(decodeSnapshot(frame));
    }
  }
};

const captureBuiltStream = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "peye-cli-stream-"));
  try {
    const result = runBuiltBin(
      ["-p", "--mode", "json", "--session-dir", directory, FAKE_PROVIDER_PROMPT],
      { env: fakeProviderEnvironment() },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  } finally {
    rmSync(directory, { force: true, recursive: true });
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
      plugins: ["compact", "session-name"],
    },
  });
});

test("the normalized CLI JSON stream is stable across 2 built-bin runs", () => {
  const fixture = readFileSync(FIXTURE_PATH, "utf8");
  const first = captureBuiltStream();
  const second = captureBuiltStream();

  expect(normalizeJsonStream(first)).toEqual(normalizeJsonStream(second));
  expect(normalizeJsonStream(first)).toEqual(normalizeJsonStream(fixture));
}, 15_000);
