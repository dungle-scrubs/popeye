/**
 * Owns the Popeye-side HCN run event vocabulary (RFC-02 P1).
 * It exists so the hcn head emits HarnessEvents HCN already parses, with no
 * HCN-side change: identity first, token/message per the render-one rule,
 * ordered failure taxonomy, compaction states, and a terminal done.
 *
 * Why this module: the Head session loop owns lifecycle and the protocol
 * package owns Progress frames; neither knows the HCN vocabulary. The mapper
 * hides that translation (event shapes, failure-class order, exit matrix)
 * behind one deep interface so heads stay thin adapters and the contract is
 * tested here, not by spinning a Head.
 *
 * Not responsible for Session lifecycle (session-loop owns that), for wire
 * framing (head-wire owns NDJSON encoding), or for turn execution (the
 * kernel owns that). Auth detection reads only status codes and explicit
 * auth wording on the settled diagnostic, never model output.
 */

export const HCN_FAILURE_CLASSES = ["rate-limit", "auth", "budget", "task", "transport"] as const;

export type HcnFailureClass = (typeof HCN_FAILURE_CLASSES)[number];

export type HcnExitCause = "clean" | "failed" | "killed";

export interface HcnCapabilities {
  readonly vision: false;
  readonly images: false;
  readonly streaming: "token";
  readonly session: true;
  readonly source: "curated";
  readonly confidence: "none";
  readonly escalation: {
    readonly supported: false;
    readonly source: "unknown";
    readonly confidence: "none";
  };
  readonly compactionReporting: {
    readonly source: "stream";
    readonly states: ReadonlyArray<"started" | "compacted">;
    readonly tokens: false;
  };
  /**
   * Raw plugin capability names from the snapshot audit capabilityGrants.
   * HCN CapabilityResult has no member for these, so they ride alongside
   * the static claims rather than rewriting them. Phase 5 note: the HCN
   * popeye descriptor reader MUST tolerate this extra field.
   */
  readonly grantedCapabilities: ReadonlyArray<string>;
}

export type HcnEvent =
  | {
      readonly kind: "identity";
      readonly sessionId: string;
      readonly authority: "harness-minted";
      readonly capabilities: HcnCapabilities;
    }
  | { readonly kind: "token"; readonly text: string }
  | { readonly kind: "message"; readonly role: "assistant"; readonly text: string }
  | {
      readonly kind: "compaction";
      readonly state: "started" | "compacted";
      readonly detail: string;
    }
  | { readonly kind: "error"; readonly message: string; readonly terminal?: true }
  | {
      readonly kind: "failure";
      readonly class: HcnFailureClass;
      readonly retryable: boolean;
      readonly message: string;
    }
  | {
      readonly kind: "done";
      readonly exitCode: number;
      readonly cause: HcnExitCause;
      readonly failure?: {
        readonly class: HcnFailureClass;
        readonly retryable: boolean;
        readonly message: string;
      };
      readonly escalation: { readonly mode: "none"; readonly detection: "none" };
    };

export const hcnCapabilities = (
  grantedCapabilities: ReadonlyArray<string> = [],
): HcnCapabilities => ({
  vision: false,
  images: false,
  streaming: "token",
  session: true,
  source: "curated",
  confidence: "none",
  escalation: { supported: false, source: "unknown", confidence: "none" },
  compactionReporting: { source: "stream", states: ["started", "compacted"], tokens: false },
  grantedCapabilities: [...grantedCapabilities].sort(),
});

/**
 * HCN mode exit matrix (RFC-02 P1 item 4): done 0 clean, truncated 0 clean
 * with a message note, error 1 with failure class, aborted 1 killed,
 * toolCalls unreachable (the kernel consumes them), head-boundary defect 1
 * with failure class. Abort never reaches HCN as exit 2: 2 is invocation
 * refusal here, as in json mode.
 */
export const HCN_EXIT_CODES = {
  aborted: 1,
  done: 0,
  error: 1,
  toolCalls: 1,
  truncated: 0,
  turnFailure: 1,
} as const;

export type HcnExitCode = 0 | 1;

export type HcnStopReason = "aborted" | "done" | "error" | "toolCalls" | "truncated";

export const hcnExitCodeForStopReason = (stopReason: HcnStopReason): HcnExitCode =>
  HCN_EXIT_CODES[stopReason];

export const identityEvent = (
  sessionId: string,
  grantedCapabilities: ReadonlyArray<string> = [],
): HcnEvent => ({
  kind: "identity",
  sessionId,
  authority: "harness-minted",
  capabilities: hcnCapabilities(grantedCapabilities),
});

export interface SettledFailureInput {
  readonly reason: "budget_exceeded" | "journal_failure" | "provider_error" | "turn_failure";
  readonly detail: string;
  readonly status?: number;
  readonly transient?: boolean;
}

const AUTH_MESSAGE_PATTERN =
  /authentication|unauthorized|unauthorised|invalid[-_ ]?(api[-_ ]?key|key|token|credential)|api[-_ ]?key|not[-_ ]?logged[-_ ]?in|expired[-_ ]?(token|key|credential)|forbidden/i;

