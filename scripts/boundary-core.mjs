import { glob, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export const BOUNDARY_CODES = Object.freeze({
  CLI_KERNEL_IMPORT: "CLI_KERNEL_IMPORT",
  FEATURE_DEEP_IMPORT: "FEATURE_DEEP_IMPORT",
  PI_AI_SEAM_IMPORT: "PI_AI_SEAM_IMPORT",
  PROTOCOL_POPEYE_IMPORT: "PROTOCOL_POPEYE_IMPORT",
});

/** @typedef {typeof BOUNDARY_CODES[keyof typeof BOUNDARY_CODES]} BoundaryCode */
/** @typedef {{ code: BoundaryCode, file: string, message: string, specifier: string }} BoundaryViolation */

const staticImportPattern =
  /\b(?:export|import)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g;
const dynamicImportPattern = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
const featurePublicPackages = Object.freeze([
  "@popeye/journal",
  "@popeye/kernel",
  "@popeye/plugins",
  "@popeye/protocol",
]);

/** @param {string} path */
const slashPath = (path) => path.split(sep).join("/");

/** @param {string} sourcePath @param {string} specifier */
function isFeatureDeepImport(sourcePath, specifier) {
  if (featurePublicPackages.some((packageRoot) => specifier.startsWith(`${packageRoot}/`))) {
    return true;
  }
  if (!specifier.startsWith(".")) {
    return false;
  }
  const segments = sourcePath.split("/");
  const packageRoot = segments.length >= 2 ? segments.slice(0, 2).join("/") : undefined;
  if (packageRoot === undefined) {
    return false;
  }
  const resolvedImport = slashPath(resolve(dirname(sourcePath), specifier));
  const resolvedPackageRoot = slashPath(resolve(packageRoot));
  return (
    resolvedImport !== resolvedPackageRoot && !resolvedImport.startsWith(`${resolvedPackageRoot}/`)
  );
}

/** @param {string} source */
function findImportSpecifiers(source) {
  // Strip comments first so the detector covers only real static and dynamic module forms.
  const uncommentedSource = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  return [
    ...uncommentedSource.matchAll(staticImportPattern),
    ...uncommentedSource.matchAll(dynamicImportPattern),
  ]
    .map((match) => match[1])
    .filter((specifier) => specifier !== undefined);
}

/** @param {string} rootDirectory @returns {Promise<BoundaryViolation[]>} */
export async function checkBoundaries(rootDirectory) {
  /** @type {BoundaryViolation[]} */
  const violations = [];

  for await (const sourceFile of glob("packages/*/src/**/*.{ts,mts,cts,tsx}", {
    cwd: rootDirectory,
    exclude: ["**/*.d.mts", "**/*.d.ts"],
  })) {
    const absoluteSourceFile = resolve(rootDirectory, sourceFile);
    const source = await readFile(absoluteSourceFile, "utf8");
    const sourcePath = slashPath(relative(rootDirectory, absoluteSourceFile));
    const isCliSource = sourcePath.startsWith("packages/cli/src/");
    const isCompositionModule = sourcePath === "packages/cli/src/compose.ts";
    const isFeatureSource = sourcePath.split("/").includes("features");
    const isKernelAiSource = sourcePath.startsWith("packages/kernel/src/ai/");
    const isProtocolSource = sourcePath.startsWith("packages/protocol/src/");

    for (const specifier of findImportSpecifiers(source)) {
      const importsKernel =
        specifier === "@popeye/kernel" || specifier.startsWith("@popeye/kernel/");
      const importsPiAi =
        specifier === "@earendil-works/pi-ai" || specifier.startsWith("@earendil-works/pi-ai/");
      const importsPopeye = specifier.startsWith("@popeye/");

      if (isCliSource && importsKernel && !isCompositionModule) {
        violations.push({
          code: BOUNDARY_CODES.CLI_KERNEL_IMPORT,
          file: sourcePath,
          message: "CLI sources may import @popeye/kernel only from packages/cli/src/compose.ts.",
          specifier,
        });
      }

      if (!isKernelAiSource && importsPiAi) {
        violations.push({
          code: BOUNDARY_CODES.PI_AI_SEAM_IMPORT,
          file: sourcePath,
          message: "Only packages/kernel/src/ai/ may import @earendil-works/pi-ai.",
          specifier,
        });
      }

      if (isFeatureSource && isFeatureDeepImport(sourcePath, specifier)) {
        violations.push({
          code: BOUNDARY_CODES.FEATURE_DEEP_IMPORT,
          file: sourcePath,
          message:
            "Feature modules may import @popeye packages only from package roots and may not escape their own package through relative imports.",
          specifier,
        });
      }

      if (isProtocolSource && importsPopeye) {
        violations.push({
          code: BOUNDARY_CODES.PROTOCOL_POPEYE_IMPORT,
          file: sourcePath,
          message: "Protocol sources may not import @popeye packages.",
          specifier,
        });
      }
    }
  }

  return violations;
}
