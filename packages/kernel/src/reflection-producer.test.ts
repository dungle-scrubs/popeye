import type { ChildProcess } from "node:child_process";
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

import {
  type Liveness,
  makeReflectionProducer,
  REFLECT_INTAKE_ENV,
  type ReflectionFaultPoint,
  type ReflectionProducerOptions,
  reflectionExecutable,
  reflectionProducerFromEnv,
  spawnDetachedHook,
} from "./reflection-producer.js";

// Reflection producer tests (RFC-03 slice 16, ADR-0002). Invented Session IDs and payloads only.
// Every spawn is a fake except the stub-script test, which runs a shell stub this file writes into
// its own temporary directory and reaps before the test ends. No test runs reflect-intake, hcn, a
// harness, or a model. Every path lives under a directory this file made with its own prefix.

const PREFIX = "popeye-reflection-test-";
const made = new Set<string>();
const children: Array<ChildProcess> = [];

const tempDir = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), PREFIX)));
  made.add(dir);
  return dir;
};

afterEach(async () => {
  for (const child of children.splice(0)) {
    // A child without a pid never started; kill() on it would signal this process group.
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
  for (const dir of made) {
    // Remove only a directory this file made, directly under the temp root, with its prefix.
    if (!basename(dir).startsWith(PREFIX) || dirname(dir) !== realpathSync(tmpdir())) {
      throw new Error(`refusing to remove ${dir}`);
    }
    rmSync(dir, { force: true, recursive: true });
  }
  made.clear();
});

interface Sent {
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly executable: string;
  readonly payload: Record<string, unknown>;
}

const EXECUTABLE = "/invented/bin/reflect-intake";
const ENV = { HOME: "/invented/home", REFLECT_INTAKE_WORK_PARENT: '{"authority":"gb","id":"t-1"}' };

class SimulatedCrash extends Error {}

const harness = (
  overrides: Partial<ReflectionProducerOptions> & {
    readonly crashAt?: ReflectionFaultPoint;
    readonly liveness?: Liveness;
    readonly spawnInitiates?: boolean;
  } = {},
) => {
  const sent: Array<Sent> = [];
  let clock = 0;
  let activation = 0;
  const stateRoot = overrides.stateRoot ?? join(tempDir(), "reflection");
  const producer = makeReflectionProducer({
    env: ENV,
    executable: EXECUTABLE,
    fault: (point) => {
      if (point === overrides.crashAt) throw new SimulatedCrash(point);
    },
    isAlive: () => overrides.liveness ?? "dead",
    newActivationId: () =>
      `00000000-0000-4000-8000-${String(++activation).padStart(12, "0")}${""}`.slice(0, 36),
    now: () => `2026-09-27T10:00:${String(++clock).padStart(2, "0")}.000Z`,
    pid: 1111,
    spawnHook: (executable, args, payload, env) => {
      sent.push({ args, env, executable, payload: JSON.parse(payload) as Record<string, unknown> });
      return overrides.spawnInitiates ?? true;
    },
    stateRoot,
    ...overrides,
  });
  return { producer, sent, stateRoot };
};

const record = (stateRoot: string, sessionId: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(stateRoot, `${sessionId}.json`), "utf8")) as Record<string, unknown>;

/** A second process on the same machine: another pid, the same state root. */
const nextProcess = (stateRoot: string, liveness: Liveness = "dead") =>
  harness({ liveness, pid: 2222, stateRoot });

