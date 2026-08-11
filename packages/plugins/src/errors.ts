/**
 * Owns plugin loading failures so manifests and source constraints remain inspectable at the plugin seam.
 * It exists to report why a contribution cannot become available without treating it as a kernel failure.
 */
import { Data } from "effect";

import type { ContributionKey } from "./contribution.js";
import type { HookPointName } from "./hook-points.js";

export class GateRejected extends Data.TaggedError("GateRejected")<{
  readonly cause: string;
  readonly plugin: string;
  readonly point: HookPointName;
  readonly reason: string;
  readonly timedOut: boolean;
}> {}

export class HookInputInvalid extends Data.TaggedError("HookInputInvalid")<{
  readonly cause: string;
  readonly point: HookPointName;
  readonly reason: string;
  readonly schemaCause: unknown;
}> {}

export type PluginLoadCause = "manifest_invalid" | "build_failed" | "unsupported_syntax";

export class PluginLoadError extends Data.TaggedError("PluginLoadError")<{
  readonly cause: PluginLoadCause;
  readonly message: string;
  readonly plugin: string;
  readonly schemaCause?: unknown;
}> {}

export type ContributionRegistryErrorReason =
  | "hook_merge_class_mismatch"
  | "hook_point_conflict"
  | "hook_point_unknown"
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
