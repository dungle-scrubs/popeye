import type { Tool } from "@popeye/kernel";
import { expect, test } from "vitest";

import type { AnyToolDeclaration } from "./contribution.js";

type Assignable<TSource, TTarget> = [TSource] extends [TTarget] ? true : false;
type Assert<TValue extends true> = TValue;
type KernelToPlugin = Assert<Assignable<Tool.Any, AnyToolDeclaration>>;
type PluginToKernel = Assert<Assignable<AnyToolDeclaration, Tool.Any>>;

const compatibility: readonly [KernelToPlugin, PluginToKernel] = [true, true];

test("Plugin and kernel Tool declarations remain structurally assignable in both directions", () => {
  expect(compatibility).toEqual([true, true]);
});
