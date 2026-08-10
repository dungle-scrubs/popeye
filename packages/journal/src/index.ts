/**
 * Owns entries, records, tree and fold inputs, JSONL and in-memory layers, and conformance.
 * It exists to keep journal schema versions and migrations behind one durable boundary.
 */
export const journalPackage = "@peye/journal";

export { type JournalCorruptionClass, JournalError } from "./errors.js";
export {
  createLineCodec,
  type LineCodec,
  type LineCodecConfig,
  type LineVersion,
} from "./line-codec.js";
