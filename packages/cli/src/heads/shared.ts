/**
 * Thin adapter over HeadWire (C1 architecture review).
 * Owns re-export of the deep wire interface so existing importers
 * (heads, cli-entry, tests, index) keep working for one commit.
 * New code should import from ./head-wire.js directly.
 * Not responsible for wire encoding — HeadWire owns that.
 */

export {
  encodeProgressLine,
  encodeSnapshotLine,
  errorMessage,
  errorTag,
  exitCodeForStopReason,
  finalAssistantText,
  HEAD_EXIT_CODES,
  type HeadErrorEnvelope,
  type HeadExitCode,
  HeadWriteError,
  type HeadWriter,
  headErrorEnvelope,
  makeHeadWireForTest,
  makeWritableHeadWriter,
  makeWritableLogfmtLogger,
  protocolSnapshot,
  reassembleFullSnapshot,
  runHeadBoundary,
  type SnapshotAuditFields,
  stderrHeadWriter,
  stdoutHeadWriter,
} from "./head-wire.js";
