import { expect, test } from "vitest";

import * as plugins from "./index.js";

test("exports the plugins package marker", () => {
  expect(plugins.pluginsPackage).toBe("@peye/plugins");
});

test("exports the M15 interface from the public Plugin seam", () => {
  expect(Object.keys(plugins)).toEqual(
    expect.arrayContaining([
      "CapabilityDeclarationSchema",
      "CapabilityNameSchema",
      "CommandContributionKind",
      "ContributionRegistry",
      "ContributionRegistryError",
      "ContributionRegistryLive",
      "PluginLoadError",
      "PluginManifestSchema",
      "contributionKey",
      "createCapabilityGrants",
      "defineContributionKind",
      "decodePluginManifest",
      "defineCommandContribution",
      "defineHookContribution",
      "defineInstructionFragmentContribution",
      "defineToolContribution",
      "grantedCapabilities",
    ]),
  );
});
