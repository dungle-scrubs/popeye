/**
 * Owns wire heads for print, json, and rpc, plus configuration and the entry point.
 * It exists to expose protocol-driven interfaces while keeping in-process kernel hosting in one module.
 */
export const cliPackage = "@peye/cli";

export { type JsonHeadOptions, runJsonHead } from "./heads/json.js";
export { type PrintHeadOptions, runPrintHead } from "./heads/print.js";
export {
  type RpcHeadOptions,
  type RpcInteractionResolution,
  RpcInteractions,
  RpcInteractionsLive,
  type RpcInteractionsService,
  RpcReadError,
  runRpcHead,
  strictLfFrames,
} from "./heads/rpc.js";
export {
  HEAD_EXIT_CODES,
  type HeadExitCode,
  HeadWriteError,
  type HeadWriter,
  makeWritableHeadWriter,
  stdoutHeadWriter,
} from "./heads/shared.js";
