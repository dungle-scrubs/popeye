import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";

import { createMemoryJournalBacking, JournalMemory } from "@dungle-scrubs/popeye-journal";
import { Effect, Layer, Stream } from "effect";
import { afterEach, describe, expect, test } from "vitest";

import {
  Driver,
  FirstPartyDriverDefault,
  makeReflectionProducer,
  makeSessionLifecycle,
  Provider,
  type ProviderService,
  SessionLifecycle,
  ToolRegistryLive,
} from "../compose.js";
import type { HeadWriter } from "./head-wire.js";
import { runPrintHead } from "./print.js";
import { RpcInteractionsLive, runRpcHead } from "./rpc.js";

// The Popeye close contract at the Heads (RFC-03 slice 16, ADR-0002): a Head's normal exit
// reports a clean close without calling closeSession, a failed loop reports nothing, and an
// explicit RPC close is never reported twice. Invented prompts and a scripted Provider only; the
// reflection producer's spawn is a recording fake and its start records live in a directory
// this file made.

const PREFIX = "popeye-head-reflection-test-";
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

const provider: ProviderService = {
  streamAssistant: () =>
    Stream.fromIterable([
      { _tag: "textDelta" as const, text: "Invented answer." },
      { _tag: "done" as const, stopReason: "done" as const },
    ]),
};

const quietWriter: HeadWriter = { write: () => Effect.void };

interface Sent {
  readonly args: ReadonlyArray<string>;
  readonly payload: Record<string, unknown>;
}

const setup = (options: { readonly pid?: number; readonly stateRoot?: string } = {}) => {
  let stateRoot = options.stateRoot;
  if (stateRoot === undefined) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), PREFIX)));
    made.add(dir);
    stateRoot = join(dir, "reflection");
  }
  const sent: Array<Sent> = [];
  const producer = makeReflectionProducer({
    env: {},
    executable: "/invented/bin/reflect-intake",
    isAlive: () => "dead",
    pid: options.pid ?? 4001,
    spawnHook: (_executable, args, payload) => {
      sent.push({ args, payload: JSON.parse(payload) as Record<string, unknown> });
      return true;
    },
    stateRoot,
  });
  const lifecycle = makeSessionLifecycle({ producer });
  const backing = createMemoryJournalBacking();
  const layer = Layer.mergeAll(
    FirstPartyDriverDefault({ lifecycle }).pipe(
      Layer.provide(
        Layer.mergeAll(
          JournalMemory(backing),
          Layer.succeed(Provider, provider),
          ToolRegistryLive([]),
        ),
      ),
    ),
    RpcInteractionsLive,
    Layer.succeed(SessionLifecycle, lifecycle),
  );
  return { layer, producer, sent, stateRoot };
};

const closes = (sent: ReadonlyArray<Sent>) => sent.filter((s) => s.payload.event === "closed");

describe("D2: the Popeye close contract at the Heads", () => {
  test("a normal print-Head run ends with one clean close and a closed start record", async () => {
    const { layer, sent, stateRoot } = setup();
    const exit = await Effect.runPromise(
      runPrintHead({ errorWriter: quietWriter, prompts: ["Say hello."], writer: quietWriter }).pipe(
        Effect.provide(layer),
      ),
    );
    expect(exit).toBe(0);
    expect(sent.map((s) => s.args.join(" "))).toEqual([
      "hook popeye created",
      "hook popeye closed",
    ]);
    const sessionId = String(sent[0]?.payload.sessionId);
    expect(closes(sent)[0]?.payload).toMatchObject({
      activationId: sent[0]?.payload.activationId,
      drainedWithinGrace: true,
      headExit: true,
      sessionId,
    });
    const record = JSON.parse(readFileSync(join(stateRoot, `${sessionId}.json`), "utf8")) as {
      closed: boolean;
    };
    expect(record.closed).toBe(true);
  });

  test("a loop that fails reports no close; the next process's sweep reconciles it as killed", async () => {
    const first = setup();
    const exit = await Effect.runPromise(
      runPrintHead({
        errorWriter: quietWriter,
        prompts: ["/Not A Command!"],
        writer: quietWriter,
      }).pipe(Effect.provide(first.layer)),
    );
    expect(exit).not.toBe(0);
    expect(closes(first.sent)).toEqual([]);
    const sessionId = String(first.sent[0]?.payload.sessionId);
    const record = JSON.parse(readFileSync(join(first.stateRoot, `${sessionId}.json`), "utf8")) as {
      closed: boolean;
    };
    expect(record.closed).toBe(false);
    // The next Popeye process on the same Journal directory sweeps before its own send.
    const next = setup({ pid: 4002, stateRoot: first.stateRoot });
    next.producer.reconcile(next.producer.candidates(), new Set([sessionId]));
    expect(closes(next.sent).map((s) => s.payload)).toEqual([
      expect.objectContaining({ reconciled: true, sessionId }),
    ]);
    expect(closes(next.sent).some((s) => s.payload.drainedWithinGrace === true)).toBe(false);
  });

  test("an explicit RPC close followed by end of input gives exactly one close report", async () => {
    const { layer, sent } = setup();
    await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver;
        const session = yield* driver.createSession();
        const input = Readable.from(
          `${JSON.stringify({ _tag: "close", id: "close-1", sessionId: session.id })}\n`,
        );
        return yield* runRpcHead({ input, writer: quietWriter });
      }).pipe(Effect.provide(layer)),
    );
    expect(closes(sent)).toHaveLength(1);
    expect(closes(sent)[0]?.payload).toMatchObject({ drainedWithinGrace: true });
    expect(closes(sent)[0]?.payload).not.toHaveProperty("headExit");
  });

  test("end of RPC input reports a clean close for each Session still open", async () => {
    const { layer, sent } = setup();
    await Effect.runPromise(
      Effect.gen(function* () {
        const input = Readable.from(
          `${[
            { _tag: "create", id: "create-1" },
            { _tag: "create", id: "create-2" },
          ]
            .map((frame) => JSON.stringify(frame))
            .join("\n")}\n`,
        );
        return yield* runRpcHead({ input, writer: quietWriter });
      }).pipe(Effect.provide(layer)),
    );
    const created = sent.filter((s) => s.payload.event === "created");
    expect(created).toHaveLength(2);
    expect(
      closes(sent)
        .map((s) => s.payload.sessionId)
        .sort(),
    ).toEqual(created.map((s) => s.payload.sessionId).sort());
    for (const close of closes(sent)) expect(close.payload).toMatchObject({ headExit: true });
  });
});
