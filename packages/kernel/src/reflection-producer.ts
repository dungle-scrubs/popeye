/**
 * Owns the durable reflection send for Session lifecycle facts (ADR-0002).
 * It exists because the `session-lifecycle` Tap point may drop a notification by design, so it
 * cannot carry a fact that must reach the reflection intake. This module spawns the intake's
 * hook command directly, writes one start record per activation so a process that dies
 * without closing can be reconciled, and sweeps start records of dead processes.
 * Every entry point is best effort and never throws: reflection never blocks or fails a Session.
 * Popeye knows only the hook command's argv and stdin payload; envelopes, outboxes, authorities,
 * and gates belong to the intake.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

/** The environment variable naming the absolute path of the intake executable. */
export const REFLECT_INTAKE_ENV = "POPEYE_REFLECT_INTAKE";

export type ReflectionEnvironment = Readonly<Record<string, string | undefined>>;

export type ReflectionStartEvent = "created" | "resumed";

/** One activation's start record: the Popeye-side state file. */
export interface StartRecord {
  readonly activationId: string;
  readonly closed: boolean;
  readonly event: ReflectionStartEvent;
  readonly pid: number;
  readonly sessionId: string;
  readonly startedAt: string;
}

/** How an activation ended in a live process. */
export type CloseFacts =
  | { readonly drainedWithinGrace: boolean; readonly kind: "close" }
  | { readonly kind: "head-exit" };

export type Liveness = "alive" | "dead" | "unknown";

/**
 * Spawns the hook command once, detached, and never waits for it. Returns whether the spawn was
 * initiated (the child got a pid); a start record is marked closed only after an initiated send.
 */
export type SpawnHook = (
  executable: string,
  args: ReadonlyArray<string>,
  payload: string,
  env: ReflectionEnvironment,
) => boolean;

/** Points where a test may simulate the process dying. */
export type ReflectionFaultPoint =
  | "after-close-send"
  | "after-reconcile-send"
  | "after-start-record"
  | "after-start-send";

export interface ReflectionProducerOptions {
  readonly env: ReflectionEnvironment;
  readonly executable: string;
  /** Test seam: throws to simulate the process dying at a point. */
  readonly fault?: (point: ReflectionFaultPoint) => void;
  readonly isAlive?: (pid: number) => Liveness;
  readonly newActivationId?: () => string;
  readonly now?: () => string;
  readonly pid?: number;
  readonly spawnHook?: SpawnHook;
  /** The directory that holds one start record per Session. */
  readonly stateRoot: string;
}

export interface ReflectionProducer {
  /** Start records with `closed: false` whose process is dead. Never throws. */
  readonly candidates: () => ReadonlyArray<StartRecord>;
  /** Sends one closed report per activation. Never throws. */
  readonly close: (sessionId: string, activationId: string, facts: CloseFacts) => void;
  /**
   * Sends a reconciled close for each candidate the Journal still lists, then marks its record
   * closed. Never throws.
   */
  readonly reconcile: (
    candidates: ReadonlyArray<StartRecord>,
    journalSessionIds: ReadonlySet<string>,
  ) => void;
  /** Writes the start record, sends the start, and returns the activation ID. Never throws. */
  readonly start: (event: ReflectionStartEvent, sessionId: string) => string | undefined;
}

const HOOK_HARNESS = "popeye";
const SAFE_SESSION_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;

// ---------------------------------------------------------------------------
// Pure payload formatting. Key order is fixed, so equal inputs give equal bytes.
// ---------------------------------------------------------------------------

/** The stdin payload for a start. Built from the start record only, so a re-send is identical. */
export const startPayload = (record: StartRecord): string =>
  JSON.stringify({
    activationId: record.activationId,
    event: record.event,
    occurredAt: record.startedAt,
    pid: record.pid,
    sessionId: record.sessionId,
  });

