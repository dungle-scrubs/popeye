/**
 * Covers the per-Session Tool grant store (RFC-04 §5, issue #54).
 * It exists so the seam #55 (rpc create agent field) and #56 (delegate) call
 * keeps its contract: a Session without filters keeps the process-level grant,
 * narrowing only ever adds filters, and release returns a Session to the
 * process-level grant.
 */
import { SessionIdSchema } from "@dungle-scrubs/popeye-journal";
import { Effect } from "effect";
import { expect, test } from "vitest";

import type { ToolGrantFilter } from "./grants.js";
import { makeSessionToolGrants } from "./session-grants.js";

const sessionA = SessionIdSchema.make("session-a");
const sessionB = SessionIdSchema.make("session-b");

const onlyRead: ToolGrantFilter = { access: undefined, excludeTools: [], tools: ["read"] };
const noBash: ToolGrantFilter = { access: undefined, excludeTools: ["bash"], tools: [] };

test("a Session that was never narrowed has no Session filters", async () => {
  const filters = await Effect.runPromise(
    Effect.gen(function* () {
      const grants = yield* makeSessionToolGrants;
      return yield* grants.filtersFor(sessionA);
    }),
  );

  expect(filters).toEqual([]);
});

test("narrow adds a filter to one Session only", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const grants = yield* makeSessionToolGrants;
      yield* grants.narrow(sessionB, onlyRead);
      return {
        a: yield* grants.filtersFor(sessionA),
        b: yield* grants.filtersFor(sessionB),
      };
    }),
  );

  expect(result).toEqual({ a: [], b: [onlyRead] });
});

test("a second narrow keeps the first filter: narrowing never replaces", async () => {
  const filters = await Effect.runPromise(
    Effect.gen(function* () {
      const grants = yield* makeSessionToolGrants;
      yield* grants.narrow(sessionB, onlyRead);
      yield* grants.narrow(sessionB, noBash);
      return yield* grants.filtersFor(sessionB);
    }),
  );

  expect(filters).toEqual([onlyRead, noBash]);
});

test("release drops every filter of one Session and leaves other Sessions alone", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const grants = yield* makeSessionToolGrants;
      yield* grants.narrow(sessionA, noBash);
      yield* grants.narrow(sessionB, onlyRead);
      yield* grants.release(sessionB);
      return {
        a: yield* grants.filtersFor(sessionA),
        b: yield* grants.filtersFor(sessionB),
      };
    }),
  );

  expect(result).toEqual({ a: [noBash], b: [] });
});

test("release of a Session without filters is a no-op", async () => {
  const filters = await Effect.runPromise(
    Effect.gen(function* () {
      const grants = yield* makeSessionToolGrants;
      yield* grants.release(sessionA);
      return yield* grants.filtersFor(sessionA);
    }),
  );

  expect(filters).toEqual([]);
});

test("each store is independent", async () => {
  const filters = await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* makeSessionToolGrants;
      const second = yield* makeSessionToolGrants;
      yield* first.narrow(sessionA, onlyRead);
      return yield* second.filtersFor(sessionA);
    }),
  );

  expect(filters).toEqual([]);
});
