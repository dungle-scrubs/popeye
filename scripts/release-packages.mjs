/**
 * Release CLI for the npm packages (issue #69): source, pack, verify, smoke, publish, check.
 * The gate rules live in release-core.mjs; this file reads tarballs and runs git, pnpm, npm, and
 * tar.
 */
import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  CLI_PACKAGE_NAME,
  checkPackedPackages,
  checkReleaseSource,
  checkSmokeResults,
  MINIMUM_NPM_VERSION,
  meetsMinimumVersion,
  parseReleaseTag,
  planPublish,
} from "./release-core.mjs";

/** @typedef {import("./release-core.mjs").PackedPackage} PackedPackage */
/** @typedef {import("./release-core.mjs").ReleaseViolation} ReleaseViolation */

const EXIT = Object.freeze({ COMMAND: 3, CRASH: 70, GATE: 1, OK: 0, USAGE: 2 });

const USAGE = `Usage: node scripts/release-packages.mjs <command> [options]

Commands:
  source --tag <tag> --ref <ref> --sha <sha>
                                      Check that the checked-out commit (git HEAD) is <sha> and that
                                      <ref> is refs/heads/main or refs/tags/<tag>. The publish job
                                      passes the run's GITHUB_REF and GITHUB_SHA.
  pack --out <dir>                    Pack every public workspace package into <dir> (must hold no .tgz).
  verify --packs <dir> [--tag <tag>]  Check the tarballs in <dir>: no workspace: specifiers, dist only,
                                      bin and exports present, one shared version, version equals tag.
  smoke --packs <dir>                 Install the tarballs into a clean npm project; run popeye --version,
                                      popeye --help, and import each package.
  publish --packs <dir> --tag <tag> [--dry-run]
                                      Verify again, then npm publish each tarball whose version the
                                      registry lacks, dependencies first, with provenance.
  check                               pack, verify, and smoke in a temporary directory.

<tag> is the CLI release tag, popeye-v<version>.

Exit codes:
  0   ok
  1   gate failure: a source, verify, or smoke rule failed; nothing was published
  2   usage error
  3   a git, pnpm, npm, or tar command failed, or npm is older than ${MINIMUM_NPM_VERSION}
  70  internal error
`;

class UsageError extends Error {}
class CommandError extends Error {}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @param {string} command
 * @param {ReadonlyArray<string>} arguments_
 * @param {{ cwd?: string, allowFailure?: boolean }} [options]
 */
function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const outcome = {
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
  if (!options.allowFailure && outcome.status !== 0) {
    throw new CommandError(
      `${command} ${arguments_.join(" ")} exited ${String(outcome.status)}\n${outcome.stdout}${outcome.stderr}`,
    );
  }
  return outcome;
}

