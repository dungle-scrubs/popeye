import { expect, test } from "vitest";

import * as plugins from "./index.js";

test("exports the plugins package marker", () => {
  expect(plugins.pluginsPackage).toBe("@pop-eye/plugins");
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

test("exports the M16 Hook emitter and point table from the public Plugin seam", () => {
  expect(Object.keys(plugins)).toEqual(
    expect.arrayContaining([
      "ContextHookInputSchema",
      "DEFAULT_GATE_TIMEOUT_MILLIS",
      "DEFAULT_TAP_QUEUE_CAPACITY",
      "GateRejected",
      "HOOK_POINTS",
      "HOOK_POINT_NAMES",
      "HookEmitter",
      "HookEmitterLive",
      "ToolCallGateHookOutputSchema",
      "defineHookPoint",
    ]),
  );
});

test("exports the M17 Trust and discovery interfaces from the public Plugin seam", () => {
  expect(Object.keys(plugins)).toEqual(
    expect.arrayContaining([
      "PluginDiscoveryError",
      "TrustChangeSummarySchema",
      "TrustStore",
      "TrustStoreError",
      "TrustStoreLive",
      "TrustStoreMemory",
      "checkTrust",
      "classifyResolvedPluginSource",
      "phase1Sources",
      "phase2Sources",
      "recordDecision",
      "revokeTrust",
    ]),
  );
});

test("exports the M18 loader and generation interfaces from the public Plugin seam", () => {
  expect(Object.keys(plugins)).toEqual(
    expect.arrayContaining([
      "DEFAULT_TRUST_RESOLVER_TIMEOUT_MILLIS",
      "TrustResolverTimeoutError",
      "loadGeneration",
      "loadPluginModule",
      "makeGenerationRuntime",
    ]),
  );
});
