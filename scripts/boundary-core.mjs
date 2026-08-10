import { glob, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export const BOUNDARY_CODES = Object.freeze({
  CLI_KERNEL_IMPORT: "CLI_KERNEL_IMPORT",
  FEATURE_KERNEL_INTERNAL_IMPORT: "FEATURE_KERNEL_INTERNAL_IMPORT",
  PI_AI_SEAM_IMPORT: "PI_AI_SEAM_IMPORT",
  PROTOCOL_PEYE_IMPORT: "PROTOCOL_PEYE_IMPORT",
});

/** @typedef {typeof BOUNDARY_CODES[keyof typeof BOUNDARY_CODES]} BoundaryCode */
/** @typedef {{ code: BoundaryCode, file: string, message: string, specifier: string }} BoundaryViolation */

const staticImportPattern =
  /\b(?:export|import)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g;
const dynamicImportPattern = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
const internalPathPattern = /(^|\/)internal(\/|$|\.)/;

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
    const sourcePath = relative(rootDirectory, absoluteSourceFile).split(sep).join("/");
    const isCliSource = sourcePath.startsWith("packages/cli/src/");
    const isCompositionModule = sourcePath === "packages/cli/src/compose.ts";
    const isFeatureSource = sourcePath.split("/").includes("features");
    const isKernelAiSource = sourcePath.startsWith("packages/kernel/src/ai/");
    const isProtocolSource = sourcePath.startsWith("packages/protocol/src/");

    for (const specifier of findImportSpecifiers(source)) {
      const importsKernel = specifier === "@peye/kernel" || specifier.startsWith("@peye/kernel/");
      const importsPiAi =
        specifier === "@earendil-works/pi-ai" || specifier.startsWith("@earendil-works/pi-ai/");
      const importsPeye = specifier.startsWith("@peye/");
      const importsInternalPath =
        internalPathPattern.test(specifier) &&
        (specifier.startsWith("@peye/kernel") || specifier.startsWith("."));

      if (isCliSource && importsKernel && !isCompositionModule) {
        violations.push({
          code: BOUNDARY_CODES.CLI_KERNEL_IMPORT,
          file: sourcePath,
          message: "CLI sources may import @peye/kernel only from packages/cli/src/compose.ts.",
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

      if (isFeatureSource && importsInternalPath) {
        violations.push({
          code: BOUNDARY_CODES.FEATURE_KERNEL_INTERNAL_IMPORT,
          file: sourcePath,
          message: "Feature modules may not import internal module paths.",
          specifier,
        });
      }

      if (isProtocolSource && importsPeye) {
        violations.push({
          code: BOUNDARY_CODES.PROTOCOL_PEYE_IMPORT,
          file: sourcePath,
          message: "Protocol sources may not import @peye packages.",
          specifier,
        });
      }
    }
  }

  return violations;
}
