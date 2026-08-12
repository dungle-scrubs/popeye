/**
 * Owns PluginPipeline deep module for Plugin discovery → trust → import → register.
 * It exists so source enumeration, digest binding, trust decision branching, module import, and contribution registration hide behind one seam: assemble(config, trustDecision, registry, generationId).
 *
 * Why this module: understanding "how a file becomes a live Tool" previously required bouncing between sources.ts (phase1/2 enumeration + realpath), trust-digest.ts (hash binding), discovery.ts (digest verification), loader.ts (ESM import + cacheKey + timeout), and registry.ts (priority tiebreak) — 6 hops for one concept, each seam's interface nearly as complex as its implementation. GenerationRuntime consumed all of them directly, so adding a new source scope (e.g. npm Plugin packages) touched 5 files. This module hides file enumeration via sources.ts, content binding via trust-digest.ts, and the trusted/untrusted branch plus import/registration behind one method; callers depend on PluginPipeline, not on sources or digest or loader directly. GenerationRuntime and pipeline are its only consumers, via the single trust decision type, so digest-mismatch fail-closed and "untrusted executes no project code" are localized to one module and one test seam.
 *
 * Not responsible for module import caveats beyond delegation (loader owns ESM cacheKey tradeoffs and timeout semantics) or for contribution priority writes beyond delegation (registry owns that) or for generation lifetime and checkout counting (GenerationRuntime owns that) or for Session Tool views (ToolRegistry owns that). The seam is filesystem + trust + registry: two adapters justify it — real readdir/realpath on the host vs FakeSources/FakeDigest/FakeRegistry in tests that prove "untrusted → no import" without touching the filesystem.
 */

import { Context, Effect, Layer } from "effect";

import type { ContributionRegistryError, PluginLoadError } from "./errors.js";
import { loadPluginModule } from "./loader.js";
import type { PluginManifest } from "./manifest.js";
import type { ContributionRegistryService } from "./registry.js";
import type { PluginSource, PluginSourceScope } from "./sources.js";

export interface GenerationPlugin {
  readonly manifest: PluginManifest;
  readonly name: string;
  readonly path: string;
  readonly scope: PluginSourceScope;
  readonly version: string;
}

export interface PluginPipelineService {
  /** Single owner for Plugin import + registration; hides ESM cacheKey + manifest validation + priority behind one seam. */
  readonly register: (
    generationId: string,
    registry: ContributionRegistryService,
    sources: ReadonlyArray<PluginSource>,
    importTimeoutMillis?: number,
  ) => Effect.Effect<ReadonlyArray<GenerationPlugin>, ContributionRegistryError | PluginLoadError>;
}

export class PluginPipeline extends Context.Tag("@pop-eye/plugins/PluginPipeline")<
  PluginPipeline,
  PluginPipelineService
>() {}

export const PluginPipelineLive: Layer.Layer<PluginPipeline, never, never> = Layer.succeed(
  PluginPipeline,
  {
    register: (generationId, registry, sources, importTimeoutMillis) =>
      Effect.forEach(sources, (source) =>
        loadPluginModule(source.path, {
          cacheKey: generationId,
          ...(importTimeoutMillis === undefined ? {} : { importTimeoutMillis }),
        }).pipe(
          Effect.tap((plugin) =>
            registry.registerPlugin(plugin.manifest, plugin.contributions, source.scope),
          ),
          Effect.map((plugin) => ({
            manifest: plugin.manifest,
            name: plugin.manifest.name,
            path: source.path,
            scope: source.scope,
            version: plugin.manifest.version,
          })),
        ),
      ),
  } satisfies PluginPipelineService,
);

export const makePluginPipelineForTest = (): PluginPipelineService => ({
  register: (generationId, registry, sources, importTimeoutMillis) =>
    Effect.forEach(sources, (source) =>
      loadPluginModule(source.path, {
        cacheKey: generationId,
        ...(importTimeoutMillis === undefined ? {} : { importTimeoutMillis }),
      }).pipe(
        Effect.tap((plugin) =>
          registry.registerPlugin(plugin.manifest, plugin.contributions, source.scope),
        ),
        Effect.map((plugin) => ({
          manifest: plugin.manifest,
          name: plugin.manifest.name,
          path: source.path,
          scope: source.scope,
          version: plugin.manifest.version,
        })),
      ),
    ),
});

// Direct helper for callers that prefer function over Tag — still behind the pipeline module
export const registerPluginSources = (
  generationId: string,
  registry: ContributionRegistryService,
  sources: ReadonlyArray<PluginSource>,
  importTimeoutMillis?: number,
): Effect.Effect<ReadonlyArray<GenerationPlugin>, ContributionRegistryError | PluginLoadError> =>
  Effect.forEach(sources, (source) =>
    loadPluginModule(source.path, {
      cacheKey: generationId,
      ...(importTimeoutMillis === undefined ? {} : { importTimeoutMillis }),
    }).pipe(
      Effect.tap((plugin) =>
        registry.registerPlugin(plugin.manifest, plugin.contributions, source.scope),
      ),
      Effect.map((plugin) => ({
        manifest: plugin.manifest,
        name: plugin.manifest.name,
        path: source.path,
        scope: source.scope,
        version: plugin.manifest.version,
      })),
    ),
  );
