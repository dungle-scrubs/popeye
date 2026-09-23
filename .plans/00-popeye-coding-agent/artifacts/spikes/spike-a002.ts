import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

type ImportResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly code: string | null; readonly message: string; readonly name: string; readonly ok: false };

const fixtureDirectory = fileURLToPath(new URL("./fixtures-a002/", import.meta.url));
const runner = `
const specifiers = JSON.parse(process.argv[1]);
try {
  const values = [];
  for (const specifier of specifiers) {
    const loaded = await import(specifier);
    values.push(loaded);
  }
  console.log(JSON.stringify({ ok: true, value: values }));
} catch (error) {
  console.log(JSON.stringify({
    code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : null,
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "UnknownError",
    ok: false,
  }));
}
`;

function nativeImport(fileName: string, cacheKey?: string): ImportResult {
  const specifier = `${pathToFileURL(`${fixtureDirectory}${fileName}`).href}${cacheKey === undefined ? "" : `?reload=${cacheKey}`}`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", runner, JSON.stringify([specifier])], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `Node import harness failed: ${result.stderr}`);
  const line = result.stdout.trim().split("\n").at(-1);
  assert.ok(line, `Node import harness produced no JSON for ${fileName}`);
  const parsed = JSON.parse(line) as ImportResult & { readonly value?: readonly Record<string, unknown>[] };
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value![0]! };
}

function nativeImportSequence(fileName: string, cacheKeys: readonly string[]): readonly Record<string, unknown>[] {
  const specifiers = cacheKeys.map((cacheKey) => `${pathToFileURL(`${fixtureDirectory}${fileName}`).href}?reload=${cacheKey}`);
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", runner, JSON.stringify(specifiers)], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `Node cache-busting harness failed: ${result.stderr}`);
  const line = result.stdout.trim().split("\n").at(-1);
  assert.ok(line, "Node cache-busting harness produced no JSON");
  const parsed = JSON.parse(line) as ImportResult & { readonly value?: readonly Record<string, unknown>[] };
  assert.ok(parsed.ok, `cache-busting import should load: ${parsed.ok ? "" : parsed.message}`);
  return parsed.value!;
}

function loaded(result: ImportResult, label: string): Record<string, unknown> {
  assert.ok(result.ok, `${label} should load natively: ${result.ok ? "" : `${result.name} ${result.code} ${result.message}`}`);
  return result.value;
}

function unsupported(result: ImportResult, fileName: string): { readonly code: string | null; readonly fileName: string; readonly message: string } {
  assert.equal(result.ok, false, `${fileName} unexpectedly loaded under native type stripping`);
  if (result.ok) throw new Error("unreachable");
  return { code: result.code, fileName, message: result.message };
}

function main(): void {
  assert.equal(loaded(nativeImport("annotations.ts"), "annotations").example, "annotation:loaded");
  assert.equal(loaded(nativeImport("import-type.ts"), "import type").pluginName, "import-type");
  assert.equal(loaded(nativeImport("generics.ts"), "generics").firstValue, "generic");
  assert.equal(loaded(nativeImport("effect-host-import.ts"), "host effect import").value, "effect-from-host-node-modules");
  assert.equal(loaded(nativeImport("relative-import.ts"), "relative sibling import").value, "relative-sibling-loaded");

  const [firstImport, secondImport] = nativeImportSequence("stateful.ts", ["one", "two"]);
  assert.ok(firstImport);
  assert.ok(secondImport);
  assert.equal(firstImport.importCount, 1);
  assert.equal(secondImport.importCount, 2, "a distinct query string must produce fresh module state");

  const unsupportedSyntax = [
    unsupported(nativeImport("enum.ts"), "enum.ts"),
    unsupported(nativeImport("namespace.ts"), "namespace.ts"),
  ];

  console.log(JSON.stringify({
    cacheBusting: "file URL query string: import(fileUrl + '?reload=' + uniqueKey) yielded importCount 1 then 2 in one Node process",
    node: process.version,
    unsupportedSyntax,
  }, null, 2));
}

main();
