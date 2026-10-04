/**
 * Owns the RFC-02 P4 grant-matrix and divergence-output tests.
 * It exists so the tool-grant filter, effort ladder, and declared
 * divergences stay pinned while HCN's P5 arms land.
 */
import { describe, expect, test } from "vitest";

import { HCN_EFFORT_TO_THINKING_LEVEL, HCN_EFFORTS } from "../entry/args.js";
import {
  composeToolGrantFilter,
  filterGrantedTools,
  filterSessionGrantedTools,
  isToolGranted,
  isToolGrantedToSession,
  partitionAgentTools,
  READ_PRESET_TOOL_NAMES,
  type ToolGrantFilter,
  type ToolGrantInputs,
} from "./grants.js";

const noFilter: ToolGrantFilter = { access: undefined, excludeTools: [], tools: [] };

const tool = (name: string) => ({ name });

describe("tool grant filter", () => {
  test("empty filter grants every tool", () => {
    expect(isToolGranted("read-file", noFilter)).toBe(true);
  });

  test("include allowlists by exact name", () => {
    const filter: ToolGrantFilter = { access: undefined, excludeTools: [], tools: ["read-file"] };
    expect(isToolGranted("read-file", filter)).toBe(true);
    expect(isToolGranted("write-file", filter)).toBe(false);
  });

  test("native: prefix resolves to the plugin tool name", () => {
    const filter: ToolGrantFilter = {
      access: undefined,
      excludeTools: [],
      tools: ["native:read-file"],
    };
    expect(isToolGranted("read-file", filter)).toBe(true);
    expect(isToolGranted("other", filter)).toBe(false);
  });

  test("exclude subtracts from include", () => {
    const filter: ToolGrantFilter = {
      access: undefined,
      excludeTools: ["write-file"],
      tools: ["read-file", "write-file"],
    };
    expect(isToolGranted("read-file", filter)).toBe(true);
    expect(isToolGranted("write-file", filter)).toBe(false);
  });

  test("exclude alone denies the named tool", () => {
    const filter: ToolGrantFilter = { access: undefined, excludeTools: ["bash"], tools: [] };
    expect(isToolGranted("bash", filter)).toBe(false);
    expect(isToolGranted("read-file", filter)).toBe(true);
  });

  test("access write is no restriction", () => {
    const filter: ToolGrantFilter = { access: "write", excludeTools: [], tools: [] };
    expect(isToolGranted("anything", filter)).toBe(true);
  });

  test("access read rides the read preset", () => {
    const filter: ToolGrantFilter = { access: "read", excludeTools: [], tools: [] };
    for (const name of READ_PRESET_TOOL_NAMES) {
      expect(isToolGranted(name, filter)).toBe(true);
    }
    expect(isToolGranted("write-file", filter)).toBe(false);
    expect(isToolGranted("bash", filter)).toBe(false);
  });

  test("explicit include beats the read preset", () => {
    const filter: ToolGrantFilter = { access: "read", excludeTools: [], tools: ["write-file"] };
    expect(isToolGranted("write-file", filter)).toBe(true);
    expect(isToolGranted("read", filter)).toBe(false);
  });

  test("toolsOff denies everything", () => {
    const filter: ToolGrantFilter = {
      access: undefined,
      excludeTools: [],
      tools: [],
      toolsOff: true,
    };
    expect(isToolGranted("read", filter)).toBe(false);
  });

  test("filterGrantedTools keeps list order", () => {
    const filter: ToolGrantFilter = { access: undefined, excludeTools: ["b"], tools: [] };
    expect(filterGrantedTools([tool("a"), tool("b"), tool("c")], filter)).toEqual([
      tool("a"),
      tool("c"),
    ]);
  });
});

