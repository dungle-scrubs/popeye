import { readFile } from "node:fs/promises";

import { Effect } from "effect";
import { beforeAll, expect, test } from "vitest";

import {
  measureSnapshotSizes,
  renderSnapshotSizeReport,
  SNAPSHOT_SIZE_HARD_CONCERN_BYTES,
  SNAPSHOT_SIZE_SCENARIOS,
  SNAPSHOT_SIZE_SOFT_WARNING_BYTES,
  type SnapshotSizeMeasurement,
  snapshotSizeReportUrl,
} from "./snapshot-size.js";

let measurements: ReadonlyArray<SnapshotSizeMeasurement> = [];
let recordedReport = "";

beforeAll(async () => {
  [measurements, recordedReport] = await Promise.all([
    Effect.runPromise(measureSnapshotSizes),
    readFile(snapshotSizeReportUrl, "utf8"),
  ]);
}, 120_000);

test("M23 measures snapshot payload sizes across recorded long sessions", () => {
  expect(measurements.map(({ turns }) => turns)).toEqual([...SNAPSHOT_SIZE_SCENARIOS]);
  expect(measurements.every(({ entries, snapshotBytes }) => entries > 0 && snapshotBytes > 0)).toBe(
    true,
  );
  expect(measurements.some(({ compacted }) => compacted)).toBe(true);
  expect(measurements.some(({ toolTurns }) => toolTurns > 0)).toBe(true);
  for (let index = 1; index < measurements.length; index += 1) {
    const previous = measurements[index - 1];
    const current = measurements[index];
    expect(current?.entries).toBeGreaterThan(previous?.entries ?? 0);
    expect(current?.snapshotBytes).toBeGreaterThan(previous?.snapshotBytes ?? 0);
  }
});

test("M23 records a deterministic report with threshold comparisons", () => {
  expect(recordedReport).toBe(renderSnapshotSizeReport(measurements));
  expect(recordedReport).toContain("| Turns | Tool turns | Compacted | Entries | Encoded bytes");
  expect(recordedReport).toContain(
    `Soft warning: ${SNAPSHOT_SIZE_SOFT_WARNING_BYTES.toLocaleString("en-US")} bytes`,
  );
  expect(recordedReport).toContain(
    `Hard concern: ${SNAPSHOT_SIZE_HARD_CONCERN_BYTES.toLocaleString("en-US")} bytes`,
  );
  expect(recordedReport).toContain("## Limits");
});

test("M23 records the pagination go/no-go from the measured hard-threshold crossing", () => {
  const crossesHardThreshold = measurements.some(
    ({ snapshotBytes }) => snapshotBytes >= SNAPSHOT_SIZE_HARD_CONCERN_BYTES,
  );
  expect(recordedReport).toContain("## Pagination go/no-go");
  expect(recordedReport).toContain(
    crossesHardThreshold
      ? "Decision: GO - activate reserved entry-id pagination"
      : "Decision: NO-GO - retain full-transcript snapshots",
  );
  expect(recordedReport).toContain(
    `Activation threshold: ${SNAPSHOT_SIZE_HARD_CONCERN_BYTES.toLocaleString("en-US")} encoded bytes`,
  );
});
