import { expect, test } from "vitest";

import { PluginLoadError } from "./errors.js";

test("PluginLoadError constructs with its declared fields and round-trips them", () => {
  const error = new PluginLoadError({
    cause: "unsupported_syntax",
    message: "The plugin uses a TypeScript enum.",
    plugin: "code-style",
  });

  expect(error).toMatchObject({
    _tag: "PluginLoadError",
    cause: "unsupported_syntax",
    message: "The plugin uses a TypeScript enum.",
    plugin: "code-style",
  });
});
