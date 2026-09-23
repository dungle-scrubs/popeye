/**
 * Owns wire heads for print, json, and rpc, plus configuration and the entry point.
 * It exists to expose protocol-driven interfaces while keeping in-process kernel hosting in one module.
 */
export const cliPackage = "@popeye/cli";

export {
  CliArgsError,
  type CliMode,
  type ParsedArgs,
  type ParsedRunArgs,
  parseArgs,
  withStdinPrompt,
} from "./entry/args.js";
export {
  type CliConfig,
  CliConfigError,
  type CliConfigErrorReason,
  type CliEnvironment,
  type CliRunConfig,
  resolveConfig,
} from "./entry/config.js";
export {
  CliEntryError,
  type CliIo,
  executeCli,
} from "./entry/execute.js";
export {
  CliRunError,
  run,
} from "./entry/run.js";
export {
  encodeProgressLine,
  encodeSnapshotLine,
  HEAD_EXIT_CODES,
  type HeadExitCode,
  HeadWriteError,
  type HeadWriter,
  makeWritableHeadWriter,
  stdoutHeadWriter,
} from "./heads/head-wire.js";
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
export { adaptTools, generationCapabilityUnion } from "./tools/adapter.js";
