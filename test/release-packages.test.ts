/**
 * Issue #69: the release script packs the real workspace and its gate passes on what it packed.
 * This proves the files fields keep src/ and tests out of every tarball, and that pnpm pack
 * rewrites every workspace: specifier, on the same code path the publish job uses.
 * The publish and smoke adapters run against a fake npm on PATH that records its calls and never
 * uploads, so a broken tarball must stop the adapter before any registry read or upload.
 * Requires a prior `pnpm build` (CI runs it before `pnpm test`).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// Every test here spawns node, tar, or npm; the 5 s default flakes on slower CI runners.
vi.setConfig({ testTimeout: 15_000 });

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repositoryRoot, "scripts", "release-packages.mjs");
const cliVersion = (
  JSON.parse(readFileSync(join(repositoryRoot, "packages/cli/package.json"), "utf8")) as {
    version: string;
  }
).version;

const runScript = (
  arguments_: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>> = {},
) =>
  spawnSync(process.execPath, [script, ...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, CI: "1", ...environment },
  });

const git = (...arguments_: ReadonlyArray<string>): string => {
  const result = spawnSync("git", arguments_, { cwd: repositoryRoot, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
};

const tar = (...arguments_: ReadonlyArray<string>): string => {
  const result = spawnSync("tar", arguments_, { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
};

// A stand-in for npm. It appends each argv to FAKE_NPM_LOG as one JSON line and never touches
// the network. install writes stub packages and a popeye bin whose behaviour FAKE_NPM_MODE picks.
const fakeNpmSource = String.raw`
const { appendFileSync, chmodSync, mkdirSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(argv) + "\n");
const mode = process.env.FAKE_NPM_MODE ?? "ok";
const command = argv[0];
if (command === "--version") {
  process.stdout.write((process.env.FAKE_NPM_VERSION ?? "11.12.1") + "\n");
} else if (command === "view") {
  const published = JSON.parse(process.env.FAKE_NPM_PUBLISHED ?? "{}");
  if (argv[1] in published) process.stdout.write(JSON.stringify(published[argv[1]]));
  else {
    process.stderr.write("npm error code E404\n");
    process.exitCode = 1;
  }
} else if (command === "install") {
  if (mode === "install-fail") {
    process.stderr.write("npm error install failed\n");
    process.exitCode = 1;
  } else {
    let cliVersion = "";
    for (const tarball of argv.filter((value) => value.endsWith(".tgz"))) {
      const manifest = JSON.parse(
        execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }),
      );
      const directory = join("node_modules", manifest.name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ exports: "./index.js", name: manifest.name, type: "module", version: manifest.version }),
      );
      const failImport = mode === "import-fail" && manifest.name === "@dungle-scrubs/popeye-kernel";
      writeFileSync(
        join(directory, "index.js"),
        failImport ? 'throw new Error("fake import failure");\n' : "export {};\n",
      );
      if (manifest.name === "@dungle-scrubs/popeye") cliVersion = manifest.version;
    }
    mkdirSync(join("node_modules", ".bin"), { recursive: true });
    const printed = mode === "wrong-version" ? "9.9.9" : cliVersion;
    const help = mode === "help-fail" ? 'echo "boom" >&2; exit 1' : 'echo "Usage: popeye"';
    const bin = join("node_modules", ".bin", "popeye");
    writeFileSync(
      bin,
      ["#!/bin/sh", 'case "$1" in', "  --version) echo " + printed + " ;;", "  --help) " + help + " ;;", "esac", ""].join("\n"),
    );
    chmodSync(bin, 0o755);
  }
} else if (command !== "publish") {
  process.stderr.write("fake npm: unexpected command " + command + "\n");
  process.exitCode = 1;
}
`;

const packageNames = [
  "@dungle-scrubs/popeye",
  "@dungle-scrubs/popeye-journal",
  "@dungle-scrubs/popeye-kernel",
  "@dungle-scrubs/popeye-plugins",
  "@dungle-scrubs/popeye-protocol",
] as const;

let root = "";
let packs = "";
let fakeBin = "";
let scratchCount = 0;

/** A fresh directory under the test root. */
const scratch = async (label: string): Promise<string> => {
  scratchCount += 1;
  const directory = join(root, `${label}-${String(scratchCount)}`);
  await mkdir(directory, { recursive: true });
  return directory;
};

