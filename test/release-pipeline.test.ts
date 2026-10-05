/**
 * Issue #69: contract tests for the release pipeline files.
 * release-please matches a merged release PR to a path by component, so two paths with one
 * component make one of them release under the other's tag (the root and packages/cli were both
 * "popeye"). The publish path must be one workflow, gated on the CLI release, must build the
 * commit its run attests, and must run the pack gate and the consumer smoke test before any upload.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

const repositoryRoot = resolve(".");
const read = (path: string): string => readFileSync(join(repositoryRoot, path), "utf8");
const readJson = <T>(path: string): T => JSON.parse(read(path)) as T;

type ReleaserConfig = Record<string, unknown>;
interface ReleaseConfig extends ReleaserConfig {
  readonly packages: Record<string, ReleaserConfig>;
  readonly plugins?: ReadonlyArray<Record<string, unknown>>;
}

const config = readJson<ReleaseConfig>("release-please-config.json");
const manifest = readJson<Record<string, string>>(".release-please-manifest.json");

// Mirrors release-please 17.6.0: BaseStrategy.getComponent (build/src/strategies/base.js:78-83)
// returns "" when include-component-in-tag is false, else the explicit component, else the
// package name normalized by Node.normalizeComponent (build/src/strategies/node.js:89-94), which
// drops an npm scope.
const componentFor = (path: string): string => {
  const effective = { ...config, ...config.packages[path] };
  if (effective["include-component-in-tag"] === false) return "";
  if (typeof effective.component === "string" && effective.component !== "") {
    return effective.component;
  }
  const name = readJson<{ name: string }>(join(path, "package.json")).name;
  return /^@[\w-]+\//.test(name) ? (name.split("/")[1] ?? "") : name;
};

const paths = Object.keys(config.packages);
const components = paths.map(componentFor);

describe("release-please config", () => {
  test("the config and the manifest track the same paths", () => {
    expect(paths.sort()).toEqual(Object.keys(manifest).sort());
  });

  test("every path has its own non-empty component", () => {
    expect(components.filter((component) => component === "")).toEqual([]);
    expect(new Set(components).size).toBe(paths.length);
  });

  test("the root is popeye-workspace and the CLI keeps the popeye component", () => {
    expect(componentFor(".")).toBe("popeye-workspace");
    expect(componentFor("packages/cli")).toBe("popeye");
  });

  test("one linked-versions group holds every component and keeps the main release branch", () => {
    const linked = (config.plugins ?? []).filter((plugin) => plugin.type === "linked-versions");

    expect(linked).toHaveLength(1);
    expect(linked[0]?.merge).toBe(false);
    expect([...((linked[0]?.components as ReadonlyArray<string>) ?? [])].sort()).toEqual(
      [...components].sort(),
    );
  });

  test("commit history for the next release starts at each component's latest release tag", () => {
    expect(config["last-release-sha"]).toBeUndefined();
  });
});

describe("published package contents", () => {
  test.each(["packages/cli", "packages/plugins"])("%s ships dist only", (path) => {
    expect(readJson<{ files?: ReadonlyArray<string> }>(join(path, "package.json")).files).toEqual([
      "dist",
    ]);
  });
});

describe("release workflow", () => {
  const release = read(".github/workflows/release.yml");

  test("one workflow publishes; the release-event Publish workflow is gone", () => {
    expect(existsSync(join(repositoryRoot, ".github/workflows/publish-oidc.yml"))).toBe(false);
    const publishers = ["ci.yml", "release.yml"].filter((file) =>
      read(join(".github/workflows", file)).includes("release-packages.mjs publish"),
    );
    expect(publishers).toEqual(["release.yml"]);
  });

  test("release-please runs with a GitHub App token, so its pull request's CI runs without approval", () => {
    expect(release).toContain("uses: actions/create-github-app-token@v3");
    expect(release).toMatch(/client-id: \$\{\{ vars\.RELEASE_APP_CLIENT_ID \}\}/u);
    expect(release).toMatch(/private-key: \$\{\{ secrets\.RELEASE_APP_PRIVATE_KEY \}\}/u);
    expect(release).toMatch(/token: \$\{\{ steps\.app-token\.outputs\.token \}\}/u);
    expect(release).not.toContain("secrets.GITHUB_TOKEN");
  });

  test("publish is gated on the CLI path release, with manual dispatch as the recovery path", () => {
    expect(release).toContain("steps.release.outputs['packages/cli--release_created']");
    expect(release).toContain("steps.release.outputs['packages/cli--tag_name']");
    expect(release).toContain("workflow_dispatch:");
    expect(release).toContain("needs.release-please.outputs.cli_release_created == 'true'");
    expect(release).not.toContain("outputs.release_created }}");
  });

  test("manual recovery runs on the release tag itself, with no free-form tag input", () => {
    expect(release).toContain(
      "RELEASE_TAG: ${{ github.event_name == 'workflow_dispatch' && github.ref_name ||",
    );
    expect(release).not.toContain("inputs.tag");
    expect(release).not.toMatch(/workflow_dispatch:\s*\n\s+inputs:/);
  });

  test("the publish job checks the run's ref and commit after checkout, before building", () => {
    const order = [
      "uses: actions/checkout@v7",
      'release-packages.mjs source --tag "$RELEASE_TAG" --ref "$GITHUB_REF" --sha "$GITHUB_SHA"',
      "pnpm install --frozen-lockfile",
      "release-packages.mjs pack --out",
    ].map((step) => release.indexOf(step));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
  });

  test("the publish job packs, verifies, smoke-tests, then publishes, in that order", () => {
    const order = [
      "release-packages.mjs pack --out",
      "release-packages.mjs verify --packs",
      "release-packages.mjs smoke --packs",
      "release-packages.mjs publish --packs",
    ].map((step) => release.indexOf(step));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
  });

  test("the publish job uploads with OIDC and never repacks or installs an unpinned npm", () => {
    expect(release).toContain("id-token: write");
    expect(release).not.toContain("pnpm -r publish");
    expect(release).not.toContain("npm@latest");
  });

  test("the dispatch tag reaches shell steps through an env var, never inline", () => {
    expect(release).not.toMatch(/run:.*\$\{\{\s*(inputs|github\.event\.inputs)\./);
  });
});

describe("pull request CI", () => {
  test("CI runs the release check", () => {
    expect(read(".github/workflows/ci.yml")).toContain("pnpm release:check");
    expect(
      readJson<{ scripts: Record<string, string> }>("package.json").scripts["release:check"],
    ).toBe("node scripts/release-packages.mjs check");
  });
});

describe("contributor docs", () => {
  test("CONTRIBUTING names the release check and the recovery dispatch", () => {
    const contributing = read("CONTRIBUTING.md");

    expect(contributing).toContain("pnpm release:check");
    expect(contributing).toContain("popeye-v<version>");
    expect(contributing).toContain("workflow_dispatch");
    expect(contributing).toContain("gh workflow run release.yml --ref popeye-v<version>");
  });
});
