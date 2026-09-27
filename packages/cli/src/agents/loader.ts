/**
 * Owns Agent definition discovery: pi-format markdown files (four
 * frontmatter keys plus body) held in popeye's user and project
 * directories. It exists so format parsing, scope shadowing, and the
 * trust-relevant filesystem rules (flat dirs, no ancestor walk, project
 * symlink escape) live behind one interface, independent of CLI wiring.
 * RFC-04 slice 1: data files only — no trust digest, no ESM import.
 * Not responsible for name resolution against --agent (config.ts) or for
 * tool-filter composition (ticket 53).
 */
import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { Data, Effect } from "effect";
import { parse as parseYaml } from "yaml";

export type AgentScope = "project" | "user";

export interface AgentDefinition {
  /** Trimmed markdown body; empty string appends nothing. */
  readonly body: string;
  readonly description: string;
  readonly filePath: string;
  readonly model: string | undefined;
  readonly name: string;
  readonly scope: AgentScope;
  /** Normalized tool names; undefined means no restriction. */
  readonly tools: ReadonlyArray<string> | undefined;
}

export interface AgentDiagnostic {
  readonly detail: string;
  readonly filePath: string;
}

export interface AgentDiscoveryResult {
  /** Merged definitions keyed by exact name; project wins cross-scope. */
  readonly agents: ReadonlyMap<string, AgentDefinition>;
  /** Files that never entered discovery, with the reason each was skipped. */
  readonly diagnostics: ReadonlyArray<AgentDiagnostic>;
}

export type AgentDiscoveryErrorReason =
  | "agent_dir_unreadable"
  | "agent_duplicate_name"
  | "agent_project_unresolvable"
  | "agent_symlink_escape";

export class AgentDiscoveryError extends Data.TaggedError("AgentDiscoveryError")<{
  readonly cause?: unknown;
  readonly message: string;
  readonly reason: AgentDiscoveryErrorReason;
}> {}

export interface AgentDiscoveryOptions {
  /** Project root; project scope reads `<root>/.popeye/agents` only. */
  readonly projectPath: string;
  /** User scope directory: `POPEYE_AGENTS_DIR` when set, else `~/.popeye/agents`. */
  readonly userDir: string;
}

// ---------------------------------------------------------------------------
// Frontmatter parsing (pi's contract: parse unchanged, diverge on error paths)
// ---------------------------------------------------------------------------

const stripByteOrderMark = (content: string): string =>
  content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

const normalizeNewlines = (content: string): string =>
  content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const extractFrontmatter = (content: string): { body: string; yaml: string | null } => {
  const normalized = normalizeNewlines(stripByteOrderMark(content));
  if (!normalized.startsWith("---")) {
    return { body: normalized, yaml: null };
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { body: normalized, yaml: null };
  }
  return {
    body: normalized.slice(endIndex + 4).trim(),
    yaml: normalized.slice(4, endIndex),
  };
};

type FrontmatterParse =
  | { readonly detail: string; readonly ok: false }
  | { readonly frontmatter: Record<string, unknown>; readonly ok: true };