/** Copy the packed tarballs, optionally only those whose package name passes the filter. */
const copyPacks = async (filter: (name: string) => boolean = () => true): Promise<string> => {
  const directory = await scratch("packs");
  for (const file of await readdir(packs)) {
    const name = JSON.parse(tar("-xzOf", join(packs, file), "package/package.json")).name as string;
    if (filter(name)) await copyFile(join(packs, file), join(directory, file));
  }
  return directory;
};

/** Copy the packed tarballs and give one of them a workspace: dependency. */
const packsWithWorkspaceSpecifier = async (target: string): Promise<string> => {
  const directory = await copyPacks();
  for (const file of await readdir(directory)) {
    const path = join(directory, file);
    const manifest = JSON.parse(tar("-xzOf", path, "package/package.json")) as {
      dependencies?: Record<string, string>;
      name: string;
    };
    if (manifest.name !== target) continue;
    const unpacked = await scratch("unpacked");
    tar("-xzf", path, "-C", unpacked);
    const sibling =
      target === "@dungle-scrubs/popeye-journal"
        ? "@dungle-scrubs/popeye-protocol"
        : "@dungle-scrubs/popeye-journal";
    manifest.dependencies = { ...manifest.dependencies, [sibling]: "workspace:*" };
    await writeFile(join(unpacked, "package", "package.json"), JSON.stringify(manifest, null, 2));
    tar("-czf", path, "-C", unpacked, "package");
  }
  return directory;
};

/** Run the script with the fake npm first on PATH; return the result and npm's recorded argv. */
const runWithFakeNpm = async (
  arguments_: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>> = {},
) => {
  const log = join(await scratch("npm-log"), "calls.jsonl");
  await writeFile(log, "");
  const result = runScript(arguments_, {
    FAKE_NPM_LOG: log,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    ...environment,
  });
  const calls = (await readFile(log, "utf8"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as ReadonlyArray<string>);
  return { calls, result };
};

beforeAll(async () => {
  expect(
    existsSync(join(repositoryRoot, "packages/cli/dist/bin/popeye.js")),
    "run pnpm build before this test",
  ).toBe(true);
  root = await mkdtemp(join(tmpdir(), "popeye-release-packages-"));
  packs = join(root, "packs");
  const result = runScript(["pack", "--out", packs]);
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  fakeBin = join(root, "fake-bin");
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, "npm.cjs"), fakeNpmSource);
  await writeFile(
    join(fakeBin, "npm"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$(dirname "$0")/npm.cjs" "$@"\n`,
  );
  await chmod(join(fakeBin, "npm"), 0o755);
}, 120_000);

afterAll(async () => {
  if (root !== "") await rm(root, { force: true, recursive: true });
});

