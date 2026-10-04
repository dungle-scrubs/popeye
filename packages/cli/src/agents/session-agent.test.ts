/**
 * Covers the per-Session Agent resolution behind the rpc create agent field
 * (RFC-04 §3 and §4, issue #55): the same name resolution, message contract,
 * model precedence, persona, and Tool filter composition as --agent, applied
 * to one Session instead of the process.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Logger } from "effect";
import { afterEach, expect, test } from "vitest";

import { parseArgs } from "../entry/args.js";
import { resolveConfig } from "../entry/config.js";
import { composeToolGrantFilter } from "../tools/grants.js";
import { type AgentDiscoveryResult, discoverAgents } from "./loader.js";
import { makeAgentSessionResolver } from "./session-agent.js";

const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const tempDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "popeye-session-agent-"));
  temporaryDirectories.push(directory);
  return directory;
};

const discoveryWith = (
  entries: ReadonlyArray<{
    readonly body?: string;
    readonly model?: string;
    readonly name: string;
    readonly scope?: "project" | "user";
    readonly tools?: ReadonlyArray<string>;
  }>,
): AgentDiscoveryResult => ({
  agents: new Map(
    entries.map((entry) => [
      entry.name,
      {
        body: entry.body ?? `${entry.name} persona body.`,
        description: "test agent",
        filePath: `/agents/${entry.name}.md`,
        model: entry.model,
        name: entry.name,
        scope: entry.scope ?? "user",
        tools: entry.tools,
      },
    ]),
  ),
  diagnostics: [],
});

const granted = (...names: ReadonlyArray<string>) =>
  Effect.succeed(new Set(names) as ReadonlySet<string>);

const resolverOver = (
  discovery: AgentDiscoveryResult,
  options: {
    readonly granted?: ReadonlyArray<string>;
    readonly modelSource?: "agent" | "env" | "flag";
  } = {},
) =>
  makeAgentSessionResolver({
    discover: Effect.succeed(discovery),
    grantedToolNames: granted(...(options.granted ?? ["alpha", "beta"])),
    modelSource: options.modelSource ?? "env",
    unresolvedModelMessage: () => undefined,
  });

test("an unknown name fails with unknown_agent and the --agent message contract", async () => {
  const discovery = discoveryWith([{ name: "scout" }, { name: "planner", scope: "project" }]);
  const parsed = await Effect.runPromise(parseArgs(["-p", "--agent", "ghost", "Explain."]));
  const flagError = await Effect.runPromise(
    Effect.flip(
      resolveConfig(
        parsed,
        { POPEYE_BASE_URL: "http://127.0.0.1:1234/v1", POPEYE_MODEL: "m" },
        discovery,
      ),
    ),
  );

  const error = await Effect.runPromise(Effect.flip(resolverOver(discovery).resolve("ghost")));

  expect(error).toMatchObject({
    _tag: "AgentSessionError",
    agent: "ghost",
    available: ["scout", "planner"],
    reason: "unknown_agent",
  });
  expect(error.message).toBe(flagError.message);
  expect(error.message).toBe(
    'Unknown agent "ghost". Available agents: scout (user), planner (project).',
  );
});

test("an unknown name with no definitions lists none", async () => {
  const error = await Effect.runPromise(
    Effect.flip(resolverOver(discoveryWith([])).resolve("ghost")),
  );

  expect(error).toMatchObject({ available: [], reason: "unknown_agent" });
  expect(error.message).toBe('Unknown agent "ghost". Available agents: none.');
});

test("resolution is exact and case-sensitive", async () => {
  const error = await Effect.runPromise(
    Effect.flip(resolverOver(discoveryWith([{ name: "scout" }])).resolve("Scout")),
  );

  expect(error).toMatchObject({ reason: "unknown_agent" });
});

test("model precedence per Session: --model beats the agent model, which beats POPEYE_MODEL", async () => {
  const withModel = discoveryWith([{ model: "agent-model", name: "scout" }]);
  const withoutModel = discoveryWith([{ name: "scout" }]);

  const envProcess = await Effect.runPromise(
    resolverOver(withModel, { modelSource: "env" }).resolve("scout"),
  );
  const flagProcess = await Effect.runPromise(
    resolverOver(withModel, { modelSource: "flag" }).resolve("scout"),
  );
  const noAgentModel = await Effect.runPromise(
    resolverOver(withoutModel, { modelSource: "env" }).resolve("scout"),
  );

  // No --model: the agent model is the Session's model preference.
  expect(envProcess.turnOptions.model).toBe("agent-model");
  // --model on the process wins: the Session keeps the process model.
  expect(flagProcess.turnOptions).not.toHaveProperty("model");
  // No agent model: the Session keeps the process model (POPEYE_MODEL).
  expect(noAgentModel.turnOptions).not.toHaveProperty("model");
});

test("the body becomes the Session's appended system prompt and an empty body appends nothing", async () => {
  const withBody = await Effect.runPromise(
    resolverOver(discoveryWith([{ body: "Review every diff.", name: "scout" }])).resolve("scout"),
  );
  const emptyBody = await Effect.runPromise(
    resolverOver(discoveryWith([{ body: "", name: "scout" }])).resolve("scout"),
  );

  expect(withBody).toMatchObject({
    filePath: "/agents/scout.md",
    name: "scout",
    turnOptions: { appendSystemPrompt: "Review every diff." },
  });
  expect(emptyBody.turnOptions).toEqual({});
});

test("the tools list becomes a Session filter of the Agent list only", async () => {
  const listed = await Effect.runPromise(
    resolverOver(discoveryWith([{ name: "scout", tools: ["alpha"] }])).resolve("scout"),
  );
  const unlisted = await Effect.runPromise(
    resolverOver(discoveryWith([{ name: "scout" }])).resolve("scout"),
  );

  // The process flags already live in the process filter (RFC-04 §5 intersection),
  // so the Session filter carries the Agent list and nothing else.
  expect(listed.toolFilter).toEqual(
    composeToolGrantFilter({
      access: undefined,
      agentTools: ["alpha"],
      excludeTools: [],
      isolation: undefined,
      tools: [],
    }),
  );
  expect(listed.grantedTools).toEqual(["alpha"]);
  expect(listed.ungrantedTools).toEqual([]);
  expect(unlisted.toolFilter).toBeUndefined();
  expect(unlisted.grantedTools).toEqual([]);
  expect(unlisted.ungrantedTools).toEqual([]);
});

test("a list whose every name is ungranted fails the create closed", async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      resolverOver(discoveryWith([{ name: "scout", tools: ["ghost-tool", "native:other"] }]), {
        granted: ["alpha"],
      }).resolve("scout"),
    ),
  );

  expect(error).toMatchObject({
    _tag: "AgentSessionError",
    agent: "scout",
    reason: "agent_tools_unknown",
    ungrantedTools: ["ghost-tool", "native:other"],
  });
  expect(error.message).toBe(
    "Agent scout (/agents/scout.md) lists only tools this session does not grant: ghost-tool, native:other. The Session fails closed.",
  );
});

test("a list under a tool-free process grant fails the create closed", async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      resolverOver(discoveryWith([{ name: "scout", tools: ["alpha"] }]), {
        granted: [],
      }).resolve("scout"),
    ),
  );

  expect(error).toMatchObject({ reason: "agent_tools_unknown", ungrantedTools: ["alpha"] });
});

test("a partly ungranted list resolves with the granted subset and names the rest", async () => {
  const plan = await Effect.runPromise(
    resolverOver(discoveryWith([{ name: "scout", tools: ["native:alpha", "ghost-tool"] }]), {
      granted: ["alpha", "beta"],
    }).resolve("scout"),
  );

  expect(plan.grantedTools).toEqual(["native:alpha"]);
  expect(plan.ungrantedTools).toEqual(["ghost-tool"]);
  expect(plan.toolFilter).toEqual(
    composeToolGrantFilter({
      access: undefined,
      agentTools: ["native:alpha", "ghost-tool"],
      excludeTools: [],
      isolation: undefined,
      tools: [],
    }),
  );
});

test("discovery and the granted Tools are read on every resolve", async () => {
  const userDir = tempDirectory();
  const projectPath = tempDirectory();
  const write = (name: string, body: string) =>
    writeFileSync(
      join(userDir, `${name}.md`),
      `---\nname: ${name}\ndescription: ${name} agent\ntools: alpha\n---\n${body}\n`,
      "utf8",
    );
  write("scout", "First body.");
  let grantedNames: ReadonlyArray<string> = ["alpha"];
  const resolver = makeAgentSessionResolver({
    discover: discoverAgents({ projectPath, userDir }),
    grantedToolNames: Effect.sync(() => new Set(grantedNames) as ReadonlySet<string>),
    modelSource: "env",
    unresolvedModelMessage: () => undefined,
  });

  const first = await Effect.runPromise(resolver.resolve("scout"));
  write("scout", "Edited body.");
  write("planner", "Planner body.");
  const edited = await Effect.runPromise(resolver.resolve("scout"));
  const added = await Effect.runPromise(resolver.resolve("planner"));
  grantedNames = ["beta"];
  const regranted = await Effect.runPromise(Effect.flip(resolver.resolve("scout")));

  expect(first.turnOptions.appendSystemPrompt).toBe("First body.");
  expect(edited.turnOptions.appendSystemPrompt).toBe("Edited body.");
  expect(added.name).toBe("planner");
  expect(regranted).toMatchObject({ reason: "agent_tools_unknown" });
});

test("a discovery failure fails the resolve with the discovery reason", async () => {
  const userDir = tempDirectory();
  const projectPath = tempDirectory();
  for (const fileName of ["twin.md", "twin-again.md"]) {
    writeFileSync(join(userDir, fileName), "---\nname: twin\ndescription: d\n---\nB.\n", "utf8");
  }
  const resolver = makeAgentSessionResolver({
    discover: discoverAgents({ projectPath, userDir }),
    grantedToolNames: granted("alpha"),
    modelSource: "env",
    unresolvedModelMessage: () => undefined,
  });

  const error = await Effect.runPromise(Effect.flip(resolver.resolve("twin")));

  expect(error).toMatchObject({
    _tag: "AgentSessionError",
    agent: "twin",
    reason: "agent_duplicate_name",
  });
  expect(error.message).toContain("Duplicate agent name");
  expect(error.message).toContain("twin.md");
  expect(error.message).toContain("twin-again.md");
});

test("skipped definitions are logged with the --agent diagnostic text", async () => {
  const userDir = tempDirectory();
  const projectPath = tempDirectory();
  mkdirSync(userDir, { recursive: true });
  const brokenPath = join(userDir, "broken.md");
  writeFileSync(brokenPath, "---\nname: broken\ndescription: [unclosed\n---\nBody.\n", "utf8");
  writeFileSync(
    join(userDir, "healthy.md"),
    "---\nname: healthy\ndescription: d\n---\nHealthy body.\n",
    "utf8",
  );
  const warnings: Array<string> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel._tag === "Warning") {
      warnings.push(Array.isArray(message) ? message.join(" ") : String(message));
    }
  });
  const resolver = makeAgentSessionResolver({
    discover: discoverAgents({ projectPath, userDir }),
    grantedToolNames: granted("alpha"),
    modelSource: "env",
    unresolvedModelMessage: () => undefined,
  });

  const plan = await Effect.runPromise(
    resolver.resolve("healthy").pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger))),
  );

  expect(plan.name).toBe("healthy");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(
    new RegExp(
      `^Agent definition ${brokenPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} skipped: invalid YAML`,
    ),
  );
});

test("an unresolvable Agent model fails resolution closed", async () => {
  const resolver = makeAgentSessionResolver({
    discover: Effect.succeed(discoveryWith([{ model: "not-a-model", name: "scout" }])),
    grantedToolNames: granted("alpha"),
    modelSource: "env",
    unresolvedModelMessage: (modelId) => `Unknown pi-ai model groq/${modelId}.`,
  });
  const result = await Effect.runPromise(Effect.either(resolver.resolve("scout")));
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      _tag: "AgentSessionError",
      agent: "scout",
      reason: "agent_model_unresolvable",
      message:
        "Agent scout (/agents/scout.md): Unknown pi-ai model groq/not-a-model. The Session fails closed.",
    },
  });
});
