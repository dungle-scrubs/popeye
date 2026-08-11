/**
 * Owns the systematic M24 crash matrix over Driver sessions and the JSONL fault seam.
 * It exists to prove each durable boundary recovers through the public Session interface.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import {
  enumerateJournalBoundaries,
  recordCanonicalRecoverySessions,
  runCorruptionRejectionCell,
  runDoubleRecoveryCell,
  runOrphanedPromptDoubleRecoveryCell,
  runRecoveryBoundaryMatrix,
  runTornTailRecoveryMatrix,
} from "./recovery-matrix.js";

test("the canonical journal fixture derives every durable boundary without hardcoded indices", async () => {
  const fixture = await readFile(
    new URL("../test-fixtures/canonical-driver-session.jsonl", import.meta.url),
    "utf8",
  );

  const boundaries = enumerateJournalBoundaries(fixture);

  expect(boundaries.map(({ acknowledgement }) => acknowledgement)).toEqual(
    Array.from({ length: 23 }, (_, index) => index + 1),
  );
  expect(new Set(boundaries.map(({ kind }) => kind))).toEqual(
    new Set([
      "compaction",
      "header",
      "leaf_moved",
      "message:assistant",
      "message:toolResult",
      "message:user",
      "operation_finished",
      "operation_started",
      "tool_started",
    ]),
  );
});

test("a second crash during synthesis remains idempotent on the next resume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peye-kernel-m24-double-"));
  try {
    const cell = await runDoubleRecoveryCell(directory);

    expect(cell).toEqual({
      finalReportActionCount: 0,
      firstRecoveryCrashed: true,
      interruptedAssistantCount: 1,
      operationFinishedCount: 1,
      originalTurnCrashed: true,
      recoveryReportEmitted: true,
      recoverySpanEmitted: true,
      toolResultIds: ["never-call", "safe-call"],
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("orphaned-prompt recovery remains idempotent after its assistant append crashes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peye-kernel-m24-orphaned-double-"));
  try {
    const cell = await runOrphanedPromptDoubleRecoveryCell(directory);

    expect(cell).toEqual({
      finalReportActionCount: 0,
      finalReportEntriesAppendedCount: 0,
      firstRecoveryCrashed: true,
      interruptedAssistantCount: 1,
      operationRecordCount: 0,
      originalTurnCrashed: true,
      retryActionCount: 1,
      retryEntriesAppendedCount: 0,
      retryOperationIdFound: undefined,
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("acknowledged impossible Records reject without modifying the journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peye-kernel-m24-corrupt-"));
  try {
    const cell = await runCorruptionRejectionCell(directory);

    expect(cell).toEqual({
      action: "reject-corrupt",
      corruptionClass: "invalid_record_sequence",
      fileByteExact: true,
      recoveryReportEmitted: false,
      recoverySpanFailed: true,
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("every acknowledged Driver boundary recovers with its expected report and span", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peye-kernel-m24-matrix-"));
  try {
    const matrix = await runRecoveryBoundaryMatrix(directory);

    expect(matrix.cells).toHaveLength(matrix.boundaryCount);
    expect(matrix.boundaryCount).toBe(50);
    for (const cell of matrix.cells) {
      expect(cell, `${cell.script} acknowledgement ${cell.acknowledgement}`).toMatchObject({
        acceptsNewPrompt: true,
        completedToolResultsPreserved: true,
        crashed: true,
        duplicateToolCallIds: [],
        expectedAction: cell.actualAction,
        openOperationIds: [],
        recoveryReportEmitted: true,
        recoverySpanEmitted: true,
        recoveryTerminalMarked: true,
        terminalStopReason: "done",
        unresolvedToolCallIds: [],
      });
    }

    const toolStarts = matrix.cells.filter(({ boundaryKind }) => boundaryKind === "tool_started");
    expect(toolStarts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ replay: "never", safeReplayToolCallIds: [] }),
        expect.objectContaining({ replay: "safe", safeReplayToolCallIds: ["safe-call"] }),
      ]),
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 60_000);

test("Driver scripts record the canonical recovery boundary set", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peye-kernel-m24-record-"));
  try {
    const sessions = await recordCanonicalRecoverySessions(directory);

    expect(sessions.map(({ name }) => name)).toEqual([
      "tool-free-turn",
      "tool-turn",
      "multi-tool-round-turn",
      "steering-loop",
      "compaction",
    ]);
    expect(
      new Set(sessions.flatMap(({ boundaries }) => boundaries.map(({ kind }) => kind))),
    ).toEqual(
      new Set([
        "compaction",
        "header",
        "leaf_moved",
        "message:assistant",
        "message:toolResult",
        "message:user",
        "operation_finished",
        "operation_started",
        "tool_started",
      ]),
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("torn-tail recovery survives every file-generation swap boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peye-kernel-m24-torn-tail-"));
  try {
    const cells = await runTornTailRecoveryMatrix(directory);

    expect(cells.map(({ boundary }) => boundary)).toEqual([
      "torn-tail-only",
      "generation-swap:temporary-write",
      "generation-swap:temporary-sync",
      "generation-swap:directory-sync",
    ]);
    expect(cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ boundary: "torn-tail-only", recoveredDiagnosticEmitted: true }),
        expect.objectContaining({
          boundary: "generation-swap:directory-sync",
          recoveredDiagnosticEmitted: false,
        }),
      ]),
    );
    for (const cell of cells) {
      expect(cell, cell.boundary).toMatchObject({
        acknowledgedPrefixByteExact: true,
        openedDiagnosticEmitted: true,
        sessionReadable: true,
      });
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
