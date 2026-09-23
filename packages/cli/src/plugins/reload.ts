/**
 * Owns the host control service behind /reload - swap orchestration, busy/drain handling, result reporting.
 * It exists so the reload Command can be tested without a process and so the runtime's swap logic is isolated from Tool adaptation.
 * Not responsible for Tool adaptation (adapter owns that) or for generation construction (pipeline owns that).
 */

import type { GenerationSwapDiagnostic } from "@popeye/plugins";
import { Context, Data, type Effect } from "effect";

export const DRAIN_TIMEOUT_MILLIS = 5_000;

export class ReloadBusyError extends Data.TaggedError("ReloadBusyError")<{
  readonly message: string;
}> {}

export class ReloadDrainTimeoutError extends Data.TaggedError("ReloadDrainTimeoutError")<{
  readonly drainTimeoutMillis: number;
  readonly holders: ReadonlyArray<string>;
  readonly leaseCount: number;
  readonly message: string;
  readonly newGenerationId: string;
  readonly oldGenerationId: string;
}> {}

export interface ReloadControlService {
  readonly reload: Effect.Effect<
    GenerationSwapDiagnostic,
    ReloadBusyError | ReloadDrainTimeoutError | unknown
  >;
}

export class ReloadControl extends Context.Tag("@popeye/cli/ReloadControl")<
  ReloadControl,
  ReloadControlService
>() {}

export const reloadResultSchemaDescription =
  "GenerationSwapDiagnostic: { oldGenerationId, newGenerationId, pluginsAdded, pluginsRemoved, pluginsReplaced, drainDurationMillis, leaseCount, closedResources, type } bounded and serializable for heads.";

/**
 * Bounded reload result schema for heads. All fields are JSON-serializable and bounded.
 * Used by the /reload command and RPC heads to report swap results.
 */
export const ReloadResultFields = {
  closedResources: "number (closed scope resources)",
  drainDurationMillis: "number (ms)",
  leaseCount: "number (in-flight leases at swap)",
  newGenerationId: "string (uuid)",
  oldGenerationId: "string (uuid)",
  pluginsAdded: "string[] (sorted)",
  pluginsRemoved: "string[] (sorted)",
  pluginsReplaced: "string[] (sorted)",
  type: '"generation_swap"',
} as const;
