/**
 * Owns manifests, registries, hook emission, capabilities, trust, generations, and plugin loading.
 * It exists to add behavior through plugins without leaking those concerns into the kernel.
 */
export const pluginsPackage = "@peye/plugins";

export { type PluginLoadCause, PluginLoadError } from "./errors.js";