/** @returns {Promise<Array<{ directory: string, manifest: Record<string, unknown> }>>} */
async function publicWorkspacePackages() {
  const packagesDirectory = join(repositoryRoot, "packages");
  const names = (await readdir(packagesDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const packages = [];
  for (const name of names) {
    const directory = join(packagesDirectory, name);
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    if (manifest.private !== true) packages.push({ directory, manifest });
  }
  return packages;
}

/** @param {string} directory */
async function tarballsIn(directory) {
  return (await readdir(directory)).filter((name) => name.endsWith(".tgz")).sort();
}

/**
 * @param {string} tag
 * @param {string} eventRef
 * @param {string} eventSha
 */
function source(tag, eventRef, eventSha) {
  versionFromTag(tag);
  const headSha = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  const violations = checkReleaseSource({ eventRef, eventSha, headSha, tag });
  report(violations);
  if (violations.length === 0) console.log(`source ${headSha} matches ${eventRef}`);
  return violations.length === 0;
}

/** @param {string} out */
async function packCommand(out) {
  await mkdir(out, { recursive: true });
  const existing = await tarballsIn(out);
  if (existing.length > 0) {
    throw new UsageError(
      `${out} already holds .tgz files (${existing.join(", ")}); use an empty directory.`,
    );
  }
  for (const { directory } of await publicWorkspacePackages()) {
    run("pnpm", ["pack", "--pack-destination", out], { cwd: directory });
  }
  for (const file of await tarballsIn(out)) console.log(join(out, file));
}

/**
 * @param {string} directory
 * @returns {Promise<Array<PackedPackage & { path: string }>>}
 */
async function readPacks(directory) {
  const packs = [];
  for (const file of await tarballsIn(directory)) {
    const path = join(directory, file);
    const manifest = JSON.parse(run("tar", ["-xzOf", path, "package/package.json"]).stdout);
    const entries = run("tar", ["-tzf", path])
      .stdout.split("\n")
      .filter((line) => line !== "" && !line.endsWith("/"))
      .map((line) => line.replace(/^package\//, ""));
    /** @type {Record<string, string>} */
    const sources = {};
    for (const entry of entries) {
      if (entry.startsWith("dist/") && entry.endsWith(".js")) {
        sources[entry] = run("tar", ["-xzOf", path, `package/${entry}`]).stdout;
      }
    }
    packs.push({ entries, file, manifest, path, sources });
  }
  return packs;
}

/** @param {ReadonlyArray<ReleaseViolation>} violations */
function report(violations) {
  for (const violation of violations) {
    console.error(`${violation.code}: ${violation.package}: ${violation.detail}`);
  }
}

/** @param {string | undefined} tag */
function versionFromTag(tag) {
  if (tag === undefined) return undefined;
  const version = parseReleaseTag(tag);
  if (version === undefined) {
    throw new UsageError(
      `--tag must be the CLI release tag popeye-v<version>; got ${JSON.stringify(tag)}.`,
    );
  }
  return version;
}

/**
 * @param {string} packsDirectory
 * @param {string | undefined} tag
 * @returns {Promise<{ ok: boolean, packs: Array<PackedPackage & { path: string }> }>}
 */
async function verify(packsDirectory, tag) {
  const expectedVersion = versionFromTag(tag);
  const packs = await readPacks(packsDirectory);
  const expectedNames = (await publicWorkspacePackages()).map(({ manifest }) =>
    String(manifest.name),
  );
  const violations = checkPackedPackages(packs, {
    expectedNames,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  });
  report(violations);
  if (violations.length === 0)
    console.log(`verified ${packs.length} tarballs in ${packsDirectory}`);
  return { ok: violations.length === 0, packs };
}

/** @param {string} packsDirectory */
async function smoke(packsDirectory) {
  const packs = await readPacks(packsDirectory);
  const cliPack = packs.find((pack) => pack.manifest.name === CLI_PACKAGE_NAME);
  if (cliPack === undefined)
    throw new UsageError(`${packsDirectory} has no ${CLI_PACKAGE_NAME} tarball.`);
  const consumer = await mkdtemp(join(tmpdir(), "popeye-release-smoke-"));
  try {
    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify({ name: "popeye-release-smoke", private: true, type: "module" }, null, 2)}\n`,
    );
    run("npm", ["install", "--no-audit", "--no-fund", ...packs.map((pack) => pack.path)], {
      cwd: consumer,
    });
    const bin = join(consumer, "node_modules", ".bin", "popeye");
    const imports = packs.map((pack) => ({
      name: String(pack.manifest.name),
      ...run(
        process.execPath,
        ["--input-type=module", "-e", `await import(${JSON.stringify(pack.manifest.name)});`],
        {
          allowFailure: true,
          cwd: consumer,
        },
      ),
    }));
    const violations = checkSmokeResults({
      expectedVersion: String(cliPack.manifest.version),
      help: run(bin, ["--help"], { allowFailure: true, cwd: consumer }),
      imports,
      version: run(bin, ["--version"], { allowFailure: true, cwd: consumer }),
    });
    report(violations);
    if (violations.length === 0) console.log(`smoke passed for ${packs.length} tarballs`);
    return violations.length === 0;
  } finally {
    await rm(consumer, { force: true, recursive: true });
  }
}

/** @param {string} name */
function registryVersions(name) {
  const outcome = run("npm", ["view", name, "versions", "--json"], { allowFailure: true });
  if (outcome.status === 0) {
    const parsed = JSON.parse(outcome.stdout || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  }
  if (`${outcome.stdout}${outcome.stderr}`.includes("E404")) return [];
  throw new CommandError(`npm view ${name} versions failed\n${outcome.stdout}${outcome.stderr}`);
}

/**
 * @param {string} packsDirectory
 * @param {string} tag
 * @param {boolean} dryRun
 */
async function publish(packsDirectory, tag, dryRun) {
  const npmVersion = run("npm", ["--version"]).stdout.trim();
  if (!meetsMinimumVersion(npmVersion, MINIMUM_NPM_VERSION)) {
    throw new CommandError(
      `npm ${npmVersion} is older than ${MINIMUM_NPM_VERSION}, which OIDC publishing needs.`,
    );
  }
  const verified = await verify(packsDirectory, tag);
  if (!verified.ok) return false;
  const published = new Map(
    verified.packs.map((pack) => [
      String(pack.manifest.name),
      registryVersions(String(pack.manifest.name)),
    ]),
  );
  const plan = planPublish(verified.packs, published);
  if (!plan.ok) throw plan.error;
  for (const pack of plan.value.skip)
    console.log(`skip ${pack.manifest.name}@${pack.manifest.version}: already on the registry`);
  for (const pack of plan.value.publish) {
    const path = join(packsDirectory, pack.file);
    run("npm", [
      "publish",
      path,
      "--access",
      "public",
      "--provenance",
      ...(dryRun ? ["--dry-run"] : []),
    ]);
    console.log(
      `${dryRun ? "dry-run published" : "published"} ${pack.manifest.name}@${pack.manifest.version}`,
    );
  }
  return true;
}

/** @param {ReadonlyArray<string>} argv */
async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }
  const { values } = parseArgs({
    args: [...rest],
    options: {
      "dry-run": { type: "boolean" },
      out: { type: "string" },
      packs: { type: "string" },
      ref: { type: "string" },
      sha: { type: "string" },
      tag: { type: "string" },
    },
    strict: true,
  });
  /** @param {"out" | "packs" | "ref" | "sha" | "tag"} key */
  const required = (key) => {
    const value = values[key];
    if (value === undefined || value === "") throw new UsageError(`${command} needs --${key}.`);
    return value;
  };
  switch (command) {
    case "source":
      return source(required("tag"), required("ref"), required("sha")) ? EXIT.OK : EXIT.GATE;
    case "pack":
      await packCommand(resolve(required("out")));
      return EXIT.OK;
    case "verify":
      return (await verify(resolve(required("packs")), values.tag)).ok ? EXIT.OK : EXIT.GATE;
    case "smoke":
      return (await smoke(resolve(required("packs")))) ? EXIT.OK : EXIT.GATE;
    case "publish":
      return (await publish(
        resolve(required("packs")),
        required("tag"),
        values["dry-run"] === true,
      ))
        ? EXIT.OK
        : EXIT.GATE;
    case "check": {
      const root = await mkdtemp(join(tmpdir(), "popeye-release-check-"));
      try {
        const packs = join(root, "packs");
        await packCommand(packs);
        if (!(await verify(packs, undefined)).ok) return EXIT.GATE;
        return (await smoke(packs)) ? EXIT.OK : EXIT.GATE;
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
    default:
      throw new UsageError(`unknown command ${JSON.stringify(command ?? "")}.`);
  }
}

/** @param {unknown} error */
function crash(error) {
  try {
    writeSync(
      2,
      `INTERNAL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
  } finally {
    process.exit(EXIT.CRASH);
  }
}
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (
    error instanceof UsageError ||
    (error instanceof TypeError &&
      "code" in error &&
      String(error.code).startsWith("ERR_PARSE_ARGS"))
  ) {
    process.stderr.write(`USAGE: ${error.message}\n\n${USAGE}`);
    process.exitCode = EXIT.USAGE;
  } else if (error instanceof CommandError) {
    process.stderr.write(`COMMAND: ${error.message}\n`);
    process.exitCode = EXIT.COMMAND;
  } else {
    crash(error);
  }
}
