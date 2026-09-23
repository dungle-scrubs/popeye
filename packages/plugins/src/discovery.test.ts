import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { expect, test } from "vitest";

import { classifyResolvedPluginSource, phase1Sources, phase2Sources } from "./discovery.js";
import { computeProjectPluginDigest } from "./trust-digest.js";

test("CLI paths use real-path classification and an in-tree target cannot enter phase 1", async () => {
  const root = await mkdtemp(join(tmpdir(), "popeye-plugin-discovery-"));
  const projectPath = join(root, "project");
  const outsidePath = join(root, "outside");
  const projectPluginPath = join(projectPath, ".popeye", "plugins", "project-plugin.ts");
  const outsidePluginPath = join(outsidePath, "outside-plugin.ts");
  const outsideLinkIntoProject = join(outsidePath, "link-into-project.ts");
  const projectLinkOutside = join(projectPath, ".popeye", "plugins", "link-outside.ts");

  try {
    await mkdir(join(projectPath, ".popeye", "plugins"), { recursive: true });
    await mkdir(outsidePath, { recursive: true });
    await writeFile(projectPluginPath, "export const source = 'project';\n");
    await writeFile(outsidePluginPath, "export const source = 'outside';\n");
    await symlink(projectPluginPath, outsideLinkIntoProject);
    await symlink(outsidePluginPath, projectLinkOutside);

    const sources = await Effect.runPromise(
      phase1Sources({
        cliPaths: [outsideLinkIntoProject, outsidePluginPath],
        projectPath,
        userGlobalDirectories: [],
      }),
    );
    const resolvedProjectPath = await realpath(projectPath);

    expect(sources).toEqual([
      {
        origin: "cli",
        path: await realpath(outsidePluginPath),
        scope: "external",
      },
    ]);
    expect(
      classifyResolvedPluginSource(resolvedProjectPath, await realpath(outsideLinkIntoProject)),
    ).toBe("project-local");
    expect(
      classifyResolvedPluginSource(resolvedProjectPath, await realpath(projectLinkOutside)),
    ).toBe("external");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("an untrusted project executes no project-local Plugin code", async () => {
  const root = await mkdtemp(join(tmpdir(), "popeye-plugin-untrusted-"));
  const projectPath = join(root, "project");
  const projectPluginDirectory = join(projectPath, ".popeye", "plugins");

  try {
    await mkdir(projectPluginDirectory, { recursive: true });
    await writeFile(
      join(projectPluginDirectory, "canary.mjs"),
      "throw new Error('project-local canary executed');\n",
    );

    const sources = await Effect.runPromise(
      phase2Sources(
        { cliPaths: [], projectPath, userGlobalDirectories: [] },
        { kind: "untrusted" },
      ),
    );
    for (const source of sources) {
      await import(source.path);
    }

    expect(sources).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a project awaiting a Trust decision executes no project-local Plugin code", async () => {
  const root = await mkdtemp(join(tmpdir(), "popeye-plugin-awaiting-trust-"));
  const projectPath = join(root, "project");
  const projectPluginDirectory = join(projectPath, ".popeye", "plugins");
  const decisions = [{ kind: "prompt_required" as const }, { kind: "reprompt_required" as const }];

  try {
    await mkdir(projectPluginDirectory, { recursive: true });
    await writeFile(
      join(projectPluginDirectory, "canary.mjs"),
      "throw new Error('project-local canary executed');\n",
    );

    for (const decision of decisions) {
      const sources = await Effect.runPromise(
        phase2Sources({ cliPaths: [], projectPath, userGlobalDirectories: [] }, decision),
      );
      for (const source of sources) {
        await import(source.path);
      }
      expect(sources).toEqual([]);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("two-phase source discovery is stable and idempotent for phase-1 instance reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "popeye-plugin-phases-"));
  const projectPath = join(root, "project");
  const projectPluginDirectory = join(projectPath, ".popeye", "plugins");
  const projectPluginPath = join(projectPluginDirectory, "project-plugin.ts");
  const inTreeCliPath = join(projectPath, "cli-plugin.ts");
  const outsideCliPath = join(root, "outside-cli.ts");
  const userGlobalDirectory = join(root, "user-global");
  const userGlobalPluginPath = join(userGlobalDirectory, "user-plugin.ts");

  try {
    await mkdir(projectPluginDirectory, { recursive: true });
    await mkdir(userGlobalDirectory, { recursive: true });
    await writeFile(projectPluginPath, "export const source = 'project';\n");
    await writeFile(inTreeCliPath, "export const source = 'in-tree-cli';\n");
    await writeFile(outsideCliPath, "export const source = 'outside-cli';\n");
    await writeFile(userGlobalPluginPath, "export const source = 'user-global';\n");

    const config = {
      cliPaths: [outsideCliPath, inTreeCliPath],
      projectPath,
      userGlobalDirectories: [userGlobalDirectory],
    };
    const firstPhase1 = await Effect.runPromise(phase1Sources(config));
    const secondPhase1 = await Effect.runPromise(phase1Sources(config));
    const trustedDigest = (await Effect.runPromise(computeProjectPluginDigest(config))).digest;
    const firstPhase2 = await Effect.runPromise(
      phase2Sources(config, { kind: "trusted", trustedDigest }),
    );
    const secondPhase2 = await Effect.runPromise(
      phase2Sources(config, { kind: "trusted", trustedDigest }),
    );

    expect(firstPhase1).toEqual(secondPhase1);
    expect(firstPhase1).toEqual([
      {
        origin: "cli",
        path: await realpath(outsideCliPath),
        scope: "external",
      },
      {
        origin: "user-global",
        path: await realpath(userGlobalPluginPath),
        scope: "external",
      },
    ]);
    expect(firstPhase2).toEqual(secondPhase2);
    expect(firstPhase2).toEqual([
      {
        origin: "project",
        path: await realpath(projectPluginPath),
        scope: "project-local",
      },
      {
        origin: "cli",
        path: await realpath(inTreeCliPath),
        scope: "project-local",
      },
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("path-segment classification keeps ..evil in the project and rejects a prefix sibling", async () => {
  const root = await mkdtemp(join(tmpdir(), "popeye-plugin-segments-"));
  const projectPath = join(root, "proj");
  const dotDotName = join(projectPath, "..evil.mjs");
  const prefixSibling = join(root, "projsibling", "plugin.mjs");

  try {
    await mkdir(projectPath, { recursive: true });
    await mkdir(join(root, "projsibling"), { recursive: true });
    await writeFile(dotDotName, "export const local = true;\n");
    await writeFile(prefixSibling, "export const external = true;\n");

    const sources = await Effect.runPromise(
      phase1Sources({
        cliPaths: [dotDotName, prefixSibling],
        projectPath,
        userGlobalDirectories: [],
      }),
    );

    expect(sources).toEqual([
      { origin: "cli", path: await realpath(prefixSibling), scope: "external" },
    ]);
    expect(
      classifyResolvedPluginSource(await realpath(projectPath), await realpath(dotDotName)),
    ).toBe("project-local");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("source classification compares canonical real paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "popeye-plugin-canonical-case-"));
  const projectPath = join(root, "Project");
  let projectAlias = join(root, "PROJECT");
  const pluginPath = join(projectPath, "plugin.mjs");

  try {
    await mkdir(projectPath, { recursive: true });
    await writeFile(pluginPath, "export const local = true;\n");
    await realpath(projectAlias).catch(async () => {
      projectAlias = join(root, "project-alias");
      await symlink(projectPath, projectAlias);
    });

    const sources = await Effect.runPromise(
      phase1Sources({
        cliPaths: [pluginPath],
        projectPath: projectAlias,
        userGlobalDirectories: [],
      }),
    );

    expect(sources).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("phase 2 fails closed when Plugin content changes after the Trust check", async () => {
  const root = await mkdtemp(join(tmpdir(), "popeye-plugin-load-digest-"));
  const projectPath = join(root, "project");
  const pluginPath = join(projectPath, ".popeye", "plugins", "plugin.mjs");
  const config = { cliPaths: [], projectPath, userGlobalDirectories: [] };

  try {
    await mkdir(join(projectPath, ".popeye", "plugins"), { recursive: true });
    await writeFile(pluginPath, "export const value = 1;\n");
    const trustedDigest = (await Effect.runPromise(computeProjectPluginDigest(config))).digest;
    await writeFile(pluginPath, "export const value = 2;\n");

    const error = await Effect.runPromise(
      Effect.flip(phase2Sources(config, { kind: "trusted", trustedDigest })),
    );

    expect(error).toMatchObject({
      _tag: "PluginDigestError",
      reason: "digest_error",
      violation: "digest_mismatch",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("an ENOTDIR project Plugin path is an empty phase-2 execution set", async () => {
  const root = await mkdtemp(join(tmpdir(), "popeye-plugin-enotdir-"));
  const projectPath = join(root, "project");
  const config = { cliPaths: [], projectPath, userGlobalDirectories: [] };

  try {
    await mkdir(projectPath, { recursive: true });
    await writeFile(join(projectPath, ".popeye"), "not a directory\n");
    const trustedDigest = (await Effect.runPromise(computeProjectPluginDigest(config))).digest;

    const sources = await Effect.runPromise(
      phase2Sources(config, { kind: "trusted", trustedDigest }),
    );

    expect(sources).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("an EACCES project Plugin directory is an empty phase-2 execution set", async () => {
  const root = await mkdtemp(join(tmpdir(), "popeye-plugin-eacces-"));
  const projectPath = join(root, "project");
  const pluginDirectory = join(projectPath, ".popeye", "plugins");
  const config = { cliPaths: [], projectPath, userGlobalDirectories: [] };

  try {
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(join(pluginDirectory, "hidden.mjs"), "export const hidden = true;\n");
    await chmod(pluginDirectory, 0o000);
    const trustedDigest = (await Effect.runPromise(computeProjectPluginDigest(config))).digest;

    const sources = await Effect.runPromise(
      phase2Sources(config, { kind: "trusted", trustedDigest }),
    );

    expect(sources).toEqual([]);
  } finally {
    await chmod(pluginDirectory, 0o700).catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});
