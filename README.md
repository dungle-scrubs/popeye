# popeye

[![CI](https://github.com/dungle-scrubs/popeye/actions/workflows/ci.yml/badge.svg)](https://github.com/dungle-scrubs/popeye/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@dungle-scrubs/popeye.svg)](https://www.npmjs.com/package/@dungle-scrubs/popeye) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A headless coding agent that carries only the plugins you give it.

popeye is a headless coding-agent harness in which you control every part. With no Plugins added,
the model gets one Tool, `manage-goal`, and cannot read a file or run a command. Tools, Commands,
Hooks and instruction fragments all arrive as Plugins, and popeye's own goal, compaction, reload
and session-name features use the same Plugin API as yours. Each Session is an append-only Journal
that a stopped process can reopen and continue. popeye talks to any OpenAI-compatible endpoint,
including a local model in LM Studio, and [hcn](https://github.com/dungle-scrubs/harness-cli-normalizer)
drives it like any other harness. It takes [pi](https://github.com/earendil-works/pi)'s extension
idea further: pi builds some features into its core, and popeye makes its own features Plugins.

```console
$ popeye -p "List the files in the current directory."
STARTUP {"baseUrlHost":"localhost","mode":"print","model":"qwen3.8-27b-mlx@8bit","sessionAction":"create","toolCount":1}
I don't have a file-listing or shell tool available in this session, so I can't directly inspect the current directory. The only capability I have here is reading/managing a session goal.
...
$ popeye -p --plugin ~/popeye-plugins/local-coding.ts "List the files in the current directory."
STARTUP {"baseUrlHost":"localhost","mode":"print","model":"qwen3.8-27b-mlx@8bit","sessionAction":"create","toolCount":4}
Here are the files in the current directory:
...
| `notes.txt` | file | 6 bytes | Oct 13 10:14 |
| `README.md` | file | 7 bytes | Oct 13 10:14 |
```

The `STARTUP` line on stderr counts the Tools the model was offered. The second run loads the
[minimal local coding Plugin](docs/plugin-authoring.md#minimal-local-coding-plugin), which adds
`read-file`, `write-file` and `run-command`. The model here is a local Qwen served by LM Studio.

## Install

popeye needs Node 24 or later.

```sh
npm install -g @dungle-scrubs/popeye
popeye --version
```

Point popeye at an OpenAI-compatible endpoint and a model. A loopback endpoint such as LM Studio
needs no key; a hosted one needs `POPEYE_API_KEY` (see [Environment](#environment)).

```sh
export POPEYE_BASE_URL="http://localhost:1234/v1"
export POPEYE_MODEL="qwen3.8-27b-mlx@8bit"
```

The five popeye packages share one version, and `popeye --version` prints it. Versions before 0.1.5
do not install, because their published manifests carry `workspace:*` dependencies; they are
deprecated on npm. To run popeye from a checkout of this repository instead, see [Contributing](#contributing); a
checkout needs version 11.5.2 of pnpm.

## Usage

The examples run against a local model, so your output will differ.

### Give the model coding Tools

```sh
mkdir ~/popeye-plugins && cd ~/popeye-plugins
npm init -y && npm pkg set type=module
npm install @dungle-scrubs/popeye-plugins 'effect@^3.22.1'
```

Save the [minimal local coding Plugin](docs/plugin-authoring.md#minimal-local-coding-plugin) in
that folder as `local-coding.ts` and pass it with `--plugin`, as in the example at the top. A Plugin
imports its packages from its own folder, and `"type": "module"` lets Node load the `.ts` file.
popeye also loads every Plugin in `~/.popeye/plugins` and in the project's `.popeye/plugins` without
a flag.

### Keep a run to the Tools you name

```console
$ popeye -p --plugin ~/popeye-plugins/local-coding.ts --tools read-file "Run the command ls."
STARTUP {"baseUrlHost":"localhost","mode":"print","model":"qwen3.8-27b-mlx@8bit","sessionAction":"create","toolCount":1}
I don't have a shell or command-execution tool available ... my only tool is `read_file`, which reads a specific UTF-8 text file at a given path. So I can't run `ls` to list directory contents.
```

`--tools` keeps only the Tools you name, so even `manage-goal` is gone. `--exclude-tools` removes
Tools by name, `--skills` keeps only the Plugins you name, and `--isolation tool-free` loads the
first-party Plugins and offers no Tools at all.

### Start as an Agent definition

```console
$ cat ~/.popeye/agents/reviewer.md
---
name: reviewer
description: Reviews one file and lists its problems.
tools: read-file
---
You review files. List each problem on its own line, or say that you found none.
$ popeye -p --agent reviewer --plugin ~/popeye-plugins/local-coding.ts "Review README.md."
STARTUP {"agent":"reviewer","baseUrlHost":"localhost","mode":"print","model":"qwen3.8-27b-mlx@8bit","sessionAction":"create","toolCount":1}
Problems found in README.md:

- The title "demo" is not descriptive; it doesn't tell readers what the project actually is.
...
```

The body joins the system prompt, and `tools` narrows the Session to Tools that the flags also
grant. popeye reads Agent definitions from `~/.popeye/agents` and the project's `.popeye/agents`.
When any exist, the model also gets a `delegate` Tool that hands a task to one of them as a child
Session.

### Read progress as JSON

```console
$ popeye -p --mode json "Reply with the word ok." | jq -c 'select(._tag != null and ._tag != "assistantThinking")'
{"_tag":"sessionId","sessionId":"bvFb6JSyycE0wCvF"}
{"_tag":"phaseChanged","phase":"IDLE"}
...
{"_tag":"assistantText","text":"ok"}
{"_tag":"phaseChanged","phase":"SETTLING"}
{"_tag":"turnSettled","revision":7,"stopReason":"done"}
```

JSON mode writes Progress lines while the Turn runs, then a Snapshot of the Session, which the
filter above drops. `--mode hcn` writes the event stream hcn reads, and `--mode rpc` keeps the
process open for protocol commands on stdin.

### Continue a Session

```console
$ popeye -p --resume bvFb6JSyycE0wCvF "What word did you reply with?"
STARTUP {"baseUrlHost":"localhost","mode":"print","model":"qwen3.8-27b-mlx@8bit","sessionAction":"resume:bvFb6JSyycE0wCvF","toolCount":1}
I replied with the word **ok**.
```

popeye keeps each Session's Journal in `.popeye/sessions` under the working directory, or in the
directory `--session-dir` names. Resume from the same directory.

### Run popeye through hcn

```console
$ hcn run popeye --model qwen3.8-27b-mlx@8bit "Reply with the word ok."
  ● session f3_oxhng9kKtvzrb (harness-minted)
ok
  ○ clean (exit 0)
```

hcn passes the model and effort and reads popeye's `--mode hcn` events. popeye still reads
`POPEYE_BASE_URL` from the environment, and it loads Plugins from the directories above, since hcn
passes no `--plugin`. To let model-router choose popeye, list a route through it in your
[model registry](https://github.com/dungle-scrubs/model-registry), under the model's `routes`:

```json
{ "harness": "popeye", "modelId": "qwen3.8-27b-mlx@8bit", "hosted": false, "privacyEligible": true, "cost": 10 }
```

The route's label is `<model>@popeye`, such as `qwen3.8-27b@popeye`. Give it the capabilities your
loaded Plugins actually provide, such as `repo-access` once a coding Plugin is in place.

## Concepts

### How the three packages fit

```text
task ──▶ model-router ──▶ routes, best first ──▶ hcn run <harness> --model <id> --effort <level>
              ▲                                              │
              │                                              └─ retryable failure: next route
       model-registry
```

Together, the three packages route each job to a model and harness automatically, following your
preferences. [model-registry](https://github.com/dungle-scrubs/model-registry) defines the registry
file: the models you can use, the harnesses that reach them, and ratings for each.
[model-router](https://github.com/dungle-scrubs/model-router) reads the registry, takes a task, and
returns routes ranked best first. Each route is a harness, a model, and an effort.
[hcn](https://github.com/dungle-scrubs/harness-cli-normalizer) runs the route. If the run fails with
`retryable: true`, run the next route. popeye is a harness built for hcn to drive, and a registry
can list routes through it like any other harness. Each package also works on its own. hcn runs any
harness and model you give it, and model-router ranks routes without running anything.

### Everything is a Plugin

A Plugin is a TypeScript or JavaScript module that returns a manifest and a list of Contributions:
Tools, Commands, Hooks and instruction fragments. popeye composes its own features the same way:
`compact`, `goal`, `reload` and `session-name` on every run, and `delegation` when an Agent
definition exists. `--skills compact`, for example, drops the `goal` Plugin and with it
`manage-goal`. The [Plugin guide](docs/plugin-authoring.md) covers manifests, Capabilities, Trust
and reload.

### Sessions are Journals

popeye writes every Session as an append-only Journal: one JSONL file per Session by default, or
SQLite with `POPEYE_JOURNAL_LAYER=sqlite`. The Journal is the only durable record. A stopped
process reopens it, recovers unfinished work and continues, and each Snapshot is rebuilt from it.

## Reference

### Commands

```text
popeye -p "<prompt>"                    run one prompt and print the settled answer
popeye "<prompt>"                       the same; v1 is headless
echo "<prompt>" | popeye -p             read the prompt from stdin
popeye -p --mode json "<prompt>"        write Progress and Snapshot JSON lines
popeye -p --mode hcn "<prompt>"         write the event stream hcn reads
popeye -p --mode rpc                    stay open for protocol commands on stdin
popeye usage export [--session-dir <dir>] [--session <id>]   one JSON line per Provider request
```

| Option | Effect |
| --- | --- |
| `--model <model>` | the Provider model; overrides `POPEYE_MODEL` |
| `--base-url <url>` | the OpenAI-compatible endpoint; overrides `POPEYE_BASE_URL` |
| `--effort <level>` | reasoning: `off`, `low`, `medium-low`, `medium`, `medium-high`, `high`, `xhigh` |
| `--plugin <path>` | load another Plugin; repeatable |
| `--no-project-plugins` | skip the project's Plugins and Agent definitions |
| `--tools <names>` | offer only these Tools, comma-separated |
| `--exclude-tools <names>` | remove these Tools, comma-separated |
| `--skills <names>` | load only these Plugins, comma-separated; not a trust setting |
| `--isolation tool-free` | load first-party Plugins only and offer no Tools |
| `--agent <name>` | start as an Agent definition |
| `--resume <sessionId>` | continue a Session |
| `--session-dir <dir>` | the Journal directory; default `.popeye/sessions` |
| `--mode <print\|json\|rpc\|hcn>` | the Head; default `print` |

### Environment

| Variable | Effect |
| --- | --- |
| `POPEYE_BASE_URL` | the OpenAI-compatible endpoint |
| `POPEYE_MODEL` | the Provider model |
| `POPEYE_API_KEY` | the endpoint key; overrides every other key on every endpoint |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | used only for `https://api.openai.com` and `https://api.anthropic.com` |
| `POPEYE_AGENTS_DIR` | read user Agent definitions from this directory instead of `~/.popeye/agents` |
| `POPEYE_JOURNAL_LAYER` | `sqlite` or `jsonl`; unset picks SQLite only when `journal.sqlite` exists |
| `POPEYE_SNAPSHOT_PAGE_BYTES` | the Snapshot page target; default 1 MiB |
| `POPEYE_REFLECT_INTAKE` | an executable that hears each Session create, resume and close |

### Exit codes

| Exit | Meaning |
| --- | --- |
| 0 | the Turn completed or was truncated |
| 1 | the Provider settled the Turn as an error |
| 2 | invalid arguments, missing configuration, or an aborted Turn; read stderr to tell them apart |
| 3 | unresolved Tool calls |
| 4 | a Turn failure or a Head boundary failure |

### Security

- Plugins are code that runs with your authority. popeye trusts every Plugin it discovers, so
  running popeye inside a repository runs that repository's `.popeye/plugins`. Pass
  `--no-project-plugins` to skip them, along with project Agent definitions.
- With no Plugins added, the model cannot read files or run commands.
- `POPEYE_API_KEY` goes to whichever endpoint you set. `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`
  go only to their own API hosts. A hosted endpoint without a key exits 2 before any request.
- `popeye usage export` opens Journals read-only and writes no prompts, responses, Tool data,
  endpoint URLs or credentials.

[docs/reference.md](docs/reference.md) holds the full contract: every mode, RPC framing, Session
Goals, Agent definitions and delegation, reasoning levels, usage accounting, and the v1 scope. The
[Plugin guide](docs/plugin-authoring.md), [conformance suites](docs/conformance-suites.md),
[fixture testing](docs/testing-with-fixtures.md) and [glossary](CONTEXT.md) go deeper.

## Contributing

```sh
corepack enable && pnpm install
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm check-boundaries
```

All five checks must pass before review. [CONTRIBUTING.md](CONTRIBUTING.md) covers commits, live
tests against a local model, and releases. Keep package boundaries intact, add durable behavior
through Entries and Records, and add product behavior through Contributions.

## Status

popeye is a personal experiment, before 1.0, shaped around its author's needs. It is headless,
with no TUI. It ships no file or shell Tools; you add them as Plugins. If you want a harness that
does everything as soon as it's installed, use pi. Still deferred: a TUI Head, Plugins referenced
by npm name, and Kernel-initiated select, confirm and input requests.

## Thanks

[pi](https://github.com/earendil-works/pi): popeye reaches Providers through pi-ai, and its design
started from a source review of pi.

## License

popeye is released under the [MIT License](LICENSE).
