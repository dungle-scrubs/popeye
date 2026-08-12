/**
 * Owns the Branch-derived Session view — the only Branch fold in the Kernel.
 * It exists so Branch → settings + revision + contains hide behind one deep interface getView.
 *
 * Why this module: deriveSettings (model/name/thinkingLevel) and branch-contains and
 * expectedRevision gating were split between driver.ts (deriveSettings loop + cache Ref),
 * mailbox.ts (StaleRevision check before + inside enqueue), and sessions.ts (resume via
 * SessionStore). Each interface was ≈ one loop or one check, bugs hid between them:
 * a stale expectedRevision could pass Mailbox's pre-check but fail Driver's branch check,
 * and adding a 4th Branch-derived setting touched 3 files. This module hides the one
 * Branch fold (model_change / session_name / thinking_change newest-wins), the
 * branchContains predicate, and the revision gate behind getView. Callers depend on
 * SessionView.getView(sessionId) → View, not on scanning Entries themselves.
 * SessionStore remains the single Journal caller per D-001; SessionView is its
 * consumer (store.getBranch + store.countDurableLines + deriveSettings), so the
 * Journal seam stays in one place. The seam is Branch data: two adapters justify it —
 * LiveSessionView over SessionStore and FakeView over in-memory branch arrays in tests.
 * Not responsible for Progress phase (ProgressHub owns that), for Tool batch execution
 * (tool-batch owns that), or for recovery planning (recovery.ts owns that).
 */

import {
  type Entry,
  type EntryId,
  JournalError as JournalErrorClass,
  type JournalFailure,
  type SessionId,
} from "@pop-eye/journal";
import { StaleRevision } from "@pop-eye/protocol";
import { Context, Effect, Layer, Schema } from "effect";
import {
  ModelChangePayloadSchema,
  SessionNamePayloadSchema,
  ThinkingChangePayloadSchema,
} from "./entry-payloads.js";
import type { ThinkingLevel } from "./provider.js";
import { SessionStore } from "./session-store.js";

const strict: { readonly onExcessProperty: "error" } = { onExcessProperty: "error" };
const decodeModelChange = Schema.decodeUnknown(ModelChangePayloadSchema, strict);
const decodeSessionName = Schema.decodeUnknown(SessionNamePayloadSchema, strict);
const decodeThinkingChange = Schema.decodeUnknown(ThinkingChangePayloadSchema, strict);

export interface SessionSettings {
  readonly model?: string;
  readonly name?: string;
  readonly thinkingLevel?: ThinkingLevel;
}

export interface SessionView {
  readonly branch: ReadonlyArray<Entry>;
  readonly leaf: Entry;
  readonly revision: number;
  readonly sessionId: SessionId;
  readonly settings: SessionSettings;
  contains(entryId: EntryId): boolean;
}

export interface SessionViewService {
  readonly contains: (branch: ReadonlyArray<Entry>, entryId: EntryId) => boolean;
  readonly deriveSettings: (
    branch: ReadonlyArray<Entry>,
  ) => Effect.Effect<SessionSettings, JournalErrorClass>;
  readonly getView: (sessionId: SessionId) => Effect.Effect<SessionView, JournalFailure>;
  readonly requireRevision: (
    expectedRevision: number | undefined,
    actualRevision: number,
  ) => Effect.Effect<void, StaleRevision>;
}

export class SessionViewTag extends Context.Tag("@pop-eye/kernel/SessionView")<
  SessionViewTag,
  SessionViewService
>() {}

export const SessionView = SessionViewTag;

const entrySchemaMismatch = (entry: Entry, cause: unknown): JournalErrorClass =>
  new JournalErrorClass({
    cause,
    corruptionClass: "schema_mismatch",
    message: `Entry ${entry.id} payload does not match ${entry.kind}: ${String(cause)}`,
  });

export const deriveSettings = (
  branch: ReadonlyArray<Entry>,
): Effect.Effect<SessionSettings, JournalErrorClass> =>
  Effect.gen(function* () {
    let model: string | undefined;
    let name: string | undefined;
    let thinkingLevel: ThinkingLevel | undefined;
    for (const entry of branch) {
      if (entry.kind === "model_change") {
        const payload = yield* decodeModelChange(entry.payload).pipe(
          Effect.mapError((cause) => entrySchemaMismatch(entry, cause)),
        );
        model = payload.model;
      }
      if (entry.kind === "session_name") {
        const payload = yield* decodeSessionName(entry.payload).pipe(
          Effect.mapError((cause) => entrySchemaMismatch(entry, cause)),
        );
        name = payload.name;
      }
      if (entry.kind === "thinking_change") {
        const payload = yield* decodeThinkingChange(entry.payload).pipe(
          Effect.mapError((cause) => entrySchemaMismatch(entry, cause)),
        );
        thinkingLevel = payload.thinkingLevel;
      }
    }
    return {
      ...(model === undefined ? {} : { model }),
      ...(name === undefined ? {} : { name }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    };
  });

export const branchContains = (branch: ReadonlyArray<Entry>, entryId: EntryId): boolean =>
  branch.some((entry) => entry.id === entryId);

export const requireRevision = (
  expectedRevision: number | undefined,
  actualRevision: number,
): Effect.Effect<void, StaleRevision> =>
  expectedRevision === undefined || expectedRevision === actualRevision
    ? Effect.void
    : Effect.fail(new StaleRevision({ actual: actualRevision, expected: expectedRevision }));

const makeView = (
  sessionId: SessionId,
  branch: ReadonlyArray<Entry>,
  revision: number,
  settings: SessionSettings,
): SessionView => {
  const leaf = branch.at(-1);
  if (leaf === undefined) {
    throw new JournalErrorClass({
      corruptionClass: "dangling_leaf_reference",
      message: `Session ${sessionId} has no current Branch.`,
    });
  }
  return {
    branch,
    contains: (entryId: EntryId) => branchContains(branch, entryId),
    leaf,
    revision,
    sessionId,
    settings,
  };
};

const makeSessionViewService = (
  store: import("./session-store.js").SessionStoreService,
): SessionViewService => ({
  contains: branchContains,
  deriveSettings,
  getView: (sessionId: SessionId) =>
    Effect.gen(function* () {
      const branch = yield* store.getBranch(sessionId);
      const revision = yield* store.countDurableLines(sessionId);
      const settings = yield* deriveSettings(branch);
      const leaf = branch.at(-1);
      if (leaf === undefined) {
        return yield* new JournalErrorClass({
          corruptionClass: "dangling_leaf_reference",
          message: `Session ${sessionId} has no current Branch.`,
        });
      }
      return {
        branch,
        contains: (entryId: EntryId) => branchContains(branch, entryId),
        leaf,
        revision,
        sessionId,
        settings,
      } satisfies SessionView;
    }),
  requireRevision,
});

export const SessionViewLive: Layer.Layer<SessionViewTag, never, SessionStore> = Layer.effect(
  SessionViewTag,
  Effect.gen(function* () {
    const store = yield* SessionStore;
    return makeSessionViewService(store as import("./session-store.js").SessionStoreService);
  }),
);

// Test helper: build a view from branch + revision without Journal
export const makeSessionViewForTest = (
  sessionId: SessionId,
  branch: ReadonlyArray<Entry>,
  revision: number,
): Effect.Effect<SessionView, JournalErrorClass> =>
  deriveSettings(branch).pipe(
    Effect.map((settings) => makeView(sessionId, branch, revision, settings)),
  );