const parseFrontmatter = (yaml: string | null): FrontmatterParse => {
  if (yaml === null || yaml === "") {
    return { frontmatter: {}, ok: true };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch (cause) {
    return {
      detail: `invalid YAML frontmatter: ${cause instanceof Error ? cause.message : String(cause)}`,
      ok: false,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { detail: "frontmatter is not a mapping", ok: false };
  }
  return { frontmatter: parsed as Record<string, unknown>, ok: true };
};

type ToolListParse =
  | { readonly detail: string; readonly ok: false }
  | { readonly ok: true; readonly tools: ReadonlyArray<string> | undefined };

/**
 * RFC-04 tools normalization: a comma-separated string or a YAML list;
 * trim items, drop empties and non-strings; an empty result means no
 * restriction. A present value of any other type is a rejected shape.
 */
const parseToolList = (value: unknown): ToolListParse => {
  if (value === undefined) {
    return { ok: true, tools: undefined };
  }
  if (!Array.isArray(value) && typeof value !== "string") {
    return { detail: "tools must be a comma-separated string or a list", ok: false };
  }
  const raw = Array.isArray(value) ? value : value.split(",");
  const tools = raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return { ok: true, tools: tools.length > 0 ? tools : undefined };
};

type DefinitionParse =
  | { readonly detail: string; readonly ok: false }
  | { readonly definition: Omit<AgentDefinition, "filePath" | "scope">; readonly ok: true };

const parseDefinition = (content: string): DefinitionParse => {
  const { body, yaml } = extractFrontmatter(content);
  const frontmatter = parseFrontmatter(yaml);
  if (!frontmatter.ok) {
    return { detail: frontmatter.detail, ok: false };
  }
  const { name, description, model, tools, ...unknownKeys } = frontmatter.frontmatter;
  void unknownKeys; // Unknown frontmatter keys are ignored (RFC-04 §1).
  if (typeof name !== "string") {
    return { detail: "frontmatter has no string name", ok: false };
  }
  if (typeof description !== "string") {
    return { detail: "frontmatter has no string description", ok: false };
  }
  if (model !== undefined && typeof model !== "string") {
    return { detail: "model must be a string", ok: false };
  }
  const toolList = parseToolList(tools);
  if (!toolList.ok) {
    return { detail: toolList.detail, ok: false };
  }
  return {
    definition: {
      body,
      description,
      model,
      name,
      tools: toolList.tools,
    },
    ok: true,
  };
};

// ---------------------------------------------------------------------------
// Scope loading
// ---------------------------------------------------------------------------

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const isUnavailableDirCode = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause.code === "EACCES" || cause.code === "ENOTDIR" || cause.code === "ENOENT");

/** Plugin-pipeline rule: a resolved path inside the project root is project-local. */
const isInsideProject = (resolvedProjectPath: string, resolvedPath: string): boolean => {
  const pathFromProject = relative(resolvedProjectPath, resolvedPath);
  return (
    pathFromProject === "" ||
    (pathFromProject !== ".." &&
      !pathFromProject.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromProject))
  );
};

interface ScopeFile {
  readonly name: string;
  readonly path: string;
}

const listScopeFiles = (
  directory: string,
  scope: AgentScope,
): Effect.Effect<ReadonlyArray<ScopeFile>, AgentDiscoveryError> =>
  Effect.tryPromise({
    catch: (cause) =>
      new AgentDiscoveryError({
        cause,
        message: `Could not read the ${scope} agent directory ${directory}.`,
        reason: "agent_dir_unreadable",
      }),
    try: () => readdir(directory, { withFileTypes: true }),
  }).pipe(
    Effect.catchIf(
      (error) => isUnavailableDirCode(error.cause),
      () => Effect.succeed([]),
    ),
    Effect.map((entries) =>
      entries
        .filter((entry) => entry.name.endsWith(".md"))
        .filter((entry) => entry.isFile() || entry.isSymbolicLink())
        .map((entry) => ({
          name: entry.name,
          path: join(directory, entry.name),
        }))
        // Deterministic order: pi uses filesystem order, which makes
        // duplicate detection and the available-agents listing unstable.
        .sort((left, right) => compareText(left.name, right.name)),
    ),
  );

/**
 * Plugin-pipeline rule: every project-scope definition must resolve inside
 * the project, including files reached through a symlinked directory. An
 * unresolvable path cannot be shown to escape; the read step reports it.
 */
const projectEscapeTarget = (
  file: ScopeFile,
  resolvedProjectPath: string,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const resolved = yield* Effect.either(
      Effect.tryPromise({
        catch: (cause: unknown) => cause,
        try: () => realpath(file.path),
      }),
    );
    if (resolved._tag === "Left") {
      return undefined;
    }
    return isInsideProject(resolvedProjectPath, resolved.right) ? undefined : resolved.right;
  });

interface ScopeDefinitions {
  readonly definitions: ReadonlyArray<AgentDefinition>;
  readonly diagnostics: ReadonlyArray<AgentDiagnostic>;
}

