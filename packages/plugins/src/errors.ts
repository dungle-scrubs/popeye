/**
 * Owns plugin loading failures so manifests and source constraints remain inspectable at the plugin seam.
 * It exists to report why a contribution cannot become available without treating it as a kernel failure.
 */
import { Data } from "effect";

import type { ContributionKey } from "./contribution.js";

export type PluginLoadCause =
  | "manifest_invalid"
  | "capability_ungranted"
  | "build_failed"
  | "unsupported_syntax";

export class PluginLoadError extends Data.TaggedError("PluginLoadError")<{
  readonly cause: PluginLoadCause;
  readonly message: string;
  readonly plugin: string;
}> {}

export type ContributionRegistryErrorReason = "priority_tie" | "unknown_kind";

export class ContributionRegistryError extends Data.TaggedError("ContributionRegistryError")<{
  readonly key: ContributionKey;
  readonly kind: string;
  readonly message: string;
  readonly reason: ContributionRegistryErrorReason;
}> {}
