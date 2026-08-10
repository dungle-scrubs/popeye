/**
 * Owns manifests, registries, hook emission, capabilities, trust, generations, and plugin loading.
 * It exists to add behavior through plugins without leaking those concerns into the kernel.
 */
export const pluginsPackage = "@peye/plugins";

export {
  type CapabilityGrants,
  CapabilityNameSchema,
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
  type Contribution,
  type ContributionKey,
  contributionKey,
  defineCommandContribution,
  defineContribution,
  defineHookContribution,
  defineInstructionFragmentContribution,
  defineToolContribution,
  type HookContribution,
  type HookDeclaration,
  type HookExecute,
  type HookMergeClass,
  type InstructionFragmentContribution,
  type InstructionFragmentDeclaration,
  type RegisteredContribution,
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
  ContributionNameSchema,
  decodePluginManifest,
  MAX_NAME_SEGMENT_LENGTH,
  type PluginManifest,
  PluginManifestSchema,
  PluginNameSchema,
} from "./manifest.js";
export {
  CommandContributionKind,
  type ContributionConflictDiagnostic,
  type ContributionKind,
  ContributionRegistry,
  ContributionRegistryLive,
  type ContributionRegistryOptions,
  type ContributionRegistryService,
  type ContributionUnavailableDiagnostic,
  defineContributionKind,
  HookContributionKind,
  InstructionFragmentContributionKind,
  type KindRegistrationConflictDiagnostic,
  type RegistryDiagnostic,
  ToolContributionKind,
} from "./registry.js";
