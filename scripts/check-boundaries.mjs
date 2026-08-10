import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const importPattern = /\b(?:export|import)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g;

/** @typedef {{ code: string, file: string, message: string, specifier: string }} BoundaryViolation */

/**
 * Recursively returns TypeScript source files below a directory.
 *
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function findTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directory, entry.name);

      if (entry.isDirectory()) {
        return findTypeScriptFiles(entryPath);
      }

      return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")
        ? [entryPath]
        : [];
    }),
  );

  return files.flat();
}

/**
 * Extracts module specifiers from static TypeScript import and re-export statements.
 *
 * @param {string} source
 * @returns {string[]}
 */
function findImportSpecifiers(source) {
  return [...source.matchAll(importPattern)].map((match) => match[1]).filter(Boolean);
}

/**
 * Checks package source files under a repository-like root for architectural import violations.
 *
 * @param {string} rootDirectory
 * @returns {Promise<BoundaryViolation[]>}
 */
export async function checkBoundaries(rootDirectory) {
  const packagesDirectory = resolve(rootDirectory, "packages");
  const packageEntries = await readdir(packagesDirectory, { withFileTypes: true });
  const sourceFiles = (
    await Promise.all(
      packageEntries
        .filter((entry) => entry.isDirectory())
        .map((entry) => findTypeScriptFiles(resolve(packagesDirectory, entry.name, "src"))),
    )
  ).flat();

  /** @type {BoundaryViolation[]} */
  const violations = [];

  for (const sourceFile of sourceFiles) {
    const source = await readFile(sourceFile, "utf8");
    const sourcePath = relative(rootDirectory, sourceFile).split(sep).join("/");
    const isCliSource = sourcePath.startsWith("packages/cli/src/");
    const isCompositionModule = sourcePath === "packages/cli/src/compose.ts";
    const isKernelAiSource = sourcePath.startsWith("packages/kernel/src/ai/");
    const isFeatureSource = sourcePath.includes("/features/");

    for (const specifier of findImportSpecifiers(source)) {
      const importsKernel = specifier === "@peye/kernel" || specifier.startsWith("@peye/kernel/");
      const importsPiAi =
        specifier === "@earendil-works/pi-ai" || specifier.startsWith("@earendil-works/pi-ai/");

      if (isCliSource && importsKernel && !isCompositionModule) {
        violations.push({
          code: "CLI_KERNEL_IMPORT",
          file: sourcePath,
          message: "CLI sources may import @peye/kernel only from packages/cli/src/compose.ts.",
          specifier,
        });
      }

      if (!isKernelAiSource && importsPiAi) {
        violations.push({
          code: "PI_AI_SEAM_IMPORT",
          file: sourcePath,
          message: "Only packages/kernel/src/ai/ may import @earendil-works/pi-ai.",
          specifier,
        });
      }

      if (isFeatureSource && importsKernel && specifier.includes("/internal/")) {
        violations.push({
          code: "FEATURE_KERNEL_INTERNAL_IMPORT",
          file: sourcePath,
          message: "Feature modules may not import @peye/kernel internal paths.",
          specifier,
        });
      }
    }
  }

  return violations;
}

function parseRootDirectory(arguments_) {
  if (arguments_.length === 0) {
    return process.cwd();
  }

  if (arguments_.length === 2 && arguments_[0] === "--root") {
    return resolve(arguments_[1]);
  }

  throw new Error("Usage: node scripts/check-boundaries.mjs [--root <directory>]");
}

async function main() {
  const rootDirectory = parseRootDirectory(process.argv.slice(2));
  const violations = await checkBoundaries(rootDirectory);

  if (violations.length === 0) {
    console.log("Boundary check passed: no violations found.");
    return;
  }

  for (const violation of violations) {
    console.error(
      `${violation.code}: ${violation.file} imports ${violation.specifier}. ${violation.message}`,
    );
  }

  process.exitCode = 1;
}

const invokedAsScript =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) {
  await main();
}
