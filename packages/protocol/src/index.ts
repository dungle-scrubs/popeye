/**
 * Owns frame schemas, snapshot and progress types, command unions, and interaction requests.
 * It exists as a kernel-independent contract shared by every head.
 */
export const protocolPackage = "@peye/protocol";

export { InteractionTimeout, ProtocolError, StaleRevision } from "./errors.js";
