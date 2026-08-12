/**
 * Backward-compat facade over ToolInvocationPipeline.
 * This module previously owned the pipeline; it now re-exports the deep module
 * at tool-invocation-pipeline.ts so existing imports keep working.
 */

export {
  clearToolGateSessionMemory,
  type GateDecision,
  makeToolGateService,
  makeToolInvocationPipeline,
  onGenerationSwap,
  type ToolGateService,
  ToolGateServiceLive,
  ToolGateServiceTag,
  type ToolInvocationPipeline,
  ToolInvocationPipelineLive,
  ToolInvocationPipelineTag,
  toolGateSessionMemoryRef,
} from "./tool-invocation-pipeline.js";
