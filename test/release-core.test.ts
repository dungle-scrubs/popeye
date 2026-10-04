/**
 * Issue #69: unit tests for the release gate logic in scripts/release-core.mjs.
 * The gate runs before any upload, so each rule here maps to one way a published package broke
 * or could break: workspace: specifiers, source and tests in the tarball, missing entry files,
 * lockstep drift, a tag that does not match the packed version, a broken installed CLI, and a
 * build whose commit differs from the one npm provenance attests.
 */
import { describe, expect, test } from "vitest";

import {
  checkPackedPackages,
  checkReleaseSource,
  checkSmokeResults,
  meetsMinimumVersion,
  parseReleaseTag,
  planPublish,
  RELEASE_CODES,
} from "../scripts/release-core.mjs";

interface Pack {
  readonly entries: ReadonlyArray<string>;
  readonly file: string;
  readonly manifest: Record<string, unknown>;
  readonly sources?: Readonly<Record<string, string>>;
}

const version = "0.1.5";

const journal = (): Pack => ({
  entries: ["package.json", "LICENSE", "dist/index.js", "dist/index.d.ts"],
  file: "dungle-scrubs-popeye-journal-0.1.5.tgz",
  manifest: {
    exports: { ".": { default: "./dist/index.js", types: "./dist/index.d.ts" } },
    name: "@dungle-scrubs/popeye-journal",
    version,
  },
});

const protocol = (): Pack => ({
  entries: ["package.json", "dist/index.js", "dist/index.d.ts"],
  file: "dungle-scrubs-popeye-protocol-0.1.5.tgz",
  manifest: {
    dependencies: { "@dungle-scrubs/popeye-journal": version },
    exports: { ".": { default: "./dist/index.js", types: "./dist/index.d.ts" } },
    imports: { "#journal": "@dungle-scrubs/popeye-journal" },
    name: "@dungle-scrubs/popeye-protocol",
    version,
  },
});

const kernel = (): Pack => ({
  entries: ["package.json", "dist/index.js", "dist/index.d.ts"],
  file: "dungle-scrubs-popeye-kernel-0.1.5.tgz",
  manifest: {
    dependencies: {
      "@dungle-scrubs/popeye-journal": version,
      "@dungle-scrubs/popeye-protocol": version,
      "@earendil-works/pi-ai": "0.84.1",
    },
    exports: { ".": { default: "./dist/index.js", types: "./dist/index.d.ts" } },
    name: "@dungle-scrubs/popeye-kernel",
    version,
  },
});

const plugins = (): Pack => ({
  entries: ["package.json", "dist/index.js", "dist/index.d.ts"],
  file: "dungle-scrubs-popeye-plugins-0.1.5.tgz",
  manifest: {
    dependencies: {
      "@dungle-scrubs/popeye-journal": version,
      "@dungle-scrubs/popeye-protocol": version,
    },
    devDependencies: { "@dungle-scrubs/popeye-kernel": version },
    exports: { ".": { default: "./dist/index.js", types: "./dist/index.d.ts" } },
    name: "@dungle-scrubs/popeye-plugins",
    version,
  },
});

const cli = (): Pack => ({
  entries: ["package.json", "dist/index.js", "dist/index.d.ts", "dist/bin/popeye.js"],
  file: "dungle-scrubs-popeye-0.1.5.tgz",
  manifest: {
    bin: { popeye: "./dist/bin/popeye.js" },
    dependencies: {
      "@dungle-scrubs/popeye-journal": version,
      "@dungle-scrubs/popeye-kernel": version,
      "@dungle-scrubs/popeye-plugins": version,
      "@dungle-scrubs/popeye-protocol": version,
      yaml: "2.9.1",
    },
    exports: { ".": { default: "./dist/index.js", types: "./dist/index.d.ts" } },
    name: "@dungle-scrubs/popeye",
    version,
  },
});

const allPacks = (): Array<Pack> => [cli(), journal(), kernel(), plugins(), protocol()];
const expectedNames = allPacks().map((pack) => String(pack.manifest.name));

const codesFor = (packs: ReadonlyArray<Pack>, expectedVersion?: string) =>
  checkPackedPackages(packs, {
    expectedNames,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  }).map((violation) => `${violation.code} ${violation.package}`);

