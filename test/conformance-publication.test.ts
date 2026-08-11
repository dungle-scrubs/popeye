/**
 * Owns the packed-package clean-room proof for both published conformance subpaths.
 * It exists so workspace source resolution cannot hide a missing export or runtime dependency.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const storeDirectory = join(repositoryRoot, ".pnpm-store");

interface CommandResult {
  readonly output: string;
}

const run = (cwd: string, arguments_: ReadonlyArray<string>): CommandResult => {
  const result = spawnSync("pnpm", arguments_, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(`pnpm ${arguments_.join(" ")} failed with status ${result.status}.\n${output}`);
  }
  return { output };
};

const packedTarball = async (directory: string, prefix: string): Promise<string> => {
  const matches = (await readdir(directory)).filter(
    (name) => name.startsWith(prefix) && name.endsWith(".tgz"),
  );
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`Expected one packed ${prefix} tarball, found ${matches.length}.`);
  }
  return join(directory, matches[0]);
};

test("packed packages run both conformance suites in a clean consumer", async () => {
  const root = await mkdtemp(join(tmpdir(), "pop-eye-conformance-consumer-"));
  const consumerDirectory = join(root, "consumer");
  const packDirectory = join(root, "packs");
  try {
    await mkdir(consumerDirectory, { recursive: true });
    await mkdir(packDirectory, { recursive: true });
    run(repositoryRoot, ["build"]);
    for (const packageName of ["@pop-eye/journal", "@pop-eye/protocol", "@pop-eye/kernel"]) {
      run(repositoryRoot, ["--filter", packageName, "pack", "--pack-destination", packDirectory]);
    }

    const journalTarball = await packedTarball(packDirectory, "pop-eye-journal-");
    const kernelTarball = await packedTarball(packDirectory, "pop-eye-kernel-");
    const protocolTarball = await packedTarball(packDirectory, "pop-eye-protocol-");
    await writeFile(
      join(consumerDirectory, "package.json"),
      `${JSON.stringify(
        {
          name: "pop-eye-clean-room",
          private: true,
          type: "module",
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(consumerDirectory, "pnpm-workspace.yaml"),
      `${JSON.stringify(
        {
          overrides: {
            "@pop-eye/journal": `file:${journalTarball}`,
            "@pop-eye/protocol": `file:${protocolTarball}`,
          },
        },
        null,
        2,
      )}\n`,
    );

    const installOptions = [
      "--offline",
      "--ignore-scripts",
      "--config.auto-install-peers=false",
      "--store-dir",
      storeDirectory,
    ];
    run(consumerDirectory, [
      "add",
      ...installOptions,
      "effect@3.22.1",
      journalTarball,
      kernelTarball,
      protocolTarball,
    ]);
    await writeFile(
      join(consumerDirectory, "check-main.mjs"),
      `import assert from "node:assert/strict";
import { access } from "node:fs/promises";

await assert.rejects(access(new URL("./node_modules/vitest/package.json", import.meta.url)));
const journal = await import("@pop-eye/journal");
const kernel = await import("@pop-eye/kernel");
assert.equal(journal.journalPackage, "@pop-eye/journal");
assert.equal(kernel.kernelPackage, "@pop-eye/kernel");
`,
    );
    run(consumerDirectory, ["exec", "node", "check-main.mjs"]);

    run(consumerDirectory, ["add", "--save-dev", ...installOptions, "vitest@3.2.7"]);
    await writeFile(
      join(consumerDirectory, "conformance.test.ts"),
      `import {
  createMemoryJournalContractHarness,
  describeJournalContract,
} from "@pop-eye/journal/conformance";
import {
  createPiAiSeamContractHarness,
  describeAiSeamContract,
} from "@pop-eye/kernel/ai-conformance";

await describeJournalContract(createMemoryJournalContractHarness);
await describeAiSeamContract(createPiAiSeamContractHarness);
`,
    );
    const result = run(consumerDirectory, ["exec", "vitest", "run", "conformance.test.ts"]);

    expect(result.output).toContain("conformance.test.ts");
    expect(result.output).toContain("passed");
    const manifest = await readFile(join(consumerDirectory, "package.json"), "utf8");
    expect(manifest).toContain('"@pop-eye/journal"');
    expect(manifest).toContain('"@pop-eye/kernel"');
    expect(manifest).toContain('"vitest"');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 120_000);
