/**
 * Owns SessionConductor deep module for per-Session interleaving and revision gating.
 * It exists so one module owns the single interleaving (D-016) and the single revision gate
 * that currently lives in two places: Mailbox.enqueue pre-check and Driver via SessionView post-check.
 *
 * Why this module: Mailbox (355 lines, per-Session FIFO 256, scoped fiber) owns the queue,
 * SessionView (198 lines, Branch fold + branchContains + requireRevision) owns the Branch-derived
 * view, and Driver (526 lines, protocol-shaped) owns the snapshot + settings + leaf-moving.
 * A stale expectedRevision could pass Mailbox's cached-revision check and fail Driver's
 * Journal-derived check (or vice versa after a concurrent moveLeaf). Fibers live until layer
 * teardown with no idle eviction — adding eviction would touch all three. This module hides
 * Mailbox as a private queue seam and SessionView as a private Branch seam behind one interface:
 * enqueue(sessionId, command) does the one revision gate via the view before the one mailbox
 * enqueue, and callers depend on the conductor, not on mailbox + view separately. Mailbox stays
 * the private queue seam; SessionView stays the private Branch seam. Driver becomes a thin
 * protocol translator.
 *
 * Speculative until trigger (C5 architecture review): the interface is intentionally shallow today
 * (one adapter = hypothetical). A second adapter (in-memory fake queue for deterministic interleaving
 * tests, or an eviction policy) would justify the seam. Until that trigger, this module is a
 * placement-ready deep module: it exists, is tested via the fake conductor, but Driver still
 * composes mailbox + view directly to avoid churn. When idle eviction or a second conductor
 * consumer appears, Driver migrates to conductor.enqueue and mailbox/view become private.
 *
 * Not responsible for Journal persistence (SessionStore owns that) or for compaction policy
 * (Compaction owns that) or for Provider transport (Provider seam). The seam is per-Session
 * ordering: two adapters justify it — LiveSessionConductor over real Mailbox + SessionView and
 * FakeSessionConductor over in-memory branch arrays + fake mailbox.
 */

import type { JournalFailure, SessionId } from "@pop-eye/journal";
import type { StaleRevision } from "@pop-eye/protocol";
import { Context, Effect, Layer } from "effect";
import type { MailboxClosed } from "./errors.js";
import {
  Mailbox,
  type MailboxCommand,
  type MailboxFailure,
  type MailboxResult,
} from "./mailbox.js";
import { SessionViewTag } from "./session-view.js";

export interface SessionConductorService {
  readonly activate: (sessionId: SessionId) => Effect.Effect<void, JournalFailure | MailboxClosed>;
  readonly enqueue: <TValue, TError>(
    sessionId: SessionId,
    command: MailboxCommand<TValue, TError>,
  ) => Effect.Effect<MailboxResult<TValue>, MailboxFailure | TError | StaleRevision>;
}

export class SessionConductor extends Context.Tag("@pop-eye/kernel/SessionConductor")<
  SessionConductor,
  SessionConductorService
>() {}

const makeSessionConductorService = (
  mailbox: import("./mailbox.js").MailboxService,
  view: import("./session-view.js").SessionViewService,
): SessionConductorService => ({
  activate: (sessionId) => mailbox.activate(sessionId),
  enqueue: (sessionId, command) =>
    Effect.gen(function* () {
      // Single revision gate via the view before the one mailbox enqueue.
      // Mailbox still does its own cached-revision pre-check; this gate ensures the
      // staleness is checked against the Journal-derived revision as well, in one place.
      if (command.expectedRevision !== undefined) {
        const snapshot = yield* view.getView(sessionId);
        yield* view.requireRevision(command.expectedRevision, snapshot.revision);
      }
      return yield* mailbox.enqueue(sessionId, command);
    }),
});

export const SessionConductorLive: Layer.Layer<SessionConductor, never, Mailbox | SessionViewTag> =
  Layer.effect(
    SessionConductor,
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const view = yield* SessionViewTag;
      return makeSessionConductorService(mailbox as import("./mailbox.js").MailboxService, view);
    }),
  );

export const makeSessionConductorForTest = (
  mailbox: import("./mailbox.js").MailboxService,
  view: import("./session-view.js").SessionViewService,
): SessionConductorService => makeSessionConductorService(mailbox, view);