describe("checkPackedPackages", () => {
  test("a clean lockstep set of five tarballs passes", () => {
    expect(checkPackedPackages(allPacks(), { expectedNames, expectedVersion: version })).toEqual(
      [],
    );
  });

  test("a workspace: specifier in any manifest field fails, naming the field", () => {
    const packs = allPacks();
    const broken = cli();
    broken.manifest.dependencies = {
      ...(broken.manifest.dependencies as Record<string, string>),
      "@dungle-scrubs/popeye-journal": "workspace:*",
    };
    const brokenPeer = plugins();
    brokenPeer.manifest.devDependencies = { "@dungle-scrubs/popeye-kernel": "workspace:^" };
    packs[0] = broken;
    packs[3] = brokenPeer;

    const violations = checkPackedPackages(packs, { expectedNames });

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: RELEASE_CODES.WORKSPACE_SPECIFIER,
          package: "@dungle-scrubs/popeye",
        }),
        expect.objectContaining({
          code: RELEASE_CODES.WORKSPACE_SPECIFIER,
          package: "@dungle-scrubs/popeye-plugins",
        }),
      ]),
    );
    const cliViolation = violations.find(
      (violation) => violation.package === "@dungle-scrubs/popeye",
    );
    expect(cliViolation?.detail).toContain("dependencies.@dungle-scrubs/popeye-journal");
  });

  test("source files, tests, and build config in the tarball fail", () => {
    const packs = allPacks();
    packs[0] = {
      ...cli(),
      entries: [
        ...cli().entries,
        "src/index.ts",
        "dist/entry/args.test.js",
        "tsconfig.json",
        "test-fixtures/heads.golden.txt",
      ],
    };

    const violations = checkPackedPackages(packs, { expectedNames });

    expect(violations.map((violation) => violation.code)).toEqual(
      Array(4).fill(RELEASE_CODES.FORBIDDEN_ENTRY),
    );
    expect(violations.map((violation) => violation.detail).join("\n")).toContain("src/index.ts");
  });

  test("README, LICENSE, CHANGELOG.md, and dist files are allowed", () => {
    const packs = allPacks();
    packs[1] = {
      ...journal(),
      entries: [...journal().entries, "README.md", "CHANGELOG.md", "dist/.tsbuildinfo"],
    };

    expect(checkPackedPackages(packs, { expectedNames })).toEqual([]);
  });

  test("a bin or exports target missing from the tarball fails", () => {
    const packs = allPacks();
    packs[0] = { ...cli(), entries: ["package.json", "dist/index.js", "dist/index.d.ts"] };
    packs[2] = { ...kernel(), entries: ["package.json", "dist/index.js"] };

    const violations = checkPackedPackages(packs, { expectedNames });

    expect(violations).toEqual([
      expect.objectContaining({
        code: RELEASE_CODES.MISSING_ENTRY,
        package: "@dungle-scrubs/popeye",
      }),
      expect.objectContaining({
        code: RELEASE_CODES.MISSING_ENTRY,
        package: "@dungle-scrubs/popeye-kernel",
      }),
    ]);
    expect(violations[0]?.detail).toContain("dist/bin/popeye.js");
    expect(violations[1]?.detail).toContain("dist/index.d.ts");
  });

  test("an import map entry that names a package is not a file target", () => {
    expect(
      checkPackedPackages([protocol()], { expectedNames: [String(protocol().manifest.name)] }),
    ).toEqual([]);
  });

  test("versions that differ break lockstep", () => {
    const packs = allPacks();
    packs[4] = { ...protocol(), manifest: { ...protocol().manifest, version: "0.1.4" } };

    expect(codesFor(packs)).toEqual([
      `${RELEASE_CODES.VERSION_MISMATCH} @dungle-scrubs/popeye-protocol`,
    ]);
  });

  test("a packed version that differs from the release tag fails every package", () => {
    expect(codesFor(allPacks(), "0.1.6")).toEqual(
      expectedNames.map((name) => `${RELEASE_CODES.TAG_MISMATCH} ${name}`),
    );
  });

  test("a missing, extra, duplicate, or private package fails the package set", () => {
    const missing = allPacks().slice(1);
    expect(codesFor(missing)).toEqual([
      `${RELEASE_CODES.PACKAGE_SET_MISMATCH} @dungle-scrubs/popeye`,
    ]);

    const extra = [
      ...allPacks(),
      { ...journal(), file: "popeye-0.1.5.tgz", manifest: { name: "popeye", version } },
    ];
    expect(codesFor(extra)).toEqual([`${RELEASE_CODES.PACKAGE_SET_MISMATCH} popeye`]);

    const duplicate = [...allPacks(), journal()];
    expect(codesFor(duplicate)).toEqual([
      `${RELEASE_CODES.PACKAGE_SET_MISMATCH} @dungle-scrubs/popeye-journal`,
    ]);

    const privatePack = allPacks();
    privatePack[1] = { ...journal(), manifest: { ...journal().manifest, private: true } };
    expect(codesFor(privatePack)).toEqual([
      `${RELEASE_CODES.PACKAGE_SET_MISMATCH} @dungle-scrubs/popeye-journal`,
    ]);
  });
});