const loadScope = (options: {
  readonly dir: string;
  readonly projectPath: string;
  readonly scope: AgentScope;
}): Effect.Effect<ScopeDefinitions, AgentDiscoveryError> =>
  Effect.gen(function* () {
    const files = yield* listScopeFiles(options.dir, options.scope);
    // Project scope: every definition must resolve inside the project
    // root, whatever symlinks lie between (mirrors the plugin pipeline).
    const resolvedProjectPath =
      options.scope === "project"
        ? yield* Effect.tryPromise({
            catch: (cause) =>
              new AgentDiscoveryError({
                cause,
                message: `Could not resolve the project path ${options.projectPath}.`,
                reason: "agent_project_unresolvable",
              }),
            try: () => realpath(options.projectPath),
          })
        : undefined;
    const diagnostics: AgentDiagnostic[] = [];
    const definitions: AgentDefinition[] = [];
    for (const file of files) {
      if (resolvedProjectPath !== undefined) {
        const escapedTo = yield* projectEscapeTarget(file, resolvedProjectPath);
        if (escapedTo !== undefined) {
          return yield* new AgentDiscoveryError({
            message: `Project agent definition ${file.path} resolves outside the project (${escapedTo}): refusing.`,
            reason: "agent_symlink_escape",
          });
        }
      }
      const content = yield* Effect.either(
        Effect.tryPromise({
          catch: (cause: unknown) => cause,
          try: () => readFile(file.path, "utf8"),
        }),
      );
      if (content._tag === "Left") {
        diagnostics.push({
          detail: `could not be read: ${
            content.left instanceof Error ? content.left.message : String(content.left)
          }`,
          filePath: file.path,
        });
        continue;
      }
      const parsed = parseDefinition(content.right);
      if (!parsed.ok) {
        diagnostics.push({ detail: parsed.detail, filePath: file.path });
        continue;
      }
      definitions.push({ ...parsed.definition, filePath: file.path, scope: options.scope });
    }
    return { definitions, diagnostics };
  });

const duplicateNameError = (
  scope: AgentScope,
  byName: ReadonlyMap<string, AgentDefinition[]>,
): AgentDiscoveryError | undefined => {
  for (const [name, definitions] of byName) {
    if (definitions.length > 1) {
      const files = definitions.map((definition) => definition.filePath).join(" and ");
      return new AgentDiscoveryError({
        message: `Duplicate agent name ${JSON.stringify(name)} in ${scope} scope: ${files}.`,
        reason: "agent_duplicate_name",
      });
    }
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export const discoverAgents = (
  options: AgentDiscoveryOptions,
): Effect.Effect<AgentDiscoveryResult, AgentDiscoveryError> =>
  Effect.gen(function* () {
    const user = yield* loadScope({
      dir: options.userDir,
      projectPath: options.projectPath,
      scope: "user",
    });
    const userDuplicates = duplicateNameError("user", groupByName(user.definitions));
    if (userDuplicates !== undefined) {
      return yield* userDuplicates;
    }
    const project = yield* loadScope({
      dir: join(options.projectPath, ".popeye", "agents"),
      projectPath: options.projectPath,
      scope: "project",
    });
    const projectDuplicates = duplicateNameError("project", groupByName(project.definitions));
    if (projectDuplicates !== undefined) {
      return yield* projectDuplicates;
    }
    // Cross-scope collision: project wins (pi's both-scope shadowing).
    const agents = new Map<string, AgentDefinition>();
    for (const definition of user.definitions) {
      agents.set(definition.name, definition);
    }
    for (const definition of project.definitions) {
      agents.set(definition.name, definition);
    }
    return {
      agents,
      diagnostics: [...user.diagnostics, ...project.diagnostics],
    };
  });

const groupByName = (
  definitions: ReadonlyArray<AgentDefinition>,
): ReadonlyMap<string, AgentDefinition[]> => {
  const byName = new Map<string, AgentDefinition[]>();
  for (const definition of definitions) {
    const existing = byName.get(definition.name);
    if (existing === undefined) {
      byName.set(definition.name, [definition]);
    } else {
      existing.push(definition);
    }
  }
  return byName;
};
