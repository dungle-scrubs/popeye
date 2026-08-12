/**
 * Thin adapter over CliEntry (01 architecture review).
 * Owns re-export of the heavy Driver/Head composition so the
 * previous import path keeps working for one commit.
 * Not responsible for startup sequencing — CliEntry owns that.
 */

export { CliRunError, run } from "./cli-entry.js";