/** The stdin payload for a close observed by the live process. */
export const closePayload = (
  sessionId: string,
  activationId: string,
  facts: CloseFacts,
  occurredAt: string,
  pid: number,
): string =>
  JSON.stringify({
    activationId,
    drainedWithinGrace: facts.kind === "close" ? facts.drainedWithinGrace : true,
    event: "closed",
    ...(facts.kind === "head-exit" ? { headExit: true } : {}),
    occurredAt,
    pid,
    sessionId,
  });

/**
 * The stdin payload for a reconciled close. Built from the dead activation's start record only,
 * so every re-send is byte-identical and the intake answers `duplicate`.
 */
export const reconciledPayload = (record: StartRecord): string =>
  JSON.stringify({
    activationId: record.activationId,
    event: "closed",
    pid: record.pid,
    reconciled: true,
    sessionId: record.sessionId,
    startedAt: record.startedAt,
  });

export const hookArgs = (event: "closed" | ReflectionStartEvent): ReadonlyArray<string> => [
  "hook",
  HOOK_HARNESS,
  event,
];

const parseStartRecord = (text: string): StartRecord | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.activationId !== "string" ||
    typeof record.closed !== "boolean" ||
    (record.event !== "created" && record.event !== "resumed") ||
    typeof record.pid !== "number" ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.sessionId !== "string" ||
    !SAFE_SESSION_ID.test(record.sessionId) ||
    typeof record.startedAt !== "string"
  ) {
    return undefined;
  }
  return {
    activationId: record.activationId,
    closed: record.closed,
    event: record.event,
    pid: record.pid,
    sessionId: record.sessionId,
    startedAt: record.startedAt,
  };
};

// ---------------------------------------------------------------------------
// Effects: enablement, liveness, spawn, start records.
// ---------------------------------------------------------------------------

/**
 * The intake executable, or undefined when reflection is off: the variable is unset, empty,
 * relative, or does not name an executable regular file.
 */
export const reflectionExecutable = (env: ReflectionEnvironment): string | undefined => {
  const value = env[REFLECT_INTAKE_ENV];
  if (value === undefined || value.length === 0 || !isAbsolute(value)) return undefined;
  try {
    if (!statSync(value).isFile()) return undefined;
    accessSync(value, constants.X_OK);
    return value;
  } catch {
    return undefined;
  }
};

/** Signal 0 liveness: ESRCH is dead, EPERM is alive, anything else is unknown. */
export const processLiveness = (pid: number): Liveness => {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
};

const childEnv = (env: ReflectionEnvironment): Record<string, string> => {
  const copy: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) copy[key] = value;
  }
  return copy;
};

/**
 * Spawns detached with stdin piped and stdout and stderr ignored, unrefs the child and its stdin,
 * writes the payload, and ends stdin. It never waits for the flush or the exit, so a wedged hook
 * cannot delay Popeye's exit. Returns the child for tests; production ignores it.
 */
