/**
 * Owns HCN tool-grant filtering by name, the Agent tools-list intersection
 * (RFC-04 §3), and the known/unknown partition of an Agent list.
 * It exists so --tools/--exclude-tools/--access narrow the tools the model
 * sees without rewriting capability declarations: the trust and vetting
 * gates keep reading declarations unchanged, and the filter applies after
 * plugin trust, to already-trusted contributions only.
 * Not responsible for grant parsing (args owns that) or tool adaptation
 * (adapter owns that).
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
  /**
   * Agent definition tools list (RFC-04 §3). Intersects with the flag result
   * and never widens it. Absent or empty means no restriction.
   */
  readonly agentTools?: ReadonlyArray<string>;
  readonly excludeTools: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<string>;
  /** Tool-free isolation: no tool is granted. */
  readonly toolsOff?: boolean;
}

const stripNative = (name: string): string =>
  name.startsWith(NATIVE_TOOL_PREFIX) ? name.slice(NATIVE_TOOL_PREFIX.length) : name;

export const isToolGranted = (toolName: string, filter: ToolGrantFilter): boolean => {
  if (filter.toolsOff === true) {
    return false;
  }
  if (
    filter.agentTools !== undefined &&
    filter.agentTools.length > 0 &&
    !filter.agentTools.map(stripNative).includes(toolName)
  ) {
    return false;
  }
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

export interface ToolGrantInputs {
  readonly access: string | undefined;
  readonly agentTools: ReadonlyArray<string> | undefined;
  readonly excludeTools: ReadonlyArray<string>;
  readonly isolation: string | undefined;
  readonly tools: ReadonlyArray<string>;
}

/**
 * Builds the process Tool grant filter from the HCN flags and the Agent
 * tools list. Returns undefined when nothing restricts, so a session
 * without --agent gets exactly the filter it got before #53.
 */
export const composeToolGrantFilter = (inputs: ToolGrantInputs): ToolGrantFilter | undefined => {
  const agentTools =
    inputs.agentTools !== undefined && inputs.agentTools.length > 0 ? inputs.agentTools : undefined;
  if (
    inputs.access === undefined &&
    inputs.tools.length === 0 &&
    inputs.excludeTools.length === 0 &&
    inputs.isolation === undefined &&
    agentTools === undefined
  ) {
    return undefined;
  }
  return {
    access: inputs.access,
    excludeTools: inputs.excludeTools,
    tools: inputs.tools,
    ...(inputs.isolation === "tool-free" ? { toolsOff: true } : {}),
    ...(agentTools === undefined ? {} : { agentTools }),
  };
};

export interface AgentToolPartition {
  readonly known: ReadonlyArray<string>;
  readonly unknown: ReadonlyArray<string>;
}

/**
 * Splits an Agent tools list against the granted Tool names (RFC-04 §1, §3).
 * Membership and deduplication compare the native:-stripped name;
 * each Tool keeps its first written form and file order.
 */
export const partitionAgentTools = (
  agentTools: ReadonlyArray<string>,
  grantedToolNames: ReadonlySet<string>,
): AgentToolPartition => {
  const known: Array<string> = [];
  const unknown: Array<string> = [];
  const seen = new Set<string>();
  for (const name of agentTools) {
    const toolName = stripNative(name);
    if (seen.has(toolName)) {
      continue;
    }
    seen.add(toolName);
    (grantedToolNames.has(toolName) ? known : unknown).push(name);
  }
  return { known, unknown };
};

export const filterGrantedTools = <TTool extends { readonly name: string }>(
  tools: ReadonlyArray<TTool>,
  filter: ToolGrantFilter,
): ReadonlyArray<TTool> => tools.filter((tool) => isToolGranted(tool.name, filter));