describe("packed JavaScript dependency declarations", () => {
  test.each([
    ['import { Kernel } from "@dungle-scrubs/popeye-kernel";', "@dungle-scrubs/popeye-kernel"],
    ['import "yaml";', "yaml"],
    ['export { Schema } from "effect/Schema";', "effect/Schema"],
    ['const module = await import("missing-package/subpath");', "missing-package/subpath"],
  ])("flags an undeclared specifier in %s", (source, specifier) => {
    const pack = { ...journal(), sources: { "dist/index.js": source } };
    const violations = checkPackedPackages([pack], {
      expectedNames: [String(pack.manifest.name)],
    });

    expect(violations).toEqual([
      {
        code: "UNDECLARED_DEPENDENCY",
        detail: expect.stringContaining(specifier),
        package: "@dungle-scrubs/popeye-journal",
      },
    ]);
    expect(violations[0]?.detail).toContain("dist/index.js");
  });

  test("ignores relative, node:, builtin, self, dependency, and peer imports", () => {
    const pack: Pack = {
      ...journal(),
      manifest: {
        ...journal().manifest,
        dependencies: { effect: "3.0.0", "@scope/dependency": "1.0.0" },
        peerDependencies: { "@scope/peer": "1.0.0" },
      },
      sources: {
        "dist/index.js": `
          import "./local.js";
          export * from "../parent.js";
          import fs from "node:fs";
          import path from "path";
          import "fs/promises";
          import "@dungle-scrubs/popeye-journal/subpath";
          export * from "effect/Schema";
          import "@scope/dependency/subpath";
          await import("@scope/peer/subpath");
        `,
      },
    };

    expect(checkPackedPackages([pack], { expectedNames: [String(pack.manifest.name)] })).toEqual(
      [],
    );
  });

  test("development and optional dependencies do not satisfy the gate", () => {
    const pack: Pack = {
      ...journal(),
      manifest: {
        ...journal().manifest,
        devDependencies: { "dev-only": "1.0.0" },
        optionalDependencies: { "optional-only": "1.0.0" },
      },
      sources: { "dist/index.js": 'import "dev-only"; import "optional-only";' },
    };

    expect(
      checkPackedPackages([pack], { expectedNames: [String(pack.manifest.name)] }).map(
        (violation) => violation.code,
      ),
    ).toEqual(["UNDECLARED_DEPENDENCY", "UNDECLARED_DEPENDENCY"]);
  });

  test("ignores comment and string examples, computed imports, and non-dist JavaScript", () => {
    const pack = {
      ...journal(),
      sources: {
        "dist/index.js": `
          // import "comment-only";
          /* export * from "comment-only"; */
          const example = 'import "string-only";';
          const template = \`import "template-only";\`;
          import(variable);
          import("computed-" + variable);
        `,
        "src/index.js": 'import "source-only";',
        "dist/index.d.ts": 'import "types-only";',
      },
    };

    expect(checkPackedPackages([pack], { expectedNames: [String(pack.manifest.name)] })).toEqual(
      [],
    );
  });
});