export const spawnDetachedHook = (
  executable: string,
  args: ReadonlyArray<string>,
  payload: string,
  env: ReflectionEnvironment,
): ChildProcess | undefined => {
  try {
    const child = spawn(executable, [...args], {
      detached: true,
      env: childEnv(env),
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.stdin?.end(payload);
    child.unref();
    (child.stdin as { unref?: () => void } | null)?.unref?.();
    return child;
  } catch {
    return undefined;
  }
};

const recordPath = (stateRoot: string, sessionId: string): string | undefined =>
  SAFE_SESSION_ID.test(sessionId) ? join(stateRoot, `${sessionId}.json`) : undefined;

/** Temporary file then rename: a crash leaves the old record or the new one, never a torn one. */
const writeRecord = (stateRoot: string, record: StartRecord, pid: number): void => {
  const path = recordPath(stateRoot, record.sessionId);
  if (path === undefined) return;
  mkdirSync(stateRoot, { recursive: true });
  const temporary = `${path}.${pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
};

const readRecord = (stateRoot: string, sessionId: string): StartRecord | undefined => {
  const path = recordPath(stateRoot, sessionId);
  if (path === undefined) return undefined;
  try {
    return parseStartRecord(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

/** Marks the record closed only while it still belongs to this activation. Best effort. */
const markClosed = (
  stateRoot: string,
  sessionId: string,
  activationId: string,
  pid: number,
): void => {
  try {
    const record = readRecord(stateRoot, sessionId);
    if (record === undefined || record.activationId !== activationId || record.closed) return;
    writeRecord(stateRoot, { ...record, closed: true }, pid);
  } catch {
    // A failed mark leaves `closed: false`; the next sweep re-sends and the intake dedupes.
  }
};

const listRecords = (stateRoot: string): ReadonlyArray<StartRecord> => {
  let names: ReadonlyArray<string>;
  try {
    names = readdirSync(stateRoot);
  } catch {
    return [];
  }
  const records: Array<StartRecord> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = parseStartRecord(readFileSync(join(stateRoot, name), "utf8"));
      if (record !== undefined && name === `${record.sessionId}.json`) records.push(record);
    } catch {
      // An unreadable record is skipped; the sweep never guesses.
    }
  }
  return records;
};

// ---------------------------------------------------------------------------
// The producer
// ---------------------------------------------------------------------------

export const makeReflectionProducer = (options: ReflectionProducerOptions): ReflectionProducer => {
  const { env, executable, stateRoot } = options;
  const fault = options.fault ?? (() => {});
  const isAlive = options.isAlive ?? processLiveness;
  const newActivationId = options.newActivationId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  const pid = options.pid ?? process.pid;
  const spawnHook: SpawnHook =
    options.spawnHook ??
    ((file, args, payload, childEnvironment) =>
      spawnDetachedHook(file, args, payload, childEnvironment)?.pid !== undefined);

  const send = (event: "closed" | ReflectionStartEvent, payload: string): boolean => {
    try {
      return spawnHook(executable, hookArgs(event), payload, env);
    } catch {
      // A failed spawn is a lost send, never a Session failure.
      return false;
    }
  };

  return {
    candidates: () => {
      try {
        return listRecords(stateRoot).filter(
          (record) => !record.closed && record.pid !== pid && isAlive(record.pid) === "dead",
        );
      } catch {
        return [];
      }
    },
    close: (sessionId, activationId, facts) => {
      try {
        const initiated = send("closed", closePayload(sessionId, activationId, facts, now(), pid));
        fault("after-close-send");
        if (initiated) markClosed(stateRoot, sessionId, activationId, pid);
      } catch {
        // Best effort: the start record keeps `closed: false` and the sweep reconciles it.
      }
    },
    reconcile: (candidates, journalSessionIds) => {
      try {
        for (const candidate of candidates) {
          if (!journalSessionIds.has(candidate.sessionId)) continue;
          if (isAlive(candidate.pid) !== "dead") continue;
          const initiated = send("closed", reconciledPayload(candidate));
          fault("after-reconcile-send");
          if (initiated) markClosed(stateRoot, candidate.sessionId, candidate.activationId, pid);
        }
      } catch {
        // Best effort: an unmarked record is re-sent by the next sweep.
      }
    },
    start: (event, sessionId) => {
      try {
        const record: StartRecord = {
          activationId: newActivationId(),
          closed: false,
          event,
          pid,
          sessionId,
          startedAt: now(),
        };
        try {
          writeRecord(stateRoot, record, pid);
        } catch {
          // A failed start record still sends: the Journal Session holds the start fact.
        }
        fault("after-start-record");
        send(event, startPayload(record));
        fault("after-start-send");
        return record.activationId;
      } catch {
        return undefined;
      }
    },
  };
};

/** The producer for this environment, or undefined when reflection is off. */
export const reflectionProducerFromEnv = (
  env: ReflectionEnvironment,
  stateRoot: string,
): ReflectionProducer | undefined => {
  const executable = reflectionExecutable(env);
  return executable === undefined
    ? undefined
    : makeReflectionProducer({ env, executable, stateRoot });
};
