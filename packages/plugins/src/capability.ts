/**
 * Owns Capability declarations and per-Session grants.
 * It exists to gate Plugin and Contribution availability and to make declared powers reviewable.
 * Capabilities are not an enforcement boundary. Trust is the control, per D-005 and the RFC
 * security posture.
 */
import type { SessionId } from "@peye/journal";

export interface CapabilityGrants {
  readonly capabilities: ReadonlyArray<string>;
  readonly sessionId: SessionId;
}

export const createCapabilityGrants = (
  sessionId: SessionId,
  capabilities: Iterable<string> = [],
): CapabilityGrants =>
  Object.freeze({
    capabilities: Object.freeze([...new Set(capabilities)].sort()),
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
  [...requiredCapabilities].filter((capability) => !hasCapability(grants, capability));
