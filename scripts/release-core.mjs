/**
 * Owns the release gate rules for packed npm tarballs (issue #69).
 * Pure functions only: the CLI in release-packages.mjs reads tarballs and runs commands, and
 * these functions decide whether what it read may be published.
 */

import { builtinModules } from "node:module";

export const RELEASE_CODES = Object.freeze({
  FORBIDDEN_ENTRY: "FORBIDDEN_ENTRY",
  MISSING_ENTRY: "MISSING_ENTRY",
  PACKAGE_SET_MISMATCH: "PACKAGE_SET_MISMATCH",
  SMOKE_HELP: "SMOKE_HELP",
  SMOKE_IMPORT: "SMOKE_IMPORT",
  SMOKE_VERSION: "SMOKE_VERSION",
  SOURCE_REF_MISMATCH: "SOURCE_REF_MISMATCH",
  SOURCE_SHA_MISMATCH: "SOURCE_SHA_MISMATCH",
  TAG_MISMATCH: "TAG_MISMATCH",
  UNDECLARED_DEPENDENCY: "UNDECLARED_DEPENDENCY",
  VERSION_MISMATCH: "VERSION_MISMATCH",
  WORKSPACE_SPECIFIER: "WORKSPACE_SPECIFIER",
});

/** The CLI package: its release tag gates publishing and its bin is smoke-tested. */
export const CLI_PACKAGE_NAME = "@dungle-scrubs/popeye";

/** release-please runs on pushes to this ref; the automatic publish runs here too. */
export const RELEASE_BRANCH_REF = "refs/heads/main";

/** npm trusted publishing (OIDC) needs npm CLI 11.5.1 or later. */
export const MINIMUM_NPM_VERSION = "11.5.1";

/** @typedef {typeof RELEASE_CODES[keyof typeof RELEASE_CODES]} ReleaseCode */
/** @typedef {{ code: ReleaseCode, package: string, detail: string }} ReleaseViolation */
/**
 * @typedef {object} PackedPackage
 * @property {string} file Tarball file name.
 * @property {Record<string, unknown>} manifest The package.json inside the tarball.
 * @property {ReadonlyArray<string>} entries Tarball paths relative to the package root.
 * @property {Readonly<Record<string, string>>} [sources] Packed JavaScript by relative path.
 */
/** @typedef {{ status: number | null, stdout: string, stderr: string }} CommandOutcome */
/**
 * @template TValue
 * @typedef {{ ok: true, value: TValue } | { ok: false, error: Error }} Result
 */

const allowedEntry =
  /^(?:package\.json|README(?:\.[^/]+)?|LICEN[CS]E(?:\.[^/]+)?|CHANGELOG\.md|dist\/.+)$/i;
const testEntry = /\.test\.[cm]?[jt]sx?$/;
const releaseTag = /^popeye-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const runtimeDependencyFields = ["dependencies", "peerDependencies", "optionalDependencies"];

/** @param {PackedPackage} pack */
const nameOf = (pack) => String(pack.manifest.name ?? pack.file);

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {Array<[string, string]>} [dotted path, value] for string leaves starting "workspace:"
 */
function workspacePaths(value, path) {
  if (typeof value === "string") return value.startsWith("workspace:") ? [[path, value]] : [];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    workspacePaths(child, path === "" ? key : `${path}.${key}`),
  );
}

/**
 * @param {unknown} value
 * @returns {Array<string>} relative file targets ("./x") among string leaves
 */
function fileTargets(value) {
  if (typeof value === "string") {
    return value.startsWith("./") && !value.includes("*") ? [value.slice(2)] : [];
  }
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(fileTargets);
}

/**
 * bin, main, and types may omit the leading "./".
 * @param {unknown} value
 * @returns {Array<string>}
 */
