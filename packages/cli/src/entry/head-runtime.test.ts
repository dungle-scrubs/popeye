/**
 * Covers the production composition root's Head services (RFC-04 §5, issue
 * #54): every Head cli-entry runs is provided the process's SessionToolGrants
 * store, so the rpc bridge's close releases filters in a real process. The rpc
 * grant tests assemble their own layer; this test checks cli-entry's.
 */
import { Effect, Layer } from "effect";
import { expect, test } from "vitest";

import { Driver, type DriverService, makeSessionLifecycle, SessionLifecycle } from "../compose.js";
import { RpcInteractions } from "../heads/rpc.js";
import { makeSessionToolGrants, SessionToolGrants } from "../tools/session-grants.js";
import type { CliMode } from "./args.js";
import { composeHeadRuntime } from "./cli-entry.js";

const modes: ReadonlyArray<CliMode> = ["hcn", "json", "print", "rpc"];

test.each(modes)(
  "the %s Head runtime provides the process's SessionToolGrants store",
  async (mode) => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeSessionToolGrants;
        const lifecycle = makeSessionLifecycle();
        const layer = composeHeadRuntime({
          driver: Layer.succeed(Driver, {} as unknown as DriverService),
          lifecycle,
          mode,
          sessionToolGrants: store,
        });
        return yield* Effect.gen(function* () {
          return {
            grants: yield* SessionToolGrants,
            interactions: yield* RpcInteractions,
            lifecycle: yield* SessionLifecycle,
          };
        }).pipe(
          Effect.provide(layer),
          Effect.map((resolved) => ({ expectedLifecycle: lifecycle, resolved, store })),
        );
      }),
    );

    expect(result.resolved.grants).toBe(result.store);
    expect(result.resolved.lifecycle).toBe(result.expectedLifecycle);
    expect(result.resolved.interactions).toBeDefined();
  },
);
