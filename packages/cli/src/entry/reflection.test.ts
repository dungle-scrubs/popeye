import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { FAKE_PROVIDER_PROMPT, fakeProviderEnvironment, runBuiltBin } from "../test-support/cli.js";

// The built CLI with POPEYE_REFLECT_INTAKE pointing at a stub hook script this file writes (RFC-03
// slice 16, ADR-0002). The stub records its argv, stdin, and one inherited variable, then exits 0.
// No real reflect-intake, hcn, harness, or model runs: the Provider is the scripted fake. Every
// path lives under a directory this file made with its own prefix, and every stub process is
// confirmed exited before the test ends.

const PREFIX = "popeye-cli-reflection-test-";
const made = new Set<string>();

afterEach(() => {
  for (const dir of made) {
    if (!basename(dir).startsWith(PREFIX) || dirname(dir) !== realpathSync(tmpdir())) {
      throw new Error(`refusing to remove ${dir}`);
    }
    rmSync(dir, { force: true, recursive: true });
  }
  made.clear();
});

const STUB = `#!/bin/sh
out="$STUB_OUT_DIR/$3.$$"
printf '%s\\n' "$@" > "$out.args"
cat > "$out.stdin"
printf '%s' "$REFLECT_INTAKE_WORK_PARENT" > "$out.env"
printf '%s' "$$" > "$out.done"
exit 0
`;

const workspace = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), PREFIX)));
  made.add(dir);
  const stub = join(dir, "stub-reflect-intake");
  writeFileSync(stub, STUB, { mode: 0o755 });
  chmodSync(stub, 0o755);
  const out = join(dir, "out");
  mkdirSync(out);
  return { dir, out, sessionDir: join(dir, "sessions"), stub };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for `count` finished stub calls, then confirms every stub process has exited. */
const stubCalls = async (out: string, count: number) => {
  const deadline = Date.now() + 10_000;
  let done: Array<string> = [];
  while (Date.now() < deadline) {
    done = readdirSync(out).filter((name) => name.endsWith(".done"));
    if (done.length >= count) break;
    await sleep(25);
  }
  const calls = done.map((name) => {
    const base = join(out, name.slice(0, -".done".length));
    const pid = Number(readFileSync(`${base}.done`, "utf8"));
    return {
      args: readFileSync(`${base}.args`, "utf8"),
      env: readFileSync(`${base}.env`, "utf8"),
      payload: JSON.parse(readFileSync(`${base}.stdin`, "utf8")) as Record<string, unknown>,
      pid,
    };
  });
  for (const call of calls) {
    const exitDeadline = Date.now() + 5_000;
    for (;;) {
      try {
        process.kill(call.pid, 0);
      } catch {
        break;
      }
      if (Date.now() > exitDeadline) {
        process.kill(call.pid, "SIGKILL");
        throw new Error(`stub ${call.pid} did not exit`);
      }
      await sleep(10);
    }
  }
  return calls;
};

describe("POPEYE_REFLECT_INTAKE through the built CLI", () => {
  test("a print run sends created then a clean closed to the hook with the caller env", async () => {
    const ws = workspace();
    const parent = '{"authority":"graybox-invented","id":"task-invented-1"}';
    const result = runBuiltBin(["-p", "--session-dir", ws.sessionDir, FAKE_PROVIDER_PROMPT], {
      env: {
        ...fakeProviderEnvironment(),
        POPEYE_REFLECT_INTAKE: ws.stub,
        REFLECT_INTAKE_WORK_PARENT: parent,
        STUB_OUT_DIR: ws.out,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = await stubCalls(ws.out, 2);
    const byEvent = new Map(calls.map((call) => [String(call.payload.event), call]));
    expect(calls).toHaveLength(2);
    expect(byEvent.get("created")?.args).toBe("hook\npopeye\ncreated\n");
    expect(byEvent.get("closed")?.args).toBe("hook\npopeye\nclosed\n");
    const created = byEvent.get("created")?.payload;
    expect(byEvent.get("closed")?.payload).toMatchObject({
      activationId: created?.activationId,
      drainedWithinGrace: true,
      headExit: true,
      sessionId: created?.sessionId,
    });
    for (const call of calls) expect(call.env).toBe(parent);
    const record = JSON.parse(
      readFileSync(join(ws.sessionDir, "reflection", `${String(created?.sessionId)}.json`), "utf8"),
    ) as { closed: boolean };
    expect(record.closed).toBe(true);
  }, 30_000);

  test("unset, nothing is sent and no reflection directory is written", async () => {
    const ws = workspace();
    const result = runBuiltBin(["-p", "--session-dir", ws.sessionDir, FAKE_PROVIDER_PROMPT], {
      env: { ...fakeProviderEnvironment(), STUB_OUT_DIR: ws.out },
    });
    expect(result.status, result.stderr).toBe(0);
    await sleep(200);
    expect(readdirSync(ws.out)).toEqual([]);
    expect(existsSync(join(ws.sessionDir, "reflection"))).toBe(false);
  }, 30_000);
});