function pathTargets(value) {
  if (typeof value === "string") return value === "" ? [] : [value.replace(/^\.\//, "")];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(pathTargets);
}

const builtins = new Set(builtinModules);

/**
 * Read literal module specifiers without treating comments or string examples as code.
 * @param {string} source
 * @returns {Array<string>}
 */
function moduleSpecifiers(source) {
  const lexeme =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(`(?:\\.|[^`\\])*`)|([A-Za-z_$][\w$]*)|([^\s])/g;
  const tokens = [...source.matchAll(lexeme)]
    .filter((match) => match[1] === undefined && match[3] === undefined)
    .map((match) => ({ literal: match[2] !== undefined, value: match[0] }));
  /** @type {Array<string>} */
  const specifiers = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (
      token?.literal ||
      (token?.value !== "import" && token?.value !== "export") ||
      tokens[index - 1]?.value === "."
    )
      continue;
    const next = tokens[index + 1];
    if (token.value === "import" && next?.value === "(") {
      const argument = tokens[index + 2];
      if (argument?.literal && tokens[index + 3]?.value === ")")
        specifiers.push(argument.value.slice(1, -1));
    } else if (token.value === "import" && next?.literal) {
      specifiers.push(next.value.slice(1, -1));
    } else if (
      (token.value === "import" && next?.value !== ".") ||
      (token.value === "export" && (next?.value === "*" || next?.value === "{"))
    ) {
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const current = tokens[cursor];
        if ([";", "import", "export"].includes(current?.value ?? "")) break;
        const specifier = tokens[cursor + 1];
        if (current?.value === "from" && specifier?.literal) {
          specifiers.push(specifier.value.slice(1, -1));
          break;
        }
      }
    }
  }
  return specifiers;
}

/** @param {unknown} value @returns {Array<string>} */
function importTargets(value) {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(importTargets);
}

/**
 * @param {string} alias
 * @param {unknown} imports
 * @returns {Array<string> | undefined}
 */
function resolveImportAlias(alias, imports) {
  if (imports === null || typeof imports !== "object") return undefined;
  const mappings = /** @type {Record<string, unknown>} */ (imports);
  if (Object.hasOwn(mappings, alias)) return importTargets(mappings[alias]);
  const patterns = Object.keys(mappings)
    .filter((key) => key.startsWith("#") && key.includes("*"))
    .sort((left, right) => right.indexOf("*") - left.indexOf("*") || right.length - left.length);
  for (const pattern of patterns) {
    const star = pattern.indexOf("*");
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      alias.startsWith(prefix) &&
      alias.endsWith(suffix) &&
      alias.length >= prefix.length + suffix.length
    ) {
      const match = alias.slice(prefix.length, alias.length - suffix.length);
      return importTargets(mappings[pattern]).map((target) => target.replaceAll("*", match));
    }
  }
  return undefined;
}

/** @param {PackedPackage} pack @returns {Array<ReleaseViolation>} */
function undeclaredDependencies(pack) {
  const declared = new Set([
    nameOf(pack),
    ...Object.keys(/** @type {Record<string, unknown>} */ (pack.manifest.dependencies ?? {})),
    ...Object.keys(/** @type {Record<string, unknown>} */ (pack.manifest.peerDependencies ?? {})),
  ]);
  /** @type {Array<ReleaseViolation>} */
  const violations = [];
  for (const [file, source] of Object.entries(pack.sources ?? {})) {
    if (!file.startsWith("dist/") || !file.endsWith(".js")) continue;
    for (const specifier of moduleSpecifiers(source)) {
      if (specifier.startsWith(".") || specifier.startsWith("node:") || builtins.has(specifier))
        continue;
      const targets = specifier.startsWith("#")
        ? resolveImportAlias(specifier, pack.manifest.imports)
        : [specifier];
      if (targets === undefined) {
        violations.push({
          code: RELEASE_CODES.UNDECLARED_DEPENDENCY,
          detail: `${file} imports ${specifier}, which is an unmapped alias`,
          package: nameOf(pack),
        });
        continue;
      }
      for (const target of targets) {
        if (target.startsWith("./") || target.startsWith("node:") || builtins.has(target)) continue;
        const parts = target.split("/");
        const dependency = target.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
        if (!declared.has(dependency ?? "")) {
          violations.push({
            code: RELEASE_CODES.UNDECLARED_DEPENDENCY,
            detail: `${file} imports ${specifier}${specifier === target ? "" : ` targeting ${target}`}, which is not declared in dependencies or peerDependencies`,
            package: nameOf(pack),
          });
        }
      }
    }
  }
  return violations;
}

/**
 * Check a set of packed tarballs before upload.
 * Violations come per pack in input order (workspace specifiers, forbidden entries, missing
 * entries, undeclared dependencies, version mismatch, tag mismatch), then package-set violations.
 * @param {ReadonlyArray<PackedPackage>} packs
 * @param {{ expectedNames: ReadonlyArray<string>, expectedVersion?: string }} options
 * @returns {Array<ReleaseViolation>}
 */
export function checkPackedPackages(packs, options) {
  /** @type {Array<ReleaseViolation>} */
  const violations = [];
  const referenceVersion = packs[0]?.manifest.version;
  for (const pack of packs) {
    const name = nameOf(pack);
    for (const [path, specifier] of workspacePaths(pack.manifest, "")) {
      violations.push({
        code: RELEASE_CODES.WORKSPACE_SPECIFIER,
        detail: `${path} is ${specifier}`,
        package: name,
      });
    }
    for (const entry of pack.entries) {
      if (!allowedEntry.test(entry) || testEntry.test(entry)) {
        violations.push({
          code: RELEASE_CODES.FORBIDDEN_ENTRY,
          detail: `${entry} must not ship`,
          package: name,
        });
      }
    }
    const entries = new Set(pack.entries);
    const targets = [
      ...pathTargets(pack.manifest.bin),
      ...pathTargets(pack.manifest.main),
      ...pathTargets(pack.manifest.types),
      ...fileTargets(pack.manifest.exports),
    ];
    for (const target of new Set(targets)) {
      if (!entries.has(target)) {
        violations.push({
          code: RELEASE_CODES.MISSING_ENTRY,
          detail: `${target} is referenced by package.json but not in the tarball`,
          package: name,
        });
      }
    }
    violations.push(...undeclaredDependencies(pack));
    if (pack.manifest.version !== referenceVersion) {
      violations.push({
        code: RELEASE_CODES.VERSION_MISMATCH,
        detail: `version ${String(pack.manifest.version)} differs from ${String(referenceVersion)}`,
        package: name,
      });
    }
    if (
      options.expectedVersion !== undefined &&
      pack.manifest.version !== options.expectedVersion
    ) {
      violations.push({
        code: RELEASE_CODES.TAG_MISMATCH,
        detail: `version ${String(pack.manifest.version)} differs from release tag version ${options.expectedVersion}`,
        package: name,
      });
    }
  }
  const seen = new Set();
  for (const pack of packs) {
    const name = nameOf(pack);
    if (pack.manifest.private === true) {
      violations.push({
        code: RELEASE_CODES.PACKAGE_SET_MISMATCH,
        detail: "private package was packed",
        package: name,
      });
    } else if (!options.expectedNames.includes(name)) {
      violations.push({
        code: RELEASE_CODES.PACKAGE_SET_MISMATCH,
        detail: "not a public workspace package",
        package: name,
      });
    } else if (seen.has(name)) {
      violations.push({
        code: RELEASE_CODES.PACKAGE_SET_MISMATCH,
        detail: "packed more than once",
        package: name,
      });
    }
    seen.add(name);
  }
  for (const name of options.expectedNames) {
    if (!seen.has(name)) {
      violations.push({
        code: RELEASE_CODES.PACKAGE_SET_MISMATCH,
        detail: "no tarball for this package",
        package: name,
      });
    }
  }
  return violations;
}

/**
 * @param {string} tag
 * @returns {string | undefined} the version in a "popeye-v<version>" tag
 */
export function parseReleaseTag(tag) {
  return releaseTag.exec(tag)?.[1];
}

/**
 * Check that the publish job builds the commit its run attests.
 * npm provenance records the workflow event's ref and SHA (GITHUB_REF, GITHUB_SHA), not what
 * actions/checkout fetched, so the checked-out commit must equal the event SHA. The event ref must
 * be the release branch (the automatic run) or the release tag itself (a recovery dispatch).
 * @param {{ tag: string, eventRef: string, eventSha: string, headSha: string }} source
 * @returns {Array<ReleaseViolation>}
 */
export function checkReleaseSource(source) {
  /** @type {Array<ReleaseViolation>} */
  const violations = [];
  const tagRef = `refs/tags/${source.tag}`;
  if (source.eventRef !== RELEASE_BRANCH_REF && source.eventRef !== tagRef) {
    violations.push({
      code: RELEASE_CODES.SOURCE_REF_MISMATCH,
      detail: `the run was triggered on ${source.eventRef}; dispatch the Release workflow on ${tagRef} instead`,
      package: CLI_PACKAGE_NAME,
    });
  }
  if (source.headSha.trim() !== source.eventSha.trim()) {
    violations.push({
      code: RELEASE_CODES.SOURCE_SHA_MISMATCH,
      detail: `checked-out commit ${source.headSha.trim()} is not the run's commit ${source.eventSha.trim()}; dispatch the Release workflow on ${tagRef} to publish it`,
      package: CLI_PACKAGE_NAME,
    });
  }
  return violations;
}

