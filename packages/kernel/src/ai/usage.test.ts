import { describe, expect, test } from "vitest";

import { parseOverflowWindow, resolveUsage } from "./seam.js";

describe("resolveUsage", () => {
  test("sums input and cache components into prompt occupancy", () => {
    expect(
      resolveUsage({
        estimateChars: 40,
        requestEmpty: false,
        usage: { cacheRead: 90_000, cacheWrite: 0, input: 10_000 },
        windowTrusted: true,
        contextWindow: 200_000,
      }),
    ).toEqual({ contextWindowTokens: 200_000, inputTokens: 100_000, source: "provider" });
  });

  test("reported zero on a nonempty request reads as absent and falls back to estimate", () => {
    expect(
      resolveUsage({
        estimateChars: 400,
        requestEmpty: false,
        usage: { cacheRead: 0, cacheWrite: 0, input: 0 },
        windowTrusted: true,
        contextWindow: 128_000,
      }),
    ).toEqual({ contextWindowTokens: 128_000, inputTokens: 100, source: "estimate" });
  });

  test("larger of measured and estimate wins per request", () => {
    expect(
      resolveUsage({
        estimateChars: 4_000,
        requestEmpty: false,
        usage: { input: 100 },
        windowTrusted: true,
        contextWindow: 128_000,
      })?.inputTokens,
    ).toBe(1_000);
  });

  test("malformed usage degrades to estimate without throwing", () => {
    expect(
      resolveUsage({
        estimateChars: 80,
        requestEmpty: false,
        usage: { input: -5 },
        windowTrusted: true,
        contextWindow: 128_000,
      }),
    ).toEqual({ contextWindowTokens: 128_000, inputTokens: 20, source: "estimate" });
  });

  test("untrusted window reports zero", () => {
    expect(
      resolveUsage({
        estimateChars: 80,
        requestEmpty: false,
        usage: { input: 50 },
        windowTrusted: false,
        contextWindow: 128_000,
      })?.contextWindowTokens,
    ).toBe(0);
  });

  test("empty request with no estimate yields absence, not an error", () => {
    expect(
      resolveUsage({
        estimateChars: 0,
        requestEmpty: true,
        usage: undefined,
        windowTrusted: true,
        contextWindow: 128_000,
      }),
    ).toBeUndefined();
  });
});

describe("parseOverflowWindow", () => {
  test("learns the limit, not the input count", () => {
    expect(parseOverflowWindow("prompt is too long: 213462 tokens > 200000 maximum")).toBe(200_000);
  });

  test("rejects ambiguous matches", () => {
    expect(parseOverflowWindow("tokens exceeded, try again later")).toBeUndefined();
    expect(parseOverflowWindow("input 50000 tokens, limit 200000 tokens ok")).toBeUndefined();
  });
});
