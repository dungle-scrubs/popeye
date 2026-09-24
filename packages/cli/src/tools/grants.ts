/**
 * Owns HCN tool-grant filtering by name.
 * It exists so --tools/--exclude-tools/--access narrow the tools the model
 * sees without rewriting capability declarations: the trust and vetting
 * gates keep reading declarations unchanged, and the filter applies after
 * plugin trust, to already-trusted contributions only.
 * Not responsible for grant parsing (args owns that) or tool adaptation
 * (adapter owns that); this module only owns the name predicate.
 */

export const NATIVE_TOOL_PREFIX = "native:";

/**
 * Canonical read-preset names (HCN tool vocabulary). --access read rides
 * the tool list as an include of these names; --access write (the HCN
 * default) is no restriction.
 */
export const READ_PRESET_TOOL_NAMES: ReadonlyArray<string> = [
  "read",
  "grep",
  "glob",
  "list",
  "web-fetch",
  "web-search",
];

export interface ToolGrantFilter {
  readonly access: string | undefined;
  readonly excludeTools: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<string>;
}

const stripNative = (name: string): string =>
  name.startsWith(NATIVE_TOOL_PREFIX) ? name.slice(NATIVE_TOOL_PREFIX.length) : name;

export const isToolGranted = (toolName: string, filter: ToolGrantFilter): boolean => {
  const excluded = new Set(filter.excludeTools.map(stripNative));
  if (excluded.has(toolName)) {
    return false;
  }
  const included = filter.tools.map(stripNative);
  if (filter.access === "read" && included.length === 0) {
    return (READ_PRESET_TOOL_NAMES as ReadonlyArray<string>).includes(toolName);
  }
  if (included.length === 0) {
    return true;
  }
  return new Set(included).has(toolName);
};

export const filterGrantedTools = <TTool extends { readonly name: string }>(
  tools: ReadonlyArray<TTool>,
  filter: ToolGrantFilter,
): ReadonlyArray<TTool> => tools.filter((tool) => isToolGranted(tool.name, filter));
