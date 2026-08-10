import { Effect } from "effect";
import { expect, test } from "vitest";

import { PluginLoadError } from "./errors.js";

test("PluginLoadError is recoverable by tag and preserves its cause", async () => {
  const result = await Effect.runPromise(
    Effect.fail(
      new PluginLoadError({
        cause: "unsupported_syntax",
        message: "The plugin uses a TypeScript enum.",
        plugin: "code-style",
      }),
    ).pipe(Effect.catchTag("PluginLoadError", (error) => Effect.succeed(error.cause))),
  );

  expect(result).toBe("unsupported_syntax");
});
