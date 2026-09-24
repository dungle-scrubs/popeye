# Contributing to popeye

## Ground rules

- Talk plain. Short sentences. No metaphors. The repo's `AGENTS.md`
  holds the full voice rules.
- Conventional commits. Every commit message starts with a type:
  `feat`, `fix`, `docs`, `test`, `refactor`, `chore`. Release
  automation reads these; a wrong type ships the wrong version bump.
- One concern per commit. A review fix and a feature never share one.

## Local setup

Requires Node 24 and pnpm 11.

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

All five must pass before a PR. The full gate is
`pnpm build, typecheck, lint, test, check-boundaries`.

## Live tests

Most tests run on fixtures. The live suite needs a local model
endpoint behind `http://127.0.0.1:1234/v1`:

```bash
POPEYE_LIVE_ENDPOINT=http://127.0.0.1:1234/v1 \
POPEYE_LIVE_MODEL=<model-id> \
pnpm vitest run --project @popeye/cli src/entry/live.test.ts
```

`AGENTS.local.md` (untracked, never committed) holds the current
endpoint and model names.

## Pull requests

- One branch per concern, squash-merged.
- The PR description states what changed and what verified it.
- CI must pass. A failing workflow blocks merge.
- Never commit `.bearings/`, `.scratch/`, or local-only files.
- Never edit `CHANGELOG.md` by hand; release-please owns it.

## Release versioning

Lockstep: all five packages share one version. release-please tracks
`packages/*` plus the root; the manifest holds every path. A release
bumps all five together, even when only one changed. Do not publish
a single package by hand except to recover a failed release; the
recovery version becomes the next lockstep base.
