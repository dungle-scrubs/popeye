import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Fiber } from "effect";
import { describe, expect, test, vi } from "vitest";

import { firstPartySuite } from "../features/first-party-suite.js";
import {
  cleanCliEnvironment,
  FAKE_PROVIDER_PROMPT,
  fakeProviderEnvironment,
  runBuiltBin,
  WORKSPACE_PATH,
} from "../test-support/cli.js";

// Issue #68: the README quickstart and the guides' TypeScript examples must run against the public
// package entry points, and the guide must carry a working minimal local coding Plugin. Each
// example is extracted from the guide itself, so the test checks exactly what a reader copies, and
// each Plugin is set up the way docs/plugin-authoring.md tells a reader to set it up.

const CLI_PACKAGE_PATH = fileURLToPath(new URL("../..", import.meta.url));
// docs/plugin-authoring.md: keep Plugin files below packages/cli/ in a checkout, in the git-ignored
// packages/cli/.popeye/local-plugins/, and load them with --plugin.
const LOCAL_PLUGINS_PATH = join(CLI_PACKAGE_PATH, ".popeye", "local-plugins");
const CODING_PROMPT = "Use the local coding Tools.";
const GUIDES = [
  "docs/conformance-suites.md",
  "docs/plugin-authoring.md",
  "docs/testing-with-fixtures.md",
] as const;

const readWorkspaceFile = (path: string): string =>
  readFileSync(join(WORKSPACE_PATH, path), "utf8");

const flat = (text: string): string => text.replace(/\s+/g, " ");

const typescriptBlocks = (markdown: string): ReadonlyArray<string> =>
  [...markdown.matchAll(/^```typescript\n([\s\S]*?)^```$/gm)].map((match) => match[1] ?? "");

// The first TypeScript block below an exact `## ` heading, before the next `## ` heading.
const exampleUnder = (markdown: string, heading: string): string => {
  const lines = markdown.split("\n");
  const start = lines.indexOf(heading);
  expect(start, `docs/plugin-authoring.md has no "${heading}" heading`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const [block] = typescriptBlocks(`${(end < 0 ? rest : rest.slice(0, end)).join("\n")}\n`);
  expect(block, `"${heading}" has no TypeScript example`).toBeDefined();
  return block ?? "";
};

interface NamedImport {
  readonly names: ReadonlyArray<string>;
  readonly specifier: string;
}

// Runtime named imports only: `import type` and inline `type` names are erased by Node. The
// typecheck test below covers the type names of the complete Plugin examples.
const namedImports = (source: string): ReadonlyArray<NamedImport> =>
  [...source.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)";/gm)].map((match) => ({
    names:
      match[1] === undefined
        ? (match[2] ?? "")
            .split(",")
            .map((name) => name.trim())
            .filter((name) => name.length > 0 && !name.startsWith("type "))
            .map((name) => name.split(/\s+as\s+/)[0] ?? name)
        : [],
    specifier: match[3] ?? "",
  }));

const isCheckedSpecifier = (specifier: string): boolean =>
  specifier === "effect" ||
  specifier.startsWith("@popeye/") ||
  specifier.startsWith("@dungle-scrubs/popeye");

