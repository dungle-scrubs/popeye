/**
 * Owns the RFC-02 P4 system-prompt composition tests.
 * It exists so replace/append semantics stay pinned while fragments land.
 */
import { describe, expect, test } from "vitest";

import type { ContextItem } from "./provider.js";
import { composeSystemPrompt } from "./turn-orchestrator.js";

const system = (content: string): ContextItem => ({ content, role: "system" });
const user = (content: string): ContextItem => ({ content, role: "user" });

describe("composeSystemPrompt", () => {
  test("no options leave items untouched", () => {
    const items = [system("a"), user("b")];
    expect(composeSystemPrompt(items, {})).toEqual(items);
  });

  test("replace swaps the leading system block for the given text", () => {
    const items = [system("frag-1"), system("frag-2"), user("hello")];
    expect(composeSystemPrompt(items, { systemPrompt: "Custom." })).toEqual([
      system("Custom."),
      user("hello"),
    ]);
  });

  test("append adds one system item after the leading block", () => {
    const items = [system("frag-1"), user("hello")];
    expect(composeSystemPrompt(items, { appendSystemPrompt: "Extra." })).toEqual([
      system("frag-1"),
      system("Extra."),
      user("hello"),
    ]);
  });

  test("replace plus append compose in order", () => {
    const items = [system("frag-1"), user("hello")];
    expect(
      composeSystemPrompt(items, { appendSystemPrompt: "Extra.", systemPrompt: "Custom." }),
    ).toEqual([system("Custom."), system("Extra."), user("hello")]);
  });

  test("append with no leading block prepends", () => {
    const items = [user("hello")];
    expect(composeSystemPrompt(items, { appendSystemPrompt: "Extra." })).toEqual([
      system("Extra."),
      user("hello"),
    ]);
  });
});
