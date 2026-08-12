/**
 * Thin adapter over CliEntry (01 architecture review).
 * Owns re-export of the deep entry interface so existing callers
 * (bin/peye.ts, tests, index.ts) keep working for one commit.
 * Not responsible for startup sequencing — CliEntry owns that.
 */

export { CliEntryError, type CliIo, executeCli } from "./cli-entry.js";