describe("release-packages pack and verify on the real workspace", () => {
  test("pack writes one tarball per public workspace package", async () => {
    expect((await readdir(packs)).sort()).toEqual([
      `dungle-scrubs-popeye-${cliVersion}.tgz`,
      `dungle-scrubs-popeye-journal-${cliVersion}.tgz`,
      `dungle-scrubs-popeye-kernel-${cliVersion}.tgz`,
      `dungle-scrubs-popeye-plugins-${cliVersion}.tgz`,
      `dungle-scrubs-popeye-protocol-${cliVersion}.tgz`,
    ]);
  });

  test("verify passes with the matching CLI release tag", () => {
    const result = runScript(["verify", "--packs", packs, "--tag", `popeye-v${cliVersion}`]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  test("verify rejects a CLI tarball missing its kernel dependency declaration", async () => {
    const directory = await copyPacks();
    const path = join(directory, `dungle-scrubs-popeye-${cliVersion}.tgz`);
    const unpacked = await scratch("missing-dependency");
    tar("-xzf", path, "-C", unpacked);
    const manifestPath = join(unpacked, "package", "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    delete manifest.dependencies["@dungle-scrubs/popeye-kernel"];
    await writeFile(manifestPath, JSON.stringify(manifest));
    tar("-czf", path, "-C", unpacked, "package");

    const result = runScript(["verify", "--packs", directory]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("UNDECLARED_DEPENDENCY: @dungle-scrubs/popeye:");
    expect(result.stderr).toContain("dist/");
    expect(result.stderr).toContain("@dungle-scrubs/popeye-kernel");
  });

  test("verify fails before upload when the tag does not match the packed version", () => {
    const result = runScript(["verify", "--packs", packs, "--tag", "popeye-v0.0.0"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("TAG_MISMATCH");
  });

  test("verify refuses a tag that is not a CLI release tag as a usage error", () => {
    const result = runScript(["verify", "--packs", packs, "--tag", "v0.1.4"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("popeye-v");
  });

  test("pack refuses an output directory that already holds tarballs", () => {
    const result = runScript(["pack", "--out", packs]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(".tgz");
  });
});

describe("release-packages fatal errors", () => {
  const preload = async (event: "uncaughtException" | "unhandledRejection") => {
    const path = join(await scratch("preload"), "fault.mjs");
    const fault =
      event === "uncaughtException"
        ? 'throw new Error("injected async fault");'
        : 'Promise.reject(new Error("injected async fault"));';
    await writeFile(
      path,
      `process.on("newListener", (name) => {
        if (name === ${JSON.stringify(event)}) setImmediate(() => { ${fault} });
      });\n`,
    );
    return { NODE_OPTIONS: `--import=${JSON.stringify(path)}` };
  };

  test.each(["uncaughtException", "unhandledRejection"] as const)(
    "%s during pending verify work is terminal with exit 70",
    async (event) => {
      const result = runScript(["verify", "--packs", packs], await preload(event));

      expect(result.stderr).toContain("INTERNAL:");
      expect(result.stderr).toContain("injected async fault");
      expect(result.status).toBe(70);
      expect(result.stdout).not.toContain("verified");
    },
  );

  test("an asynchronous crash stops publish before registry reads or uploads", async () => {
    const { calls, result } = await runWithFakeNpm(
      ["publish", "--packs", packs, "--tag", `popeye-v${cliVersion}`, "--dry-run"],
      await preload("uncaughtException"),
    );

    expect(result.stderr).toContain("INTERNAL:");
    expect(result.stderr).toContain("injected async fault");
    expect(result.status).toBe(70);
    expect(calls.filter((call) => call[0] === "publish")).toEqual([]);
    expect(calls.filter((call) => call[0] === "view")).toEqual([]);
  });
});

describe("release-packages source check", () => {
  const tag = `popeye-v${cliVersion}`;

  test("passes when HEAD is the run's commit on the release tag or on main", () => {
    const head = git("rev-parse", "HEAD");
    for (const ref of [`refs/tags/${tag}`, "refs/heads/main"]) {
      const result = runScript(["source", "--tag", tag, "--ref", ref, "--sha", head]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
    }
  });

  test("fails with exit 1 when HEAD is not the run's commit", () => {
    const result = runScript([
      "source",
      "--tag",
      tag,
      "--ref",
      "refs/heads/main",
      "--sha",
      "0".repeat(40),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SOURCE_SHA_MISMATCH");
  });

  test("fails with exit 1 when the run was started on a branch other than main", () => {
    const head = git("rev-parse", "HEAD");
    const result = runScript([
      "source",
      "--tag",
      tag,
      "--ref",
      "refs/heads/feature",
      "--sha",
      head,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SOURCE_REF_MISMATCH");
  });

  test("a missing --sha or a tag that is not a CLI release tag is a usage error", () => {
    expect(runScript(["source", "--tag", tag, "--ref", "refs/heads/main"]).status).toBe(2);
    expect(
      runScript(["source", "--tag", "v0.1.4", "--ref", "refs/heads/main", "--sha", "0".repeat(40)])
        .status,
    ).toBe(2);
  });
});

describe("release-packages publish with a fake npm", () => {
  const tag = `popeye-v${cliVersion}`;

  test.each(packageNames)(
    "a workspace: specifier in %s stops publish before any registry read or upload",
    async (name) => {
      const directory = await packsWithWorkspaceSpecifier(name);
      const { calls, result } = await runWithFakeNpm([
        "publish",
        "--packs",
        directory,
        "--tag",
        tag,
        "--dry-run",
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`WORKSPACE_SPECIFIER: ${name}:`);
      expect(calls).toEqual([["--version"]]);
    },
  );

  test("publishes dependencies first, with provenance, and skips versions the registry has", async () => {
    const directory = await copyPacks();
    const { calls, result } = await runWithFakeNpm(
      ["publish", "--packs", directory, "--tag", tag, "--dry-run"],
      {
        FAKE_NPM_PUBLISHED: JSON.stringify({
          "@dungle-scrubs/popeye-journal": ["0.0.1", cliVersion],
        }),
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`skip @dungle-scrubs/popeye-journal@${cliVersion}`);
    expect(
      calls
        .filter((call) => call[0] === "view")
        .map((call) => call[1])
        .sort(),
    ).toEqual([...packageNames]);
    const tarballOf = (name: string) =>
      join(directory, `${name.replace("@", "").replace("/", "-")}-${cliVersion}.tgz`);
    expect(calls.filter((call) => call[0] === "publish")).toEqual(
      [
        "@dungle-scrubs/popeye-protocol",
        "@dungle-scrubs/popeye-kernel",
        "@dungle-scrubs/popeye-plugins",
        "@dungle-scrubs/popeye",
      ].map((name) => [
        "publish",
        tarballOf(name),
        "--access",
        "public",
        "--provenance",
        "--dry-run",
      ]),
    );
  });

  test("an npm older than 11.5.1 stops publish with exit 3 before any registry read", async () => {
    const directory = await copyPacks();
    const { calls, result } = await runWithFakeNpm(
      ["publish", "--packs", directory, "--tag", tag, "--dry-run"],
      { FAKE_NPM_VERSION: "10.9.2" },
    );

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("11.5.1");
    expect(calls).toEqual([["--version"]]);
  });
});

describe("release-packages smoke with a fake npm", () => {
  test("passes when the installed CLI and every package import work", async () => {
    const directory = await copyPacks();
    const { calls, result } = await runWithFakeNpm(["smoke", "--packs", directory]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("smoke passed for 5 tarballs");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 3)).toEqual(["install", "--no-audit", "--no-fund"]);
    expect(calls[0]?.filter((value) => value.endsWith(".tgz"))).toHaveLength(5);
  });

  test("a failed npm install exits 3", async () => {
    const { result } = await runWithFakeNpm(["smoke", "--packs", await copyPacks()], {
      FAKE_NPM_MODE: "install-fail",
    });

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("npm install");
  });

  test.each([
    ["wrong-version", "SMOKE_VERSION"],
    ["help-fail", "SMOKE_HELP"],
    ["import-fail", "SMOKE_IMPORT"],
  ])("an installed CLI or package that breaks (%s) exits 1 with %s", async (mode, code) => {
    const { result } = await runWithFakeNpm(["smoke", "--packs", await copyPacks()], {
      FAKE_NPM_MODE: mode,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(code);
  });

  test("smoke with no CLI tarball is a usage error and installs nothing", async () => {
    const { calls, result } = await runWithFakeNpm(["smoke", "--packs", await scratch("empty")]);

    expect(result.status).toBe(2);
    expect(calls).toEqual([]);
  });

  test("verify fails the package set when only the CLI tarball is present", async () => {
    const directory = await copyPacks((name) => name === "@dungle-scrubs/popeye");
    const result = runScript(["verify", "--packs", directory]);

    expect(result.status).toBe(1);
    expect(result.stderr.match(/PACKAGE_SET_MISMATCH/g)).toHaveLength(4);
  });
});

describe("release-packages usage contract", () => {
  test("--help prints the subcommands and the exit-code map", () => {
    const result = runScript(["--help"]);

    expect(result.status).toBe(0);
    for (const word of ["source", "pack", "verify", "smoke", "publish", "check", "Exit codes"]) {
      expect(result.stdout).toContain(word);
    }
  });

  test("an unknown subcommand or option is a usage error with exit 2", () => {
    const unknownCommand = runScript(["ship"]);
    expect(unknownCommand.status).toBe(2);
    expect(unknownCommand.stderr).toContain("Usage");

    const unknownOption = runScript(["verify", "--packs", packs, "--nope"]);
    expect(unknownOption.status).toBe(2);
  });

  test("publish without --tag is a usage error and uploads nothing", () => {
    const result = runScript(["publish", "--packs", packs, "--dry-run"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--tag");
  });
});
