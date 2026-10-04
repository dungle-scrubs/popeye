import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

// Issue #68: README and guide claims must match their source of truth in this repository.
// Each test reads the claim and the source it depends on, so a later drift on either side fails.

const read = (path: string): string => readFileSync(resolve(path), "utf8");

// Collapse line wrapping so a phrase check does not depend on where Markdown wraps.
const flat = (text: string): string => text.replace(/\s+/g, " ");

const section = (text: string, heading: string): string => {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  expect(start, `missing heading ${heading}`).toBeGreaterThanOrEqual(0);
  const level = heading.split(" ")[0] ?? "##";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const marker = line.split(" ")[0] ?? "";
    return /^#+$/.test(marker) && marker.length <= level.length;
  });
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
};

const deferredItems = (readme: string): ReadonlyArray<string> => {
  const lines = section(readme, "## v1 scope").split("\n");
  const start = lines.indexOf("The following work is deferred:");
  expect(start, "missing deferred-work list").toBeGreaterThanOrEqual(0);
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("- ")) items.push(line);
    else if (items.length > 0) break;
  }
  return items;
};

interface PackageManifest {
  readonly license?: string;
  readonly name: string;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly private?: boolean;
  readonly version: string;
}

const packageDirectories = readdirSync(resolve("packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `packages/${entry.name}`);

const manifests: ReadonlyArray<PackageManifest> = packageDirectories.map(
  (directory) => JSON.parse(read(`${directory}/package.json`)) as PackageManifest,
);

const readme = read("README.md");

describe("README license", () => {
  test("names the MIT License that LICENSE and every package manifest declare", () => {
    expect(read("LICENSE").split("\n")[0]).toBe("MIT License");
    for (const manifest of manifests) {
      expect(manifest.license, manifest.name).toBe("MIT");
    }
    const license = flat(section(readme, "## License"));
    expect(license).toContain("[MIT License](LICENSE)");
    expect(license).not.toContain("does not contain a license file");
    expect(license).not.toContain("No license grant");
  });
});

describe("README package names and release posture", () => {
  test("names every package by its package.json name and never by an old @popeye/ name", () => {
    expect(manifests.length).toBe(5);
    const architecture = section(readme, "## Architecture at a glance");
    for (const manifest of manifests) {
      expect(manifest.name.startsWith("@dungle-scrubs/popeye"), manifest.name).toBe(true);
      expect(architecture, manifest.name).toContain(`| \`${manifest.name}\` |`);
    }
    expect(readme).not.toContain("@popeye/");
  });

  test("the guides and contributor files use the published package names", () => {
    for (const path of [
      "AGENTS.md",
      "CONTRIBUTING.md",
      "docs/conformance-suites.md",
      "docs/plugin-authoring.md",
      "docs/testing-with-fixtures.md",
    ]) {
      expect(read(path), path).not.toContain("@popeye/");
    }
  });

  test("the Install section claims no private packages and names only pnpm's and released versions", () => {
    for (const manifest of manifests) {
      expect(manifest.private, manifest.name).not.toBe(true);
    }
    const install = flat(section(readme, "## Install"));
    expect(install).not.toContain("remain private");
    expect(install).not.toContain("No npm release exists yet");
    expect(install).toContain("`popeye --version`");

    // The single version that Install points to: every package and the release manifest agree.
    const releaseManifest = JSON.parse(read(".release-please-manifest.json")) as Readonly<
      Record<string, string>
    >;
    for (const [index, manifest] of manifests.entries()) {
      expect(manifest.version, manifest.name).toBe(manifests[0]?.version);
      expect(releaseManifest[packageDirectories[index] ?? ""], manifest.name).toBe(
        manifest.version,
      );
    }

    // Install points at npm. The uninstallable versions are named by their `workspace:*` cause,
    // not by package; the Journal package never carried such a range, so it must not be named.
    expect(install).toContain("npm install -g @dungle-scrubs/popeye");
    expect(install).toContain("`workspace:*`");
    expect(install).not.toContain("`@dungle-scrubs/popeye-journal`");
    expect(install).not.toContain("Install from this repository until a fixed release ships.");
    expect(install).toContain("they are deprecated on npm");

    // The first installable release must exist in the CLI package's CHANGELOG, so the claim stays
    // true after later version bumps.
    const releasedVersions = [
      ...read("packages/cli/CHANGELOG.md").matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm),
    ].map((match) => match[1]);
    const firstInstallable = /Versions before (\d+\.\d+\.\d+) do not install/.exec(install);
    expect(
      firstInstallable,
      "Install lacks the 'Versions before <version> do not install' claim",
    ).not.toBeNull();
    expect(releasedVersions).toContain(firstInstallable?.[1]);

    // Every other version literal in Install is the pinned pnpm version.
    const rootManifest = JSON.parse(read("package.json")) as { readonly packageManager: string };
    const pnpmVersion = rootManifest.packageManager.replace(/^pnpm@/, "");
    const versions = install.match(/\b\d+\.\d+\.\d+\b/g) ?? [];
    expect(versions).toContain(pnpmVersion);
    for (const version of versions) {
      expect(
        version === pnpmVersion || version === firstInstallable?.[1],
        `Install names ${version}, which is neither the pinned pnpm version nor the first installable release`,
      ).toBe(true);
    }
  });
});

describe("README Journal Layers", () => {
  test("documents the selectable SQLite Journal Layer that journal-store.ts implements", () => {
    const store = read("packages/journal/src/journal-store.ts");
    expect(store).toContain('explicit === "sqlite"');
    expect(store).toContain("journal.sqlite");

    for (const item of deferredItems(readme)) {
      expect(item).not.toMatch(/sqlite/i);
    }
    const scope = flat(section(readme, "## v1 scope"));
    expect(scope).toContain("memory, JSONL, and SQLite Journal Layers");
    expect(scope).toContain("`POPEYE_JOURNAL_LAYER=sqlite`");
    expect(scope).toContain("`journal.sqlite`");
    expect(scope).toContain("`migrateJsonlToSqlite`");
  });
});

describe("README usage accounting", () => {
  test("classifies loopback endpoints as local, as config.ts does", () => {
    expect(read("packages/cli/src/entry/config.ts")).toContain(
      'isLoopbackHost(endpoint.hostname) ? "local" : "unknown"',
    );
    const text = flat(readme);
    expect(text).toContain('`providerClass: "local"`');
    expect(text).not.toContain("including loopback relays");
  });
});

describe("README deferred work", () => {
  test("lists only work that is still deferred", () => {
    const items = deferredItems(readme).join("\n");
    expect(items).not.toMatch(/pagination/i);
    expect(items).not.toContain("Plugin initiation");
    expect(items).toContain("Kernel initiation of select, confirm, and input requests");

    const scope = flat(section(readme, "## v1 scope"));
    expect(scope).not.toContain("Heads remain non-interactive");
    expect(scope).not.toContain("do not mean the deferred Kernel paths exist");
    expect(scope).toContain("`POPEYE_SNAPSHOT_PAGE_BYTES`");
    expect(scope).toContain("`PluginInteractions`");
  });

  test("states the Snapshot page target with its exceptions, as pagination.ts implements it", () => {
    const pagination = read("packages/protocol/src/pagination.ts");
    expect(pagination).toContain("export const DEFAULT_PAGE_BYTES = 1_048_576;");
    expect(pagination).toContain("if (window.length === 1) {");

    const scope = flat(section(readme, "## v1 scope"));
    expect(scope).not.toMatch(/bounded to 1 MiB/i);
    expect(scope).toContain("1,048,576 bytes by default");
    expect(scope).toContain("A single Entry larger than the page target arrives whole");
    expect(scope).toContain("A range read is not paged");
  });

  test("states when a Plugin interaction reaches an RPC client and when it resolves to fallback", () => {
    const entry = read("packages/cli/src/entry/cli-entry.ts");
    expect(entry).toContain("Effect.provide(PluginInteractionsNullLive)");
    expect(entry).toContain("PluginInteractionsRpcLive.pipe(Layer.provide(RpcInteractionsLive))");

    const scope = flat(section(readme, "## v1 scope"));
    expect(scope).toContain("holds the `interaction` Capability");
    expect(scope).toContain("A request without that Capability resolves to its declared fallback");
    expect(scope).toContain("an `attach` frame without `interactive: false`");
    expect(scope).toContain("During startup Plugin composition in every mode");
  });
});

describe("README default Tools", () => {
  test("states that the headless host ships no filesystem or shell coding Tools", () => {
    const tools = flat(section(readme, "### Default Tools"));
    expect(tools).toContain("ships no filesystem or shell coding Tools");
    expect(tools).toContain("`manage-goal`");
    expect(tools).toContain("(docs/plugin-authoring.md#minimal-local-coding-plugin)");
  });
});

describe("guide accuracy", () => {
  test("the conformance guide names the Vitest peer range the packages declare", () => {
    const guide = flat(read("docs/conformance-suites.md"));
    for (const manifest of manifests) {
      const vitest = manifest.peerDependencies?.vitest;
      if (vitest !== undefined) expect(guide, manifest.name).toContain(`\`${vitest}\``);
    }
    expect(guide).not.toContain("Vitest 3");
  });

  test("the import-boundary rule claims only the checks that check-boundaries performs", () => {
    const checksPackageNames = read("scripts/boundary-core.mjs").includes(
      '"@dungle-scrubs/popeye-plugins"',
    );
    const boundary = flat(
      section(read("docs/plugin-authoring.md"), "## First-party import boundary"),
    );
    expect(boundary).not.toContain("Run `pnpm check-boundaries` to enforce this rule.");
    expect(boundary.includes("It does not yet check imports by package name.")).toBe(
      !checksPackageNames,
    );
  });

  test("the opt-in gate install links the built modules and offers no copy", () => {
    const gates = section(read("docs/plugin-authoring.md"), "## Opt-in gate Plugins");
    expect(gates).toContain('"$PWD/packages/cli/dist/features/tool-vetting.js"');
    expect(gates).toContain('"$PWD/packages/cli/dist/features/trust-gate.js"');
    expect(gates).not.toContain('src/features/tool-vetting.ts" ~/.popeye');
    expect(gates).not.toMatch(/^cp /m);
  });
});