const isAuthStatus = (status: number): boolean => status === 401 || status === 403;

const isAuthFailure = (status: number | undefined, detail: string): boolean =>
  (status !== undefined && isAuthStatus(status)) || AUTH_MESSAGE_PATTERN.test(detail);

/**
 * Failure taxonomy, evaluated in RFC-02 P1 item 3 order: status 429 maps to
 * rate-limit; auth failures map to auth; BudgetExceeded maps to budget;
 * transient ProviderError maps to transport; turn_failure and journal
 * failures map to task. Anything unmatched maps to task, never to no class.
 */
export const classifyFailure = (input: SettledFailureInput): HcnFailureClass => {
  if (input.status === 429) {
    return "rate-limit";
  }
  if (isAuthFailure(input.status, input.detail)) {
    return "auth";
  }
  if (input.reason === "budget_exceeded") {
    return "budget";
  }
  if (input.reason === "provider_error" && input.transient === true) {
    return "transport";
  }
  return "task";
};

export const retryableOf = (failureClass: HcnFailureClass): boolean =>
  failureClass === "rate-limit" || failureClass === "transport" || failureClass === "auth";

export const failureEvent = (
  failureClass: HcnFailureClass,
  message: string,
): Extract<HcnEvent, { readonly kind: "failure" }> => ({
  kind: "failure",
  class: failureClass,
  retryable: retryableOf(failureClass),
  message,
});

export const doneEvent = (
  exitCode: number,
  cause: HcnExitCause,
  failure?: Extract<HcnEvent, { readonly kind: "failure" }>,
): Extract<HcnEvent, { readonly kind: "done" }> => ({
  kind: "done",
  exitCode,
  cause,
  ...(failure === undefined
    ? {}
    : {
        failure: {
          class: failure.class,
          retryable: failure.retryable,
          message: failure.message,
        },
      }),
  escalation: { mode: "none", detection: "none" },
});

export interface CompactionCounts {
  readonly entriesCovered: number;
  readonly sliceCount: number;
}

export const compactionStartedEvent = (
  counts: CompactionCounts,
): Extract<HcnEvent, { readonly kind: "compaction" }> => ({
  kind: "compaction",
  state: "started",
  detail: `compacting ${counts.entriesCovered} entries in ${counts.sliceCount} slices`,
});

export const compactionAppliedEvent = (
  counts: CompactionCounts,
): Extract<HcnEvent, { readonly kind: "compaction" }> => ({
  kind: "compaction",
  state: "compacted",
  detail: `compacted ${counts.entriesCovered} entries from ${counts.sliceCount} slices`,
});

export const TRUNCATION_NOTE = "turn truncated: context reached its limit";

export interface HcnTurnOutcome {
  readonly events: ReadonlyArray<HcnEvent>;
  readonly exitCode: HcnExitCode;
}

/**
 * Renders the terminal event sequence for one settled turn. The caller has
 * already streamed identity first, token deltas, and compaction events; this
 * owns the trailing message event plus error/failure/done. Render-one rule:
 * the full turn text appears once, in the message event, never doubled with
 * the token deltas.
 */
export const terminalEventsForTurn = (options: {
  readonly stopReason: "aborted" | "done" | "error" | "toolCalls" | "truncated";
  readonly text: string;
  readonly failure?: SettledFailureInput;
  readonly defect?: { readonly message: string; readonly tag: string };
}): HcnTurnOutcome => {
  const messageText =
    options.stopReason === "truncated" ? `${options.text}\n${TRUNCATION_NOTE}` : options.text;
  const message: HcnEvent = { kind: "message", role: "assistant", text: messageText };
  if (options.stopReason === "done" || options.stopReason === "truncated") {
    return {
      events: [message, doneEvent(hcnExitCodeForStopReason(options.stopReason), "clean")],
      exitCode: hcnExitCodeForStopReason(options.stopReason),
    };
  }
  if (options.stopReason === "aborted") {
    return {
      events: [message, doneEvent(HCN_EXIT_CODES.aborted, "killed")],
      exitCode: HCN_EXIT_CODES.aborted,
    };
  }
  if (options.defect !== undefined) {
    const failure = failureEvent("task", `${options.defect.tag}: ${options.defect.message}`);
    return {
      events: [
        message,
        { kind: "error", message: options.defect.message, terminal: true },
        failure,
        doneEvent(HCN_EXIT_CODES.turnFailure, "failed", failure),
      ],
      exitCode: HCN_EXIT_CODES.turnFailure,
    };
  }
  const settled = options.failure ?? { detail: "Turn failed.", reason: "turn_failure" as const };
  const failureClass = classifyFailure(settled);
  const failure = failureEvent(failureClass, settled.detail);
  return {
    events: [
      message,
      { kind: "error", message: settled.detail, terminal: true },
      failure,
      doneEvent(hcnExitCodeForStopReason(options.stopReason), "failed", failure),
    ],
    exitCode: hcnExitCodeForStopReason(options.stopReason),
  };
};
