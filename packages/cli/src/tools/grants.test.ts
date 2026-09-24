/**
 * Owns the RFC-02 P4 grant-matrix and divergence-output tests.
 * It exists so the tool-grant filter, effort ladder, and declared
 * divergences stay pinned while HCN's P5 arms land.
 */
import { describe, expect, test } from "vitest";

import { HCN_EFFORT_TO_THINKING_LEVEL, HCN_EFFORTS } from "../entry/args.js";
import {
  filterGrantedTools,
  isToolGranted,
  READ_PRESET_TOOL_NAMES,
  type ToolGrantFilter,
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

describe("effort ladder", () => {
  test("every HCN effort word maps onto a thinking level", () => {
    expect(HCN_EFFORTS).toEqual(["low", "medium-low", "medium", "medium-high", "high", "xhigh"]);
    expect(HCN_EFFORT_TO_THINKING_LEVEL).toEqual({
      high: "xhigh",
      low: "minimal",
      medium: "medium",
      "medium-high": "high",
      "medium-low": "low",
      xhigh: "max",
    });
  });
});