describe("enablement: POPEYE_REFLECT_INTAKE", () => {
  test("unset, empty, relative, a directory, or a non-executable file turns reflection off", () => {
    const dir = tempDir();
    const plain = join(dir, "plain");
    writeFileSync(plain, "not executable\n", { mode: 0o644 });
    const stateRoot = join(dir, "reflection");
    for (const value of [undefined, "", "bin/reflect-intake", dir, plain]) {
      const env = value === undefined ? {} : { [REFLECT_INTAKE_ENV]: value };
      expect(reflectionExecutable(env)).toBeUndefined();
      expect(reflectionProducerFromEnv(env, stateRoot)).toBeUndefined();
    }
    expect(existsSync(stateRoot)).toBe(false);
  });

  test("an absolute path to an executable file turns it on", () => {
    const dir = tempDir();
    const executable = join(dir, "reflect-intake");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(executable, 0o755);
    const env = { [REFLECT_INTAKE_ENV]: executable };
    expect(reflectionExecutable(env)).toBe(executable);
    expect(reflectionProducerFromEnv(env, join(dir, "reflection"))).toBeDefined();
  });
});

describe("the durable send", () => {
  test("a start writes the start record, then sends argv and one payload with the env unchanged", () => {
    const { producer, sent, stateRoot } = harness();
    const activationId = producer.start("created", "sess-a");
    expect(sent).toEqual([
      {
        args: ["hook", "popeye", "created"],
        env: ENV,
        executable: EXECUTABLE,
        payload: {
          activationId,
          event: "created",
          occurredAt: "2026-09-27T10:00:01.000Z",
          pid: 1111,
          sessionId: "sess-a",
        },
      },
    ]);
    expect(sent[0]?.env).toBe(ENV);
    expect(record(stateRoot, "sess-a")).toEqual({
      activationId,
      closed: false,
      event: "created",
      pid: 1111,
      sessionId: "sess-a",
      startedAt: "2026-09-27T10:00:01.000Z",
    });
  });

  test("a close sends the drain fact and marks the record closed; a head exit is a clean close", () => {
    const { producer, sent, stateRoot } = harness();
    const a = producer.start("created", "sess-b") ?? "";
    producer.close("sess-b", a, { drainedWithinGrace: false, kind: "close" });
    expect(sent[1]).toMatchObject({
      args: ["hook", "popeye", "closed"],
      payload: { activationId: a, drainedWithinGrace: false, event: "closed", sessionId: "sess-b" },
    });
    expect(record(stateRoot, "sess-b").closed).toBe(true);
    const b = producer.start("resumed", "sess-b") ?? "";
    producer.close("sess-b", b, { kind: "head-exit" });
    expect(sent[3]?.payload).toMatchObject({
      activationId: b,
      drainedWithinGrace: true,
      headExit: true,
    });
    expect(record(stateRoot, "sess-b")).toMatchObject({ activationId: b, closed: true });
  });

  test("payloads carry no transcript, parent, or invocation field", () => {
    const { producer, sent } = harness();
    const a = producer.start("created", "sess-c") ?? "";
    producer.close("sess-c", a, { drainedWithinGrace: true, kind: "close" });
    for (const { payload } of sent) {
      for (const key of Object.keys(payload)) {
        expect([
          "activationId",
          "drainedWithinGrace",
          "event",
          "headExit",
          "occurredAt",
          "pid",
          "reconciled",
          "sessionId",
          "startedAt",
        ]).toContain(key);
      }
    }
  });

  test("a failed start record still sends; a throwing spawn never throws", () => {
    const dir = tempDir();
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "a file where the state directory should be\n");
    const { producer, sent } = harness({ stateRoot: join(blocked, "reflection") });
    expect(producer.start("created", "sess-d")).toBeDefined();
    expect(sent).toHaveLength(1);
    const throwing = makeReflectionProducer({
      env: ENV,
      executable: EXECUTABLE,
      spawnHook: () => {
        throw new Error("spawn EAGAIN (invented)");
      },
      stateRoot: join(dir, "reflection"),
    });
    expect(() => throwing.start("created", "sess-e")).not.toThrow();
    expect(() => throwing.close("sess-e", "x", { kind: "head-exit" })).not.toThrow();
  });

  test("a send that was not initiated leaves the record open for the sweep", () => {
    const { producer, stateRoot } = harness({ spawnInitiates: false });
    const a = producer.start("created", "sess-f") ?? "";
    producer.close("sess-f", a, { drainedWithinGrace: true, kind: "close" });
    expect(record(stateRoot, "sess-f").closed).toBe(false);
  });
});

