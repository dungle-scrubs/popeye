/**
 * Owns Capability declarations and per-Session grants.
 * It exists to gate Plugin and Contribution availability and to make declared powers reviewable.
 * Capabilities are not an enforcement boundary. Trust is the control, per D-005 and the RFC
 * security posture.
 */
import type { SessionId } from "@pop-eye/journal";
import { Schema } from "effect";

export const CapabilityNameSchema = Schema.String.pipe(
  Schema.filter((name) => name.length > 0 && name === name.trim(), {
    message: () => "capability name must be non-empty and trimmed",
  }),
);

export interface CapabilityGrants {
  readonly capabilities: ReadonlyArray<string>;
  readonly sessionId: SessionId;
}

export const createCapabilityGrants = (
  sessionId: SessionId,
  capabilities: Iterable<string> = [],
): CapabilityGrants =>
  Object.freeze({
    capabilities: Object.freeze(
      [
        ...new Set(
          [...capabilities].map((capability) =>
            Schema.decodeSync(CapabilityNameSchema)(capability),
          ),
        ),
      ].sort(),
    ),
    sessionId,
  });

export const hasCapability = (grants: CapabilityGrants, capability: string): boolean =>
  grants.capabilities.includes(capability);

export const grantedCapabilities = (grants: CapabilityGrants): ReadonlyArray<string> => [
  ...grants.capabilities,
];

export const missingCapabilities = (
  grants: CapabilityGrants,
  requiredCapabilities: Iterable<string>,
): ReadonlyArray<string> =>
  [...new Set(requiredCapabilities)]
    .filter((capability) => !hasCapability(grants, capability))
    .sort();