// Gives each test its own directory below packages/cli/.popeye/local-plugins/, so Node resolves
// the Plugin's imports through packages/cli/node_modules exactly as for a reader's Plugin file.
const withLocalPluginDirectory = <A>(use: (directory: string) => A): A => {
  mkdirSync(LOCAL_PLUGINS_PATH, { recursive: true });
  const directory = mkdtempSync(join(LOCAL_PLUGINS_PATH, "doc-test-"));
  try {
    return use(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

// Settings that change what these runs show, pinned so the developer's environment cannot.
const pinnedEnvironment = (base: NodeJS.ProcessEnv, userPluginDirectory: string) => {
  const env: NodeJS.ProcessEnv = {
    ...base,
    POPEYE_SNAPSHOT_PAGE_BYTES: "1048576",
    POPEYE_USER_PLUGIN_DIR: userPluginDirectory,
  };
  delete env.POPEYE_JOURNAL_LAYER;
  return env;
};

interface PluginRun {
  readonly projectPath: string;
  readonly snapshot: Record<string, unknown>;
}

// The guide's recipe: save the Plugin below packages/cli/.popeye/local-plugins/, then run the
// built executable from the project directory with --plugin. The project has no node_modules.
const runLocalPlugin = (
  fileName: string,
  source: string,
  options: { readonly prompt: string; readonly providerScript?: unknown },
  inspect: (run: PluginRun) => void,
): void =>
  withLocalPluginDirectory((pluginDirectory) => {
    const projectPath = mkdtempSync(join(tmpdir(), "popeye-doc-project-"));
    try {
      const pluginPath = join(pluginDirectory, fileName);
      const userPluginDirectory = join(pluginDirectory, "user-plugins");
      mkdirSync(userPluginDirectory);
      writeFileSync(pluginPath, source);
      const env = pinnedEnvironment(fakeProviderEnvironment(), userPluginDirectory);
      if (options.providerScript !== undefined) {
        const scriptPath = join(pluginDirectory, "provider-script.json");
        writeFileSync(scriptPath, JSON.stringify(options.providerScript));
        env.POPEYE_FAKE_PROVIDER_SCRIPT = scriptPath;
      }
      const result = runBuiltBin(
        [
          "--plugin",
          pluginPath,
          "-p",
          "--mode",
          "json",
          "--session-dir",
          join(projectPath, "sessions"),
          options.prompt,
        ],
        { cwd: projectPath, env },
      );
      expect(result.status, result.stderr).toBe(0);
      const lastLine = result.stdout.trimEnd().split("\n").at(-1) ?? "null";
      inspect({ projectPath, snapshot: JSON.parse(lastLine) as Record<string, unknown> });
    } finally {
      rmSync(projectPath, { force: true, recursive: true });
    }
  });

interface ToolResultView {
  readonly content: unknown;
  readonly isError: unknown;
  readonly toolCallId: unknown;
  readonly toolName: unknown;
}

const toolResults = (snapshot: Record<string, unknown>): ReadonlyArray<ToolResultView> =>
  ((snapshot.entries ?? []) as ReadonlyArray<{ readonly payload?: Record<string, unknown> }>)
    .map((entry) => entry.payload)
    .filter((payload) => payload?.role === "toolResult")
    .map((payload) => ({
      content: payload?.content,
      isError: payload?.isError,
      toolCallId: payload?.toolCallId,
      toolName: payload?.toolName,
    }));

const toolCall = (id: string, name: string, args: Record<string, string>) => ({
  _tag: "toolCall",
  argumentsJson: JSON.stringify(args),
  id,
  name,
});

interface LoadedTool {
  readonly payload: {
    readonly execute: (
      arguments_: Record<string, string>,
      context: unknown,
    ) => Effect.Effect<{ readonly content: string; readonly isError?: boolean }, unknown>;
  };
}

interface LoadedPlugin {
  readonly contributions: ReadonlyArray<{ readonly kind: string; readonly name: string }>;
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("README quickstart", () => {
  test("the repository form of popeye runs the CLI package from packages/cli", () => {
    const readme = flat(readWorkspaceFile("README.md"));
    const form = /replace `popeye` with `([^`]+)`/.exec(readme)?.[1];
    expect(form, "README names no repository form of popeye").toBeDefined();
    expect(readme).toContain("That form runs from `packages/cli`");
    const [command = "", ...prefix] = (form ?? "").split(" ");
    expect(command).toBe("pnpm");

    const cliManifest = JSON.parse(readWorkspaceFile("packages/cli/package.json")) as {
      readonly version: string;
    };
    const version = spawnSync(command, [...prefix, "--version"], {
      cwd: WORKSPACE_PATH,
      encoding: "utf8",
      env: cleanCliEnvironment(),
    });
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe(cliManifest.version);

    withLocalPluginDirectory((scratch) => {
      // A relative --session-dir resolves against the directory that the form runs in.
      const sessionDirectory = `.popeye/doc-quickstart-${randomUUID()}`;
      try {
        const run = spawnSync(
          command,
          [
            ...prefix,
            "-p",
            "--mode",
            "json",
            "--session-dir",
            sessionDirectory,
            FAKE_PROVIDER_PROMPT,
          ],
          {
            cwd: WORKSPACE_PATH,
            encoding: "utf8",
            env: pinnedEnvironment(fakeProviderEnvironment(), scratch),
          },
        );
        expect(run.status, run.stderr).toBe(0);
        const lastLine = run.stdout.trimEnd().split("\n").at(-1) ?? "null";
        expect(JSON.parse(lastLine)).toHaveProperty("sessionId");
        expect(existsSync(join(CLI_PACKAGE_PATH, sessionDirectory))).toBe(true);
        expect(existsSync(join(WORKSPACE_PATH, sessionDirectory))).toBe(false);
      } finally {
        rmSync(join(CLI_PACKAGE_PATH, sessionDirectory), { force: true, recursive: true });
      }
    });
  }, 30_000);
});

describe("guide TypeScript examples", () => {
  test("import popeye packages and effect only through public entry points that export each name", async () => {
    for (const guide of GUIDES) {
      for (const block of typescriptBlocks(readWorkspaceFile(guide))) {
        for (const { names, specifier } of namedImports(block)) {
          if (!isCheckedSpecifier(specifier)) continue;
          expect(specifier, `${guide} imports a package name that is not published`).not.toMatch(
            /^@popeye\//,
          );
          const module = (await import(specifier)) as Record<string, unknown>;
          for (const name of names) {
            expect(module[name], `${guide}: ${specifier} does not export ${name}`).toBeDefined();
          }
        }
      }
    }
  });
});

describe("docs/plugin-authoring.md", () => {
  const guide = readWorkspaceFile("docs/plugin-authoring.md");

  test("the guide tells a reader where to keep a Plugin and how to run the coding Plugin", () => {
    const text = flat(guide);
    expect(text).toContain("`packages/cli/.popeye/local-plugins/local-coding.ts`");
    expect(text).toContain('node "$popeye_checkout/packages/cli/dist/bin/popeye.js"');
    expect(text).toContain(
      '--plugin "$popeye_checkout/packages/cli/.popeye/local-plugins/local-coding.ts"',
    );
  });

  test("the Minimal Plugin example loads through --plugin with the popeye executable", () => {
    runLocalPlugin(
      "session-info.ts",
      exampleUnder(guide, "## Minimal Plugin"),
      { prompt: FAKE_PROVIDER_PROMPT },
      ({ snapshot }) => {
        expect(snapshot).toMatchObject({
          loadedGeneration: { plugins: expect.arrayContaining(["session-info"]) },
        });
      },
    );
  }, 15_000);

  test("the minimal local coding Plugin runs read-file, write-file, and run-command", () => {
    const step = (items: ReadonlyArray<unknown>) => ({ items, prompt: CODING_PROMPT });
    runLocalPlugin(
      "local-coding.ts",
      exampleUnder(guide, "## Minimal local coding Plugin"),
      {
        prompt: CODING_PROMPT,
        providerScript: {
          responses: [
            step([
              toolCall("call-write", "write-file", {
                content: "hello from popeye",
                path: "notes/hello.txt",
              }),
              { _tag: "done", stopReason: "toolCalls" },
            ]),
            step([
              toolCall("call-read", "read-file", { path: "notes/hello.txt" }),
              toolCall("call-escape", "read-file", { path: "../outside.txt" }),
              toolCall("call-run", "run-command", { command: "cat notes/hello.txt" }),
              toolCall("call-fail", "run-command", { command: "exit 3" }),
              { _tag: "done", stopReason: "toolCalls" },
            ]),
            step([
              { _tag: "textDelta", text: "Done." },
              { _tag: "done", stopReason: "done" },
            ]),
          ],
        },
      },
      ({ projectPath, snapshot }) => {
        expect(snapshot).toMatchObject({
          loadedGeneration: { plugins: expect.arrayContaining(["local-coding"]) },
        });
        const results = new Map(toolResults(snapshot).map((result) => [result.toolCallId, result]));
        expect(results.get("call-write")).toMatchObject({
          content: "Wrote 17 characters to notes/hello.txt.",
          isError: false,
          toolName: "write-file",
        });
        expect(results.get("call-read")).toMatchObject({
          content: "hello from popeye",
          isError: false,
          toolName: "read-file",
        });
        expect(results.get("call-escape")).toMatchObject({ isError: true, toolName: "read-file" });
        expect(String(results.get("call-escape")?.content)).toContain(
          "../outside.txt is outside the workspace",
        );
        expect(results.get("call-run")).toMatchObject({
          content: "hello from popeye",
          isError: false,
          toolName: "run-command",
        });
        expect(results.get("call-fail")).toMatchObject({ isError: true, toolName: "run-command" });
        expect(String(results.get("call-fail")?.content)).toContain("Command failed: exit 3");
        expect(readFileSync(join(projectPath, "notes", "hello.txt"), "utf8")).toBe(
          "hello from popeye",
        );
      },
    );
  }, 15_000);

  test("interrupting a run-command call terminates its shell", async () => {
    const source = exampleUnder(guide, "## Minimal local coding Plugin");
    mkdirSync(LOCAL_PLUGINS_PATH, { recursive: true });
    const pluginDirectory = mkdtempSync(join(LOCAL_PLUGINS_PATH, "doc-test-"));
    try {
      const pluginPath = join(pluginDirectory, "local-coding.ts");
      writeFileSync(pluginPath, source);
      const module = (await import(pluginPath)) as { readonly default: () => LoadedPlugin };
      const runCommand = module
        .default()
        .contributions.find((contribution) => contribution.name === "run-command") as
        | (LoadedPlugin["contributions"][number] & LoadedTool)
        | undefined;
      expect(runCommand?.kind).toBe("tool");

      // Handshake: the shell writes its pid, then replaces itself with `cat`, which waits on its
      // open stdin until something kills it.
      const pidPath = join(pluginDirectory, "shell.pid");
      const fiber = Effect.runFork(
        runCommand?.payload.execute({ command: `echo $$ > '${pidPath}' && exec cat` }, {}) ??
          Effect.die("run-command is missing"),
      );
      const pid = await vi.waitFor(
        () => {
          const text = readFileSync(pidPath, "utf8").trim();
          expect(text).toMatch(/^\d+$/);
          return Number(text);
        },
        { interval: 20, timeout: 5_000 },
      );
      expect(isAlive(pid)).toBe(true);

      await Effect.runPromise(Fiber.interrupt(fiber));
      await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { interval: 20, timeout: 5_000 });
    } finally {
      rmSync(pluginDirectory, { force: true, recursive: true });
    }
  }, 15_000);

  test("the complete Plugin examples typecheck against the built public declarations", () => {
    withLocalPluginDirectory((directory) => {
      writeFileSync(join(directory, "session-info.ts"), exampleUnder(guide, "## Minimal Plugin"));
      writeFileSync(
        join(directory, "local-coding.ts"),
        exampleUnder(guide, "## Minimal local coding Plugin"),
      );
      writeFileSync(
        join(directory, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            composite: false,
            declaration: false,
            declarationMap: false,
            noEmit: true,
            types: ["node"],
          },
          extends: join(WORKSPACE_PATH, "tsconfig.base.json"),
          files: ["session-info.ts", "local-coding.ts"],
        }),
      );
      const result = spawnSync(
        process.execPath,
        [join(WORKSPACE_PATH, "node_modules", "typescript", "bin", "tsc"), "-p", directory],
        { encoding: "utf8" },
      );
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    });
  }, 30_000);
});

describe("default Tools", () => {
  test("the default first-party Plugins add no filesystem or shell Tool, as the README states", () => {
    const toolNames = firstPartySuite.defaultPlugins
      .flatMap((plugin) => plugin.contributions)
      .filter((contribution) => contribution.kind === "tool")
      .map((contribution) => contribution.name);
    expect(toolNames).toEqual(["manage-goal"]);

    const readme = flat(readWorkspaceFile("README.md"));
    expect(readme).toContain("ships no filesystem or shell coding Tools");
    expect(readme).toContain("the only model-visible Tool is `manage-goal`");
  });
});
