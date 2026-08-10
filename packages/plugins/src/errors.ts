/**
 * Owns plugin loading failures so manifests and source constraints remain inspectable at the plugin seam.
 * It exists to report why a contribution cannot become available without treating it as a kernel failure.
 */
import { Data } from "effect";

import type { ContributionKey } from "./contribution.js";

export class GateRejected extends Data.TaggedError("GateRejected")<{
  readonly plugin: string;
  readonly point: string;
  readonly reason: string;
  readonly timedOut: boolean;
}> {}

export type PluginLoadCause = "manifest_invalid" | "build_failed" | "unsupported_syntax";

export class PluginLoadError extends Data.TaggedError("PluginLoadError")<{
  readonly cause: PluginLoadCause;
  readonly message: string;
  readonly plugin: string;
  readonly schemaCause?: unknown;
}> {}

export type ContributionRegistryErrorReason =
  | "invalid_name"
  | "kind_conflict"
  | "payload_invalid"
  | "priority_tie"
  | "unknown_kind";

export class ContributionRegistryError extends Data.TaggedError("ContributionRegistryError")<{
  readonly key: ContributionKey | null;
  readonly kind: string;
  readonly message: string;
  readonly reason: ContributionRegistryErrorReason;
  readonly schemaCause?: unknown;
}> {}
