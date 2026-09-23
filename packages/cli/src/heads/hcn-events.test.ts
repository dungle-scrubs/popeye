import { describe, expect, test } from "vitest";

import {
  classifyFailure,
  compactionAppliedEvent,
  compactionStartedEvent,
  doneEvent,
  failureEvent,
  HCN_EXIT_CODES,
  hcnExitCodeForStopReason,
  identityEvent,
  TRUNCATION_NOTE,
  terminalEventsForTurn,
} from "./hcn-events.js";

describe("classifyFailure evaluates the taxonomy in RFC order", () => {
  test("status 429 wins over auth wording", () => {
    expect(
      classifyFailure({
        detail: "Unauthorized: rate pressure at 429",
        reason: "provider_error",
        status: 429,
        transient: true,
      }),
    ).toBe("rate-limit");
  });

  test("auth status and auth wording map to auth", () => {
    expect(classifyFailure({ detail: "boom", reason: "provider_error", status: 401 })).toBe("auth");
    expect(classifyFailure({ detail: "boom", reason: "provider_error", status: 403 })).toBe("auth");
    expect(
      classifyFailure({ detail: "Invalid API key for model.", reason: "provider_error" }),
    ).toBe("auth");
  });

  test("budget maps before transient transport", () => {
    expect(
      classifyFailure({ detail: "overflow", reason: "budget_exceeded", transient: true }),
    ).toBe("budget");
  });

  test("transient provider errors map to transport", () => {
    expect(
      classifyFailure({ detail: "socket hang up", reason: "provider_error", transient: true }),
    ).toBe("transport");
  });

  test("turn and journal failures fall through to task", () => {
    expect(classifyFailure({ detail: "x", reason: "turn_failure" })).toBe("task");
    expect(classifyFailure({ detail: "x", reason: "journal_failure" })).toBe("task");
  });

  test("non-transient provider errors with no signal map to task, never to no class", () => {
    expect(classifyFailure({ detail: "weird provider verdict", reason: "provider_error" })).toBe(
      "task",
    );
  });
});

describe("identity event", () => {
  test("emits harness-minted identity with static capabilities", () => {
    expect(identityEvent("session-1")).toEqual({
      kind: "identity",
      sessionId: "session-1",
      authority: "harness-minted",
      capabilities: expect.objectContaining({
        vision: false,
        images: false,
        streaming: "token",
        session: true,
        grantedCapabilities: [],
        compactionReporting: {
          source: "stream",
          states: ["started", "compacted"],
          tokens: false,
        },
      }),
    });
  });

  test("carries snapshot audit grants sorted alongside static claims", () => {
    expect(identityEvent("session-1", ["session-name", "compact"])).toMatchObject({
      capabilities: expect.objectContaining({ grantedCapabilities: ["compact", "session-name"] }),
    });
  });
});

describe("compaction events carry counts in detail prose", () => {
  test("started and compacted states with entry and slice counts", () => {
    expect(compactionStartedEvent({ entriesCovered: 40, sliceCount: 3 })).toEqual({
      kind: "compaction",
      state: "started",
      detail: "compacting 40 entries in 3 slices",
    });
    expect(compactionAppliedEvent({ entriesCovered: 40, sliceCount: 3 })).toEqual({
      kind: "compaction",
      state: "compacted",
      detail: "compacted 40 entries from 3 slices",
    });
  });
});

describe("terminal events per stop reason", () => {
  test("done ends message plus done-clean", () => {
    const outcome = terminalEventsForTurn({ stopReason: "done", text: "Answer." });
    expect(outcome).toEqual({
      events: [{ kind: "message", role: "assistant", text: "Answer." }, doneEvent(0, "clean")],
      exitCode: 0,
    });
  });

  test("truncated ends done-clean with a truncation note and no limit event", () => {
    const outcome = terminalEventsForTurn({ stopReason: "truncated", text: "Partial." });
    expect(outcome.events.map((event) => event.kind)).toEqual(["message", "done"]);
    expect(outcome.events[0]).toEqual({
      kind: "message",
      role: "assistant",
      text: `Partial.\n${TRUNCATION_NOTE}`,
    });
    expect(outcome.events[1]).toEqual(doneEvent(0, "clean"));
    expect(outcome.exitCode).toBe(0);
  });

  test("aborted ends killed with exit 1", () => {
    const outcome = terminalEventsForTurn({ stopReason: "aborted", text: "Cut off." });
    expect(outcome.events.at(-1)).toEqual(doneEvent(1, "killed"));
    expect(outcome.exitCode).toBe(1);
  });

  test("error ends terminal error plus failure plus done-failed with class", () => {
    const outcome = terminalEventsForTurn({
      failure: { detail: "socket hang up", reason: "provider_error", transient: true },
      stopReason: "error",
      text: "Partial.",
    });
    const failure = failureEvent("transport", "socket hang up");
    expect(outcome.events).toEqual([
      { kind: "message", role: "assistant", text: "Partial." },
      { kind: "error", message: "socket hang up", terminal: true },
      failure,
      doneEvent(1, "failed", failure),
    ]);
    expect(outcome.exitCode).toBe(1);
  });

  test("head-boundary defect maps to task with exit 1", () => {
    const outcome = terminalEventsForTurn({
      defect: { message: "Injected provider defect.", tag: "Error" },
      stopReason: "error",
      text: "",
    });
    expect(outcome.events.map((event) => event.kind)).toEqual([
      "message",
      "error",
      "failure",
      "done",
    ]);
    expect(outcome.events[2]).toMatchObject({ class: "task" });
    expect(outcome.exitCode).toBe(1);
  });
});

describe("hcn exit matrix", () => {
  test("maps every stop reason with abort at 1, never 2", () => {
    expect(hcnExitCodeForStopReason("done")).toBe(0);
    expect(hcnExitCodeForStopReason("truncated")).toBe(0);
    expect(hcnExitCodeForStopReason("error")).toBe(1);
    expect(hcnExitCodeForStopReason("aborted")).toBe(1);
    expect(hcnExitCodeForStopReason("toolCalls")).toBe(1);
    expect(HCN_EXIT_CODES.turnFailure).toBe(1);
  });
});