// Issue #53 / RFC-04 §3: an Agent definition's tools list composes into the
// grant filter by intersection and never widens it.
describe("agent tools list composition", () => {
  const universe = ["read", "grep", "bash", "edit", "manage-goal"].map(tool);
  const grantedNames = (filter: ToolGrantFilter | undefined): ReadonlyArray<string> =>
    filterGrantedTools(universe, filter ?? noFilter).map((granted) => granted.name);
  const inputs = (overrides: Partial<ToolGrantInputs> = {}): ToolGrantInputs => ({
    access: undefined,
    agentTools: undefined,
    excludeTools: [],
    isolation: undefined,
    tools: [],
    ...overrides,
  });

  test("an agent list alone narrows the full set to exactly its names", () => {
    const filter: ToolGrantFilter = { ...noFilter, agentTools: ["read", "bash"] };
    expect(grantedNames(filter)).toEqual(["read", "bash"]);
  });

  test("an agent list intersects with --tools", () => {
    const filter: ToolGrantFilter = {
      ...noFilter,
      agentTools: ["read", "bash"],
      tools: ["bash", "edit"],
    };
    expect(grantedNames(filter)).toEqual(["bash"]);
  });

  test("--exclude-tools subtracts from the agent list", () => {
    const filter: ToolGrantFilter = {
      ...noFilter,
      agentTools: ["read", "bash"],
      excludeTools: ["bash"],
    };
    expect(grantedNames(filter)).toEqual(["read"]);
  });

  test("--access read intersects the agent list with the read preset", () => {
    const filter: ToolGrantFilter = { ...noFilter, access: "read", agentTools: ["read", "bash"] };
    expect(grantedNames(filter)).toEqual(["read"]);
  });

  test("tool-free isolation still grants nothing under an agent list", () => {
    const filter: ToolGrantFilter = { ...noFilter, agentTools: ["read"], toolsOff: true };
    expect(grantedNames(filter)).toEqual([]);
  });

  test("the native: prefix resolves in an agent list", () => {
    const filter: ToolGrantFilter = { ...noFilter, agentTools: ["native:grep"] };
    expect(grantedNames(filter)).toEqual(["grep"]);
  });

  test("an empty agent list is no restriction", () => {
    const filter: ToolGrantFilter = { ...noFilter, agentTools: [] };
    expect(grantedNames(filter)).toEqual(grantedNames(noFilter));
  });

  test("composeToolGrantFilter returns undefined when no input restricts", () => {
    expect(composeToolGrantFilter(inputs())).toBeUndefined();
    expect(composeToolGrantFilter(inputs({ agentTools: [] }))).toBeUndefined();
  });

  test("composeToolGrantFilter without an agent keeps the pre-#53 flag filter shape", () => {
    expect(
      composeToolGrantFilter(inputs({ access: "write", excludeTools: ["bash"], tools: ["read"] })),
    ).toEqual({ access: "write", excludeTools: ["bash"], tools: ["read"] });
    expect(composeToolGrantFilter(inputs({ isolation: "tool-free" }))).toEqual({
      access: undefined,
      excludeTools: [],
      tools: [],
      toolsOff: true,
    });
  });

  test("composeToolGrantFilter carries a non-empty agent list", () => {
    expect(composeToolGrantFilter(inputs({ agentTools: ["read", "bash"] }))).toEqual({
      access: undefined,
      agentTools: ["read", "bash"],
      excludeTools: [],
      tools: [],
    });
  });

  test("no flag combination yields a Tool outside the agent list or the flag result", () => {
    const strip = (name: string): string => name.replace(/^native:/u, "");
    const accessValues = [undefined, "read", "write"];
    const toolLists = [[], ["read", "bash"], ["edit"], ["native:grep"]];
    const excludeLists = [[], ["bash"], ["read"]];
    const isolationValues = [undefined, "tool-free"];
    const agentLists = [["read", "bash"], ["edit", "no-such-tool"], ["native:read"], ["grep"]];
    let checked = 0;
    for (const access of accessValues) {
      for (const tools of toolLists) {
        for (const excludeTools of excludeLists) {
          for (const isolation of isolationValues) {
            // The oracle is the pre-#53 flag filter, built by hand so the
            // composer is never its own reference.
            const legacyFlags: ToolGrantFilter = {
              access,
              excludeTools,
              tools,
              ...(isolation === "tool-free" ? { toolsOff: true } : {}),
            };
            const flagsOnly = grantedNames(legacyFlags);
            for (const agentTools of agentLists) {
              const composed = grantedNames(
                composeToolGrantFilter(
                  inputs({ access, agentTools, excludeTools, isolation, tools }),
                ),
              );
              const agentSet = new Set(agentTools.map(strip));
              expect(composed).toEqual(flagsOnly.filter((name) => agentSet.has(name)));
              checked += 1;
            }
          }
        }
      }
    }
    expect(checked).toBe(3 * 4 * 3 * 2 * 4);
  });

  test("partitionAgentTools splits names as written, in order, without duplicates", () => {
    expect(
      partitionAgentTools(
        ["read", "no-such-tool", "native:grep", "read", "also-missing", "no-such-tool"],
        new Set(["read", "grep", "manage-goal"]),
      ),
    ).toEqual({
      known: ["read", "native:grep"],
      unknown: ["no-such-tool", "also-missing"],
    });
  });

  test("partitionAgentTools deduplicates native: spellings and keeps the first written form", () => {
    expect(partitionAgentTools(["read", "native:read", "nope"], new Set(["read"]))).toEqual({
      known: ["read"],
      unknown: ["nope"],
    });
  });

  test("partitionAgentTools reports every name unknown against an empty granted set", () => {
    expect(partitionAgentTools(["read", "bash"], new Set())).toEqual({
      known: [],
      unknown: ["read", "bash"],
    });
  });
});

