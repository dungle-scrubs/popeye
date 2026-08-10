import { Effect } from "effect";
import { expect, test } from "vitest";

import { decodePluginManifest } from "./manifest.js";

test("Manifest Schema validates name, version, and Capability declarations", async () => {
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
});

test.each([
  [{ capabilities: [], name: "RepoTools", version: "1.0.0" }, "name must use kebab-case"],
  [
    { capabilities: [], name: "a".repeat(65), version: "1.0.0" },
    "name must be at most 64 characters",
  ],
  [
    { capabilities: [], name: "repo-tools", version: "latest" },
    "version must be a semantic version",
  ],
  [
    { capabilities: [{ name: " " }], name: "repo-tools", version: "1.0.0" },
    "capability name must be non-empty and trimmed",
  ],
  [
    {
      capabilities: [{ name: "shell" }, { name: "shell", required: true }],
      name: "repo-tools",
      version: "1.0.0",
    },
    "capabilities must not contain duplicate names",
  ],
  [
    { capabilities: [], extra: true, name: "repo-tools", version: "1.0.0" },
    "manifest must not contain unknown fields",
  ],
] as const)("Invalid manifests lead with the friendly Schema message", async (input, message) => {
  const error = await Effect.runPromise(Effect.flip(decodePluginManifest(input)));

  expect(error).toMatchObject({
    _tag: "PluginLoadError",
    cause: "manifest_invalid",
  });
  expect(error.message).toBe(`Invalid Plugin manifest: ${message}.`);
  expect(error.schemaCause).toBeDefined();
});
