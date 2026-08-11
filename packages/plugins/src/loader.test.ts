import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import { expect, test } from "vitest";

import { loadPluginModule } from "./loader.js";

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));

test("native import loads annotations, import type, generics, host imports, and relative siblings", async () => {
  const root = await mkdtemp(join(packageDirectory, ".loader-native-"));
  const pluginPath = join(root, "plugin.ts");

  try {
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "sibling.ts"),
      "export const siblingValue: string = 'relative-sibling';\n",
    );
    await writeFile(
      pluginPath,
      [
        'import { Schema } from "effect";',
        'import type { PluginManifest } from "../src/manifest.ts";',
        'import { siblingValue } from "./sibling.ts";',
        "",
        "const identity = <TValue>(value: TValue): TValue => value;",
        "const manifest: PluginManifest = {",
        "  capabilities: [],",
        "  name: Schema.decodeSync(Schema.String)(identity('native-plugin')),",
        "  version: '1.0.0',",
        "};",
        "",
        "export default (): { manifest: PluginManifest; contributions: readonly unknown[] } => ({",
        "  contributions: [{",
        "    kind: 'instruction-fragment',",
        "    name: 'native-proof',",
        "    payload: { content: siblingValue, id: 'native-proof', trigger: 'explicit' },",
        "    priority: 0,",
        "  }],",
        "  manifest,",
        "});",
        "",
      ].join("\n"),
    );

    const loaded = await Effect.runPromise(loadPluginModule(pluginPath));

    expect(loaded.manifest.name).toBe("native-plugin");
    expect(loaded.contributions).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ content: "relative-sibling" }),
      }),
    ]);
    expect(loaded.path).toBe(pluginPath);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("enum and namespace syntax fail with a clear diagnostic naming the file and construct", async () => {
  const root = await mkdtemp(join(packageDirectory, ".loader-syntax-"));
  const enumPath = join(root, "enum-plugin.ts");
  const namespacePath = join(root, "namespace-plugin.ts");

  try {
    await writeFile(enumPath, "enum Mode { Fast }\nexport default () => Mode.Fast;\n");
    await writeFile(
      namespacePath,
      "namespace Values { export const name = 'value'; }\nexport default () => Values.name;\n",
    );

    const [enumError, namespaceError] = await Effect.runPromise(
      Effect.all([
        Effect.flip(loadPluginModule(enumPath)),
        Effect.flip(loadPluginModule(namespacePath)),
      ]),
    );

    expect(enumError.cause, `${enumError.message}\n${String(enumError.schemaCause)}`).toBe(
      "unsupported_syntax",
    );
    expect(enumError.plugin).toBe(enumPath);
    expect(enumError.message).toContain("enum");
    expect(enumError.message).toContain(enumPath);
    expect(namespaceError).toMatchObject({ cause: "unsupported_syntax", plugin: namespacePath });
    expect(namespaceError.message).toContain("namespace");
    expect(namespaceError.message).toContain(namespacePath);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("reload cache busting re-imports a Plugin with fresh module state", async () => {
  const root = await mkdtemp(join(packageDirectory, ".loader-state-"));
  const pluginPath = join(root, "plugin.ts");
  const stateKey = `peye-loader-${root}`;

  try {
    await writeFile(
      pluginPath,
      [
        `const stateKey = ${JSON.stringify(stateKey)};`,
        "const state = globalThis as Record<string, number | undefined>;",
        "state[stateKey] = (state[stateKey] ?? 0) + 1;",
        "const importCount = state[stateKey];",
        "export const plugin = () => ({",
        "  contributions: [{",
        "    kind: 'instruction-fragment',",
        "    name: 'state',",
        "    payload: { content: String(importCount), id: 'state', trigger: 'explicit' },",
        "    priority: 0,",
        "  }],",
        "  manifest: { capabilities: [], name: 'stateful-plugin', version: '1.0.0' },",
        "});",
        "",
      ].join("\n"),
    );

    const first = await Effect.runPromise(loadPluginModule(pluginPath, { cacheKey: "first" }));
    const second = await Effect.runPromise(loadPluginModule(pluginPath, { cacheKey: "second" }));

    expect(first.contributions[0]?.payload).toMatchObject({ content: "1" });
    expect(second.contributions[0]?.payload).toMatchObject({ content: "2" });
  } finally {
    delete (globalThis as Record<string, unknown>)[stateKey];
    await rm(root, { force: true, recursive: true });
  }
});

test("module-evaluation and factory throws fail as build_failed and name the Plugin file", async () => {
  const root = await mkdtemp(join(packageDirectory, ".loader-build-"));
  const importFailurePath = join(root, "import-failure.ts");
  const factoryFailurePath = join(root, "factory-failure.ts");

  try {
    await writeFile(importFailurePath, "throw new Error('import exploded');\n");
    await writeFile(
      factoryFailurePath,
      "export default () => { throw new Error('factory exploded'); };\n",
    );

    const [importError, factoryError] = await Effect.runPromise(
      Effect.all([
        Effect.flip(loadPluginModule(importFailurePath)),
        Effect.flip(loadPluginModule(factoryFailurePath)),
      ]),
    );

    expect(importError).toMatchObject({ cause: "build_failed", plugin: importFailurePath });
    expect(importError.message).toContain("import exploded");
    expect(factoryError).toMatchObject({ cause: "build_failed", plugin: factoryFailurePath });
    expect(factoryError.message).toContain("factory exploded");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