// RFC-04 §5 (issue #54): a Session's own filters narrow the process-level
// filter by intersection. No Session filter means exactly the process view.
describe("per-Session grant composition", () => {
  const universe = ["read", "grep", "bash", "edit", "manage-goal"].map(tool);
  const sessionNames = (
    processFilter: ToolGrantFilter | undefined,
    sessionFilters: ReadonlyArray<ToolGrantFilter>,
  ): ReadonlyArray<string> =>
    filterSessionGrantedTools(universe, processFilter, sessionFilters).map(
      (granted) => granted.name,
    );

  test("no process filter and no Session filter grants every Tool", () => {
    expect(sessionNames(undefined, [])).toEqual(["read", "grep", "bash", "edit", "manage-goal"]);
  });

  test("a Session without filters gets exactly the process-level view", () => {
    const processFilters: ReadonlyArray<ToolGrantFilter | undefined> = [
      undefined,
      { ...noFilter, tools: ["read", "bash"] },
      { ...noFilter, excludeTools: ["edit"] },
      { ...noFilter, access: "read" },
      { ...noFilter, agentTools: ["grep", "edit"] },
      { ...noFilter, toolsOff: true },
    ];
    for (const processFilter of processFilters) {
      expect(sessionNames(processFilter, [])).toEqual(
        processFilter === undefined
          ? universe.map((granted) => granted.name)
          : filterGrantedTools(universe, processFilter).map((granted) => granted.name),
      );
    }
  });

  test("a Session filter narrows the process view by intersection", () => {
    expect(
      sessionNames({ ...noFilter, excludeTools: ["edit"] }, [
        { ...noFilter, agentTools: ["read", "edit"] },
      ]),
    ).toEqual(["read"]);
  });

  test("a Session filter never widens the process view", () => {
    expect(
      sessionNames({ ...noFilter, tools: ["read"] }, [{ ...noFilter, tools: ["read", "bash"] }]),
    ).toEqual(["read"]);
    expect(
      sessionNames({ ...noFilter, toolsOff: true }, [{ ...noFilter, tools: ["read"] }]),
    ).toEqual([]);
  });

  test("several Session filters all apply", () => {
    expect(
      sessionNames(undefined, [
        { ...noFilter, agentTools: ["read", "grep", "bash"] },
        { ...noFilter, excludeTools: ["grep"] },
      ]),
    ).toEqual(["read", "bash"]);
  });

  test("isToolGrantedToSession agrees with filterSessionGrantedTools", () => {
    const processFilter: ToolGrantFilter = { ...noFilter, excludeTools: ["bash"] };
    const sessionFilters: ReadonlyArray<ToolGrantFilter> = [
      { ...noFilter, agentTools: ["read", "bash"] },
    ];
    expect(isToolGrantedToSession("read", processFilter, sessionFilters)).toBe(true);
    expect(isToolGrantedToSession("bash", processFilter, sessionFilters)).toBe(false);
    expect(isToolGrantedToSession("grep", processFilter, sessionFilters)).toBe(false);
    expect(isToolGrantedToSession("grep", processFilter, [])).toBe(true);
    expect(isToolGrantedToSession("grep", undefined, [])).toBe(true);
  });
});

describe("effort ladder", () => {
  test("every HCN effort word maps onto a thinking level", () => {
    expect(HCN_EFFORTS).toEqual([
      "off",
      "low",
      "medium-low",
      "medium",
      "medium-high",
      "high",
      "xhigh",
    ]);
    expect(HCN_EFFORT_TO_THINKING_LEVEL).toEqual({
      high: "xhigh",
      low: "minimal",
      medium: "medium",
      "medium-high": "high",
      "medium-low": "low",
      off: "off",
      xhigh: "max",
    });
  });
});
