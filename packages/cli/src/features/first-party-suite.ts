/**
 * Owns the first-party Plugin catalog as a deep module.
 * It exists so the shipped Plugin set, its file-URL path mapping, and its
 * name-collision invariants live behind one seam instead of smeared over
 * pipeline.ts (firstPartyPath switch), compose.ts (FirstPartyDriverDefault),
 * and five feature files each holding one factory.
 *
 * Why this module: answering "what ships as first-party?" required bouncing
 * between features/compact.ts, reload.ts, session-name.ts, trust-gate.ts,
 * tool-vetting.ts, plus pipeline's string-switch on file URLs and compose's
 * wiring. Each feature's interface was one factory (≈40 lines), the real
 * behavior — the catalog, its capability union, and the
 * phase2_displacement vs name_collision guard — lived in the caller. This
 * module hides the catalog (default 3 plugins), the capability union, the
 * path mapping for reload cache keys, and the collision predicate behind
 * one seam: firstPartySuite. Pipeline keeps only discovery-config (decoy)
 * — its acknowledged shallow seam. Callers depend on the suite, not on the
 * five files individually.
 *
 * The trust-gate and tool-vetting plugins are opt-in gates (they require
 * PluginInteractions). They are part of the catalog as optional entries,
 * not defaults — see optInPlugins.
 *
 * Not responsible for source enumeration or digest binding (PluginDiscovery
 * owns those via sources/trust-digest), for module import or manifest
 * validation (loader owns that), for registry priority (registry owns that),
 * or for generation lifetime/checkout (GenerationRuntime owns that). The
 * seam is the catalog: two adapters justify it — the real suite and
 * suite.withPlugins(overrides) for tests that prove catalog invariants
 * without touching the filesystem.
 */

import { fileURLToPath } from "node:url";

import type { Contribution, GenerationPlugin, PluginManifest } from "@dungle-scrubs/popeye-plugins";

import { compactPlugin } from "./compact.js";
import { reloadPlugin } from "./reload.js";
import { sessionNamePlugin } from "./session-name.js";
import { toolVettingPlugin } from "./tool-vetting.js";
import { trustGatePlugin } from "./trust-gate.js";

export interface FirstPartyPlugin {
  readonly contributions: ReadonlyArray<Contribution>;
  readonly manifest: PluginManifest;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const defaultFirstPartyPlugins: ReadonlyArray<FirstPartyPlugin> = [
  compactPlugin,
  reloadPlugin,
  sessionNamePlugin,
] as const;

export const optInFirstPartyPlugins = {
  toolVetting: toolVettingPlugin,
  trustGate: trustGatePlugin,
} as const;

export const allFirstPartyPlugins: ReadonlyArray<FirstPartyPlugin> = [
  ...defaultFirstPartyPlugins,
  trustGatePlugin,
  toolVettingPlugin,
] as const;

// ---------------------------------------------------------------------------
// Path mapping for reload cache keys (Node ESM registry)
// ---------------------------------------------------------------------------

export const firstPartyPath = (plugin: FirstPartyPlugin): string =>
  plugin === compactPlugin
    ? fileURLToPath(new URL("./compact.js", import.meta.url))
    : plugin === sessionNamePlugin
      ? fileURLToPath(new URL("./session-name.js", import.meta.url))
      : plugin === reloadPlugin
        ? fileURLToPath(new URL("./reload.js", import.meta.url))
        : plugin === trustGatePlugin
          ? fileURLToPath(new URL("./trust-gate.js", import.meta.url))
          : plugin === toolVettingPlugin
            ? fileURLToPath(new URL("./tool-vetting.js", import.meta.url))
            : `first-party:${plugin.manifest.name}`;

export const firstPartyGenerationPlugins = (
  plugins: ReadonlyArray<FirstPartyPlugin>,
): ReadonlyArray<GenerationPlugin> =>
  plugins.map((plugin) => ({
    manifest: plugin.manifest,
    name: plugin.manifest.name,
    origin: "first-party" as const,
    path: firstPartyPath(plugin),
    scope: "external" as const,
    version: plugin.manifest.version,
  }));

// ---------------------------------------------------------------------------
// Collision predicate (phase2_displacement vs name_collision)
// ---------------------------------------------------------------------------

export const pluginNameCollision = (
  plugins: ReadonlyArray<GenerationPlugin>,
): readonly [GenerationPlugin, GenerationPlugin] | undefined => {
  const pluginByName = new Map<string, GenerationPlugin>();
  for (const plugin of plugins) {
    const existing = pluginByName.get(plugin.name);
    if (existing !== undefined && existing.path !== plugin.path) {
      return [existing, plugin];
    }
    pluginByName.set(plugin.name, plugin);
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Capability union
// ---------------------------------------------------------------------------

export const firstPartyCapabilityUnion = (
  plugins: ReadonlyArray<FirstPartyPlugin> = defaultFirstPartyPlugins,
): ReadonlyArray<string> =>
  [...new Set(plugins.flatMap((p) => p.manifest.capabilities.map((c) => c.name)))].sort();

// ---------------------------------------------------------------------------
// Suite object — deep interface over the catalog
// ---------------------------------------------------------------------------

export interface FirstPartySuite {
  readonly allPlugins: ReadonlyArray<FirstPartyPlugin>;
  readonly capabilities: () => ReadonlyArray<string>;
  readonly checkCollision: (
    externalPlugins: ReadonlyArray<GenerationPlugin>,
  ) => readonly [GenerationPlugin, GenerationPlugin] | undefined;
  readonly defaultPlugins: ReadonlyArray<FirstPartyPlugin>;
  readonly generationPlugins: (
    plugins?: ReadonlyArray<FirstPartyPlugin>,
  ) => ReadonlyArray<GenerationPlugin>;
  readonly optInPlugins: typeof optInFirstPartyPlugins;
  readonly pathFor: (plugin: FirstPartyPlugin) => string;
}

export const firstPartySuite: FirstPartySuite = {
  allPlugins: allFirstPartyPlugins,
  capabilities: () => firstPartyCapabilityUnion(defaultFirstPartyPlugins),
  checkCollision: (externalPlugins) =>
    pluginNameCollision([
      ...firstPartyGenerationPlugins(defaultFirstPartyPlugins),
      ...externalPlugins,
    ]),
  defaultPlugins: defaultFirstPartyPlugins,
  generationPlugins: (plugins = defaultFirstPartyPlugins) => firstPartyGenerationPlugins(plugins),
  optInPlugins: optInFirstPartyPlugins,
  pathFor: firstPartyPath,
};

// Test seam: suite with overrides without touching filesystem
export const makeFirstPartySuiteWithPlugins = (
  plugins: ReadonlyArray<FirstPartyPlugin>,
): FirstPartySuite => ({
  allPlugins: plugins,
  capabilities: () => firstPartyCapabilityUnion(plugins),
  checkCollision: (externalPlugins) =>
    pluginNameCollision([...firstPartyGenerationPlugins(plugins), ...externalPlugins]),
  defaultPlugins: plugins,
  generationPlugins: (p = plugins) => firstPartyGenerationPlugins(p),
  optInPlugins: optInFirstPartyPlugins,
  pathFor: firstPartyPath,
});