describe("AC2: the sweep reconciles a forced termination as killed", () => {
  test("a dead process's open record gets one reconciled close; a second sweep sends nothing", () => {
    const first = harness();
    first.producer.start("created", "sess-k");
    // SIGKILL: no close ran. The next process sweeps.
    const next = nextProcess(first.stateRoot);
    const candidates = next.producer.candidates();
    expect(candidates.map((c) => c.sessionId)).toEqual(["sess-k"]);
    next.producer.reconcile(candidates, new Set(["sess-k"]));
    expect(next.sent).toHaveLength(1);
    expect(next.sent[0]).toMatchObject({ args: ["hook", "popeye", "closed"] });
    expect(next.sent[0]?.payload).toEqual({
      activationId: first.sent[0]?.payload.activationId,
      event: "closed",
      pid: 1111,
      reconciled: true,
      sessionId: "sess-k",
      startedAt: "2026-09-27T10:00:01.000Z",
    });
    const all = [...first.sent, ...next.sent].filter((s) => s.payload.event === "closed");
    expect(all.some((s) => s.payload.drainedWithinGrace === true)).toBe(false);
    expect(record(first.stateRoot, "sess-k").closed).toBe(true);
    const again = nextProcess(first.stateRoot);
    again.producer.reconcile(again.producer.candidates(), new Set(["sess-k"]));
    expect(again.sent).toEqual([]);
  });

  test.each(["alive", "unknown"] as const)(
    "a %s process's record is left untouched and nothing is sent",
    (liveness) => {
      const first = harness();
      first.producer.start("created", "sess-l");
      const before = readFileSync(join(first.stateRoot, "sess-l.json"), "utf8");
      const next = nextProcess(first.stateRoot, liveness);
      expect(next.producer.candidates()).toEqual([]);
      next.producer.reconcile([record(first.stateRoot, "sess-l") as never], new Set(["sess-l"]));
      expect(next.sent).toEqual([]);
      expect(readFileSync(join(first.stateRoot, "sess-l.json"), "utf8")).toBe(before);
    },
  );

  test("a record the Journal no longer lists is left alone", () => {
    const first = harness();
    first.producer.start("created", "sess-m");
    const next = nextProcess(first.stateRoot);
    next.producer.reconcile(next.producer.candidates(), new Set(["sess-other"]));
    expect(next.sent).toEqual([]);
    expect(record(first.stateRoot, "sess-m").closed).toBe(false);
  });

  test("malformed records and leftover temporary files are skipped", () => {
    const first = harness();
    mkdirSync(first.stateRoot, { recursive: true });
    writeFileSync(join(first.stateRoot, "sess-n.json"), "{not json");
    writeFileSync(join(first.stateRoot, "sess-o.json.1111.x.tmp"), "{}");
    writeFileSync(
      join(first.stateRoot, "renamed.json"),
      JSON.stringify({
        activationId: "a",
        closed: false,
        event: "created",
        pid: 5,
        sessionId: "sess-p",
        startedAt: "t",
      }),
    );
    const next = nextProcess(first.stateRoot);
    expect(next.producer.candidates()).toEqual([]);
  });
});