/**
 * Order packs so each package is uploaded after the packed packages it depends on at runtime,
 * then drop the ones whose version the registry already has.
 * @param {ReadonlyArray<PackedPackage>} packs
 * @param {ReadonlyMap<string, ReadonlyArray<string>>} publishedVersions registry versions by name
 * @returns {Result<{ publish: Array<PackedPackage>, skip: Array<PackedPackage> }>}
 */
export function planPublish(packs, publishedVersions) {
  const byName = new Map(packs.map((pack) => [nameOf(pack), pack]));
  /** @type {Map<string, Set<string>>} */
  const pending = new Map();
  for (const [name, pack] of byName) {
    const dependencies = runtimeDependencyFields.flatMap((field) =>
      Object.keys(/** @type {Record<string, unknown>} */ (pack.manifest[field] ?? {})),
    );
    pending.set(
      name,
      new Set(dependencies.filter((dependency) => byName.has(dependency) && dependency !== name)),
    );
  }
  /** @type {Array<PackedPackage>} */
  const ordered = [];
  while (pending.size > 0) {
    const ready = [...pending]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([name]) => name)
      .sort();
    const next = ready[0];
    if (next === undefined) {
      return {
        error: new Error(`dependency cycle between ${[...pending.keys()].join(", ")}`),
        ok: false,
      };
    }
    pending.delete(next);
    for (const dependencies of pending.values()) dependencies.delete(next);
    const pack = byName.get(next);
    if (pack !== undefined) ordered.push(pack);
  }
  const isPublished = (/** @type {PackedPackage} */ pack) =>
    (publishedVersions.get(nameOf(pack)) ?? []).includes(String(pack.manifest.version));
  return {
    ok: true,
    value: {
      publish: ordered.filter((pack) => !isPublished(pack)),
      skip: ordered.filter(isPublished),
    },
  };
}

