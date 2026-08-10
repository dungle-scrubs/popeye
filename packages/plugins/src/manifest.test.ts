import { Effect } from "effect";
import { expect, test } from "vitest";

import { decodePluginManifest } from "./manifest.js";

test("Manifest Schema validates name, version, capabilities; invalid manifest is PluginLoadError naming the cause", async () => {
  const valid = await Effect.runPromise(
    decodePluginManifest({
      capabilities: [{ name: "shell", required: true }, { name: "network" }],
      description: "Provides repository tools.",
      name: "repo-tools",
      version: "1.2.3-beta.1+build.7",
    }),
  );

  expect(valid).toEqual({
    capabilities: [{ name: "shell", required: true }, { name: "network" }],
    description: "Provides repository tools.",
    name: "repo-tools",
    version: "1.2.3-beta.1+build.7",
  });

  const invalidInputs = [
    [{ capabilities: [], name: "RepoTools", version: "1.0.0" }, "name"],
    [{ capabilities: [], name: "repo-tools", version: "latest" }, "version"],
    [{ capabilities: [{ required: true }], name: "repo-tools", version: "1.0.0" }, "capabilities"],
    [{ capabilities: [], extra: true, name: "repo-tools", version: "1.0.0" }, "extra"],
  ] as const;

  for (const [input, fault] of invalidInputs) {
    const error = await Effect.runPromise(Effect.flip(decodePluginManifest(input)));

    expect(error._tag).toBe("PluginLoadError");
    expect(error.cause).toBe("manifest_invalid");
    expect(error.message).toContain(fault);
  }
});