describe("packed package-import aliases", () => {
  const check = (imports: Record<string, unknown>, alias = "#journal") => {
    const pack: Pack = {
      ...protocol(),
      manifest: { ...protocol().manifest, imports },
      sources: { "dist/index.js": `import ${JSON.stringify(alias)};` },
    };
    return checkPackedPackages([pack], { expectedNames: [String(pack.manifest.name)] });
  };

  test("a mapped alias to a declared sibling passes", () => {
    expect(check({ "#journal": "@dungle-scrubs/popeye-journal" })).toEqual([]);
  });

  test("a mapped alias to an undeclared package names the alias and target", () => {
    const violations = check({ "#journal": "effect/Schema" });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.code).toBe("UNDECLARED_DEPENDENCY");
    expect(violations[0]?.detail).toContain("#journal");
    expect(violations[0]?.detail).toContain("effect/Schema");
  });

  test("an internal ./ target is ignored", () => {
    expect(check({ "#journal": "./dist/journal.js" })).toEqual([]);
  });

  test("every target in nested conditions is checked", () => {
    expect(
      check({
        "#journal": {
          node: { import: "@dungle-scrubs/popeye-journal", default: "./dist/journal.js" },
          default: "@dungle-scrubs/popeye-protocol/subpath",
        },
      }),
    ).toEqual([]);
    const violations = check({
      "#journal": {
        node: "@dungle-scrubs/popeye-journal",
        default: { import: "missing-package/subpath", default: "other-missing" },
      },
    });

    expect(violations.map((violation) => violation.code)).toEqual([
      "UNDECLARED_DEPENDENCY",
      "UNDECLARED_DEPENDENCY",
    ]);
    expect(violations[0]?.detail).toContain("missing-package/subpath");
    expect(violations[1]?.detail).toContain("other-missing");
  });

  test("a pattern key substitutes the matching subpath into every target", () => {
    expect(check({ "#journal/*": "@dungle-scrubs/popeye-journal/*" }, "#journal/events")).toEqual(
      [],
    );
    const violations = check({ "#journal/*": { default: "effect/*" } }, "#journal/Schema");

    expect(violations[0]?.code).toBe("UNDECLARED_DEPENDENCY");
    expect(violations[0]?.detail).toContain("#journal/Schema");
    expect(violations[0]?.detail).toContain("effect/Schema");
  });

  test("an unmapped alias fails", () => {
    const violations = check({ "#other": "./dist/other.js" });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.code).toBe("UNDECLARED_DEPENDENCY");
    expect(violations[0]?.detail).toContain("#journal");
    expect(violations[0]?.detail).toContain("unmapped");
  });
});

describe("parseReleaseTag", () => {
  test("reads the version from the CLI release tag", () => {
    expect(parseReleaseTag("popeye-v0.1.5")).toBe("0.1.5");
    expect(parseReleaseTag("popeye-v1.0.0-rc.1")).toBe("1.0.0-rc.1");
  });

  test("refuses tags of other components, bare versions, and branch names", () => {
    for (const tag of ["v0.1.4", "popeye-journal-v0.1.5", "popeye-workspace-v0.1.5", "main", ""]) {
      expect(parseReleaseTag(tag), tag).toBeUndefined();
    }
  });
});

describe("planPublish", () => {
  test("publishes unpublished packages with dependencies first and skips published ones", () => {
    const published = new Map<string, ReadonlyArray<string>>([
      ["@dungle-scrubs/popeye-journal", ["0.1.1", "0.1.2", version]],
      ["@dungle-scrubs/popeye-protocol", ["0.1.1"]],
    ]);

    const result = planPublish(allPacks(), published);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.publish.map((pack) => pack.manifest.name)).toEqual([
      "@dungle-scrubs/popeye-protocol",
      "@dungle-scrubs/popeye-kernel",
      "@dungle-scrubs/popeye-plugins",
      "@dungle-scrubs/popeye",
    ]);
    expect(result.value.skip.map((pack) => pack.manifest.name)).toEqual([
      "@dungle-scrubs/popeye-journal",
    ]);
  });

  test("a fresh registry gets all five in dependency order", () => {
    const result = planPublish(allPacks(), new Map());

    expect(result.ok && result.value.publish.map((pack) => pack.manifest.name)).toEqual([
      "@dungle-scrubs/popeye-journal",
      "@dungle-scrubs/popeye-protocol",
      "@dungle-scrubs/popeye-kernel",
      "@dungle-scrubs/popeye-plugins",
      "@dungle-scrubs/popeye",
    ]);
  });

  test("a dependency cycle between packed packages is an error, not a guess", () => {
    const cyclicJournal = {
      ...journal(),
      manifest: {
        ...journal().manifest,
        dependencies: { "@dungle-scrubs/popeye-protocol": version },
      },
    };

    const result = planPublish([cyclicJournal, protocol()], new Map());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("cycle");
  });
});

