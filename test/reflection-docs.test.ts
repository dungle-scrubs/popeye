import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

// AC4 (RFC-03 slice 16): the Plugin guide states which lifecycle Hook points have live callers and
// which signals are diagnostic versus durable, and the Kernel lifecycle seams never report from a
// diagnostic Tap point.

const read = (path: string): string => readFileSync(resolve(path), "utf8");

const section = (text: string, heading: string): string => {
  const start = text.indexOf(heading);
  expect(start, `missing heading ${heading}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n#{2,3} /);
  return next < 0 ? rest : rest.slice(0, next);
};

const tableRow = (text: string, point: string): string => {
  const row = text.split("\n").find((line) => line.startsWith(`| \`${point}\` |`));
  expect(row, `no live-callers row for ${point}`).toBeDefined();
  return row ?? "";
};

describe("docs/plugin-authoring.md", () => {
  const guide = read("docs/plugin-authoring.md");

  test("the live-callers table names session-lifecycle's three Kernel call sites", () => {
    const callers = section(guide, "### Live callers");
    const row = tableRow(callers, "session-lifecycle");
    expect(row).toMatch(/^\| `session-lifecycle` \| Kernel callers: /);
    expect(row).not.toContain("none");
    expect(row).toContain("end of `create`");
    expect(row).toContain("end of `resume`");
    expect(row).toContain("end of `closeSession`");
    expect(row).toContain("../packages/kernel/src/sessions.ts");
    expect(row).toContain("../packages/kernel/src/driver.ts");
  });

  test("turn-lifecycle and progress have no Kernel caller and stay diagnostic only", () => {
    const callers = section(guide, "### Live callers");
    for (const point of ["turn-lifecycle", "progress"]) {
      expect(tableRow(callers, point)).toContain("none: diagnostic only");
    }
  });

  test("every declared Hook point has a live-callers row", () => {
    const callers = section(guide, "### Live callers");
    const declared = read("packages/plugins/src/hook-points.ts").match(
      /^ {2}"?([a-z-]+)"?: defineHookPoint/gm,
    );
    expect(declared?.length).toBeGreaterThan(0);
    for (const line of declared ?? []) {
      const name = line.trim().replace(/"/g, "").split(":")[0] ?? "";
      tableRow(callers, name);
    }
  });

  test("the diagnostic-versus-durable section classifies Tap as diagnostic and the send as durable", () => {
    const text = section(guide, "### Diagnostic versus durable signals");
    expect(text).toContain("Every `Tap` point is **diagnostic**");
    expect(text).toContain("`hook_tap_dropped`");
    expect(text).toContain("The **durable** Session lifecycle signal is the reflection send");
    expect(text).toContain("`POPEYE_REFLECT_INTAKE`");
    expect(text).toContain("Paths that end a Session with no close report");
    expect(text).toContain("uncovered path");
  });
});

describe("the Kernel lifecycle seams", () => {
  test("sessions.ts, driver.ts, and the reflection modules never report from turn-lifecycle or progress", () => {
    for (const path of [
      "packages/kernel/src/sessions.ts",
      "packages/kernel/src/driver.ts",
      "packages/kernel/src/session-lifecycle.ts",
      "packages/kernel/src/reflection-producer.ts",
    ]) {
      const text = read(path);
      expect({ path, turnLifecycle: text.includes("turn-lifecycle") }).toEqual({
        path,
        turnLifecycle: false,
      });
      expect({ path, progressPoint: /["']progress["']/.test(text) }).toEqual({
        path,
        progressPoint: false,
      });
    }
    for (const path of [
      "packages/kernel/src/session-lifecycle.ts",
      "packages/kernel/src/reflection-producer.ts",
    ]) {
      expect(read(path)).not.toMatch(/ProgressHub|subscribeProgress/);
    }
  });
});