/**
 * @param {string} actual
 * @param {string} minimum
 */
export function meetsMinimumVersion(actual, minimum) {
  const parse = (/** @type {string} */ value) =>
    /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim())?.slice(1).map(Number);
  const left = parse(actual);
  const right = parse(minimum);
  if (left === undefined || right === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

/**
 * @param {{ expectedVersion: string, version: CommandOutcome, help: CommandOutcome, imports: ReadonlyArray<CommandOutcome & { name: string }> }} results
 * @returns {Array<ReleaseViolation>}
 */
export function checkSmokeResults(results) {
  /** @type {Array<ReleaseViolation>} */
  const violations = [];
  if (results.version.status !== 0 || results.version.stdout.trim() !== results.expectedVersion) {
    violations.push({
      code: RELEASE_CODES.SMOKE_VERSION,
      detail: `popeye --version exited ${String(results.version.status)} and printed ${JSON.stringify(results.version.stdout.trim())}; expected ${results.expectedVersion}`,
      package: CLI_PACKAGE_NAME,
    });
  }
  if (results.help.status !== 0 || !results.help.stdout.startsWith("Usage:")) {
    violations.push({
      code: RELEASE_CODES.SMOKE_HELP,
      detail: `popeye --help exited ${String(results.help.status)}; stdout must start with "Usage:"`,
      package: CLI_PACKAGE_NAME,
    });
  }
  for (const outcome of results.imports) {
    if (outcome.status !== 0) {
      violations.push({
        code: RELEASE_CODES.SMOKE_IMPORT,
        detail: `import failed: ${outcome.stderr.trim().split("\n")[0] ?? ""}`,
        package: outcome.name,
      });
    }
  }
  return violations;
}
