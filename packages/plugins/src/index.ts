/**
 * Owns manifests, registries, hook emission, capabilities, trust, generations, and plugin loading.
 * It exists to add behavior through plugins without leaking those concerns into the kernel.
 */
export const pluginsPackage = "@peye/plugins";

export {
  type CapabilityGrants,
  createCapabilityGrants,
  grantedCapabilities,
  hasCapability,
  missingCapabilities,
} from "./capability.js";
export {
  type AnyToolDeclaration,
  type CommandContribution,
  type CommandDeclaration,
  type CommandExecutionContext,
  type CommandHandlerData,
  type Contribution,
  type ContributionKey,
  contributionKey,
  defineCommandContribution,
  defineHookContribution,
  defineInstructionFragmentContribution,
  defineToolContribution,
  type HookContribution,
  type HookDeclaration,
  type HookExecute,
  type HookHandler,
  type HookMergeClass,
  type InstructionFragmentContribution,
  type InstructionFragmentDeclaration,
  type ToolContribution,
  ToolContributionError,
  type ToolDeclaration,
  type ToolExecutionContext,
  type ToolExecutionMode,
  type ToolExecutionResult,
  type ToolReplay,
} from "./contribution.js";
export {
  ContributionRegistryError,
  type ContributionRegistryErrorReason,
  type PluginLoadCause,
  PluginLoadError,
} from "./errors.js";
export {
  type CapabilityDeclaration,
  CapabilityDeclarationSchema,
  decodePluginManifest,
  type PluginManifest,
  PluginManifestSchema,
} from "./manifest.js";
export {
  type ContributionConflictDiagnostic,
  type ContributionKindOptions,
  type ContributionRegistry,
  type ContributionRegistryOptions,
  type ContributionUnavailableDiagnostic,
  createContributionRegistry,
  type RegistryDiagnostic,
} from "./registry.js";