describe("meetsMinimumVersion", () => {
  test("compares numeric versions for the npm OIDC floor", () => {
    expect(meetsMinimumVersion("11.12.1", "11.5.1")).toBe(true);
    expect(meetsMinimumVersion("11.5.1", "11.5.1")).toBe(true);
    expect(meetsMinimumVersion("12.0.0", "11.5.1")).toBe(true);
    expect(meetsMinimumVersion("11.5.0", "11.5.1")).toBe(false);
    expect(meetsMinimumVersion("10.9.2", "11.5.1")).toBe(false);
    expect(meetsMinimumVersion("not-a-version", "11.5.1")).toBe(false);
  });
});

describe("checkSmokeResults", () => {
  const ok = { status: 0, stderr: "", stdout: "" };

  test("a working install passes", () => {
    expect(
      checkSmokeResults({
        expectedVersion: version,
        help: { ...ok, stdout: 'Usage:\n  popeye -p "<prompt>"\n' },
        imports: [{ ...ok, name: "@dungle-scrubs/popeye-kernel" }],
        version: { ...ok, stdout: `${version}\n` },
      }),
    ).toEqual([]);
  });

  test("a wrong version, failed help, or failed import each fail", () => {
    const violations = checkSmokeResults({
      expectedVersion: version,
      help: { status: 1, stderr: "boom", stdout: "" },
      imports: [
        {
          name: "@dungle-scrubs/popeye-kernel",
          status: 1,
          stderr: "ERR_MODULE_NOT_FOUND",
          stdout: "",
        },
      ],
      version: { ...ok, stdout: "0.1.4\n" },
    });

    expect(violations.map((violation) => violation.code)).toEqual([
      RELEASE_CODES.SMOKE_VERSION,
      RELEASE_CODES.SMOKE_HELP,
      RELEASE_CODES.SMOKE_IMPORT,
    ]);
    expect(violations[2]?.package).toBe("@dungle-scrubs/popeye-kernel");
  });

  test("help output that is not the usage text fails", () => {
    const violations = checkSmokeResults({
      expectedVersion: version,
      help: { ...ok, stdout: "popeye: unknown option\n" },
      imports: [],
      version: { ...ok, stdout: version },
    });

    expect(violations.map((violation) => violation.code)).toEqual([RELEASE_CODES.SMOKE_HELP]);
  });
});

describe("checkReleaseSource", () => {
  const tag = "popeye-v0.1.5";
  const sha = "a".repeat(40);

  test("the automatic run on main and a dispatch on the release tag pass at the event commit", () => {
    expect(
      checkReleaseSource({ eventRef: "refs/heads/main", eventSha: sha, headSha: sha, tag }),
    ).toEqual([]);
    expect(
      checkReleaseSource({ eventRef: `refs/tags/${tag}`, eventSha: sha, headSha: `${sha}\n`, tag }),
    ).toEqual([]);
  });

  test("a dispatch on a branch, or on another tag, fails the ref rule", () => {
    for (const eventRef of ["refs/heads/feature", "refs/tags/popeye-v0.1.4", `refs/heads/${tag}`]) {
      const violations = checkReleaseSource({ eventRef, eventSha: sha, headSha: sha, tag });

      expect(violations.map((violation) => violation.code)).toEqual([
        RELEASE_CODES.SOURCE_REF_MISMATCH,
      ]);
      expect(violations[0]?.detail).toContain(`refs/tags/${tag}`);
    }
  });

  test("a checkout that is not the event commit fails, even on main", () => {
    const violations = checkReleaseSource({
      eventRef: "refs/heads/main",
      eventSha: "b".repeat(40),
      headSha: sha,
      tag,
    });

    expect(violations.map((violation) => violation.code)).toEqual([
      RELEASE_CODES.SOURCE_SHA_MISMATCH,
    ]);
    expect(violations[0]?.detail).toContain(`refs/tags/${tag}`);
  });
});
