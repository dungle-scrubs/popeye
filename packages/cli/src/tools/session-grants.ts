/**
 * Owns the per-Session Tool grant filters (RFC-04 §5).
 * It exists so one process can host Sessions with different Tool views: rpc Agent sessions
 * in #55 and delegated children in #56.
 * Not responsible for applying filters (the registry in plugins/runtime.ts does that) or
 * composing filters (grants.ts does that).
 */

import type { SessionId } from "@dungle-scrubs/popeye-journal";
import { Context, Effect, Ref } from "effect";

import type { ToolGrantFilter } from "./grants.js";

export interface SessionToolGrantsService {
  /** The Session's own filters, oldest first; empty when the Session keeps the process-level grant. */
  readonly filtersFor: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<ToolGrantFilter>>;
  /**
   * Adds one filter to the Session's grant. Filters only narrow: the Session is offered a Tool
   * only when the process filter and every one of its filters grant it. Call it right after the
   * Session is created or forked and before its first prompt; a running Turn keeps the view it
   * pinned at open.
   */
  readonly narrow: (sessionId: SessionId, filter: ToolGrantFilter) => Effect.Effect<void>;
  /** Drops every filter of the Session; it returns to the process-level grant. */
  readonly release: (sessionId: SessionId) => Effect.Effect<void>;
}

export class SessionToolGrants extends Context.Tag("@dungle-scrubs/popeye/SessionToolGrants")<
  SessionToolGrants,
  SessionToolGrantsService
>() {}

export const makeSessionToolGrants: Effect.Effect<SessionToolGrantsService> = Effect.gen(
  function* () {
    const filters = yield* Ref.make<ReadonlyMap<SessionId, ReadonlyArray<ToolGrantFilter>>>(
      new Map(),
    );
    return {
      filtersFor: (sessionId) =>
        Ref.get(filters).pipe(Effect.map((current) => current.get(sessionId) ?? [])),
      narrow: (sessionId, filter) =>
        Ref.update(filters, (current) =>
          new Map(current).set(sessionId, [...(current.get(sessionId) ?? []), filter]),
        ),
      release: (sessionId) =>
        Ref.update(filters, (current) => {
          if (!current.has(sessionId)) {
            return current;
          }
          const next = new Map(current);
          next.delete(sessionId);
          return next;
        }),
    } satisfies SessionToolGrantsService;
  },
);