describe("crash points: a crash never loses a close silently or claims a clean one", () => {
  test("after the start record, before the start send: the sweep closes the activation as killed", () => {
    const first = harness({ crashAt: "after-start-record" });
    expect(first.producer.start("created", "sess-q")).toBeUndefined();
    expect(first.sent).toEqual([]);
    const next = nextProcess(first.stateRoot);
    next.producer.reconcile(next.producer.candidates(), new Set(["sess-q"]));
    expect(next.sent.map((s) => s.payload.reconciled)).toEqual([true]);
  });

  test("after the close send, before the mark: the record stays open and the sweep re-sends", () => {
    const first = harness({ crashAt: "after-close-send" });
    const a = first.producer.start("created", "sess-r") ?? "";
    first.producer.close("sess-r", a, { drainedWithinGrace: true, kind: "close" });
    expect(first.sent.map((s) => s.payload.event)).toEqual(["created", "closed"]);
    expect(record(first.stateRoot, "sess-r").closed).toBe(false);
    const next = nextProcess(first.stateRoot);
    next.producer.reconcile(next.producer.candidates(), new Set(["sess-r"]));
    expect(next.sent.map((s) => s.payload)).toEqual([
      expect.objectContaining({ activationId: a, reconciled: true }),
    ]);
  });

  test("after a reconciled send, before its mark: the next sweep re-sends the identical payload", () => {
    const first = harness();
    first.producer.start("created", "sess-s");
    const crashed = harness({
      crashAt: "after-reconcile-send",
      pid: 2222,
      stateRoot: first.stateRoot,
    });
    crashed.producer.reconcile(crashed.producer.candidates(), new Set(["sess-s"]));
    expect(record(first.stateRoot, "sess-s").closed).toBe(false);
    const next = harness({ pid: 3333, stateRoot: first.stateRoot });
    next.producer.reconcile(next.producer.candidates(), new Set(["sess-s"]));
    expect(next.sent.map((s) => s.payload)).toEqual(crashed.sent.map((s) => s.payload));
    expect(record(first.stateRoot, "sess-s").closed).toBe(true);
  });

  test("a close from an older activation never marks a newer activation's record", () => {
    const { producer, stateRoot } = harness();
    const a = producer.start("created", "sess-t") ?? "";
    const b = producer.start("resumed", "sess-t") ?? "";
    producer.close("sess-t", a, { drainedWithinGrace: true, kind: "close" });
    expect(record(stateRoot, "sess-t")).toMatchObject({ activationId: b, closed: false });
  });

  test("a start record is replaced atomically: no temporary file is left behind", () => {
    const { producer, stateRoot } = harness();
    const a = producer.start("created", "sess-u") ?? "";
    producer.close("sess-u", a, { kind: "head-exit" });
    expect(readdirSync(stateRoot)).toEqual(["sess-u.json"]);
  });
});

describe("the real spawn against a stub hook", () => {
  test("the stub receives argv, one stdin payload, and the caller environment; it is reaped", async () => {
    const dir = tempDir();
    const stub = join(dir, "stub-hook.sh");
    writeFileSync(
      stub,
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$STUB_OUT.args"\ncat > "$STUB_OUT.stdin"\nprintf \'%s\' "$REFLECT_INTAKE_WORK_PARENT" > "$STUB_OUT.env"\nexit 0\n',
      { mode: 0o755 },
    );
    chmodSync(stub, 0o755);
    const out = join(dir, "out");
    const env = {
      PATH: "/usr/bin:/bin",
      REFLECT_INTAKE_WORK_PARENT: ENV.REFLECT_INTAKE_WORK_PARENT,
      STUB_OUT: out,
    };
    const payload = '{"event":"created","sessionId":"sess-v"}';
    const child = spawnDetachedHook(stub, ["hook", "popeye", "created"], payload, env);
    expect(child?.pid).toBeTypeOf("number");
    if (child === undefined) throw new Error("no child");
    children.push(child);
    const exit = await new Promise<number | null>((resolve) => {
      if (child.exitCode !== null) resolve(child.exitCode);
      else child.once("exit", (code) => resolve(code));
    });
    expect(exit).toBe(0);
    expect(readFileSync(`${out}.args`, "utf8")).toBe("hook\npopeye\ncreated\n");
    expect(readFileSync(`${out}.stdin`, "utf8")).toBe(payload);
    expect(readFileSync(`${out}.env`, "utf8")).toBe(ENV.REFLECT_INTAKE_WORK_PARENT);
    const pid = child.pid;
    if (pid === undefined) throw new Error("no pid");
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("a missing executable spawns nothing and never throws", () => {
    const dir = tempDir();
    const child = spawnDetachedHook(join(dir, "absent"), ["hook"], "{}", {});
    expect(child?.pid).toBeUndefined();
  });
});
