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
pnpm vitest run --project @dungle-scrubs/popeye src/entry/live.test.ts
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
`packages/*` plus the root; the manifest holds every path. Each path
has its own component: the root is `popeye-workspace`, the CLI is
`popeye`, and the other packages are `popeye-journal`,
`popeye-kernel`, `popeye-plugins`, and `popeye-protocol`. A
`linked-versions` plugin holds all six to one version, so a release
bumps every package together, even when only one changed.

## Releasing

1. release-please opens or updates the `chore: release main` pull
   request on each push to `main`. Never open that pull request by
   hand and never edit its body: release-please reads the body back
   after merge to create the releases. release-please runs with a
   GitHub App token (variable `RELEASE_APP_CLIENT_ID`, secret
   `RELEASE_APP_PRIVATE_KEY`), so the pull request's CI runs without
   approval; GitHub holds CI on a pull request that `GITHUB_TOKEN`
   created until someone approves it.
2. Merging it creates one GitHub release per path. The CLI release,
   tag `popeye-v<version>`, starts the publish job in
   `.github/workflows/release.yml`.
3. The publish job checks out the tag, confirms it is the commit the
   run was started for, packs each package, checks every tarball (no
   `workspace:` specifier, `dist/` only, entry files present, one
   version that matches the tag), installs the tarballs into a clean
   npm project, runs `popeye --version` and `popeye --help`, and then
   publishes with npm trusted publishing and provenance.

Run the same pack, check, and install test locally before you change
packaging:

```bash
pnpm build
pnpm release:check
```

If a publish fails after the release exists, run the Release
workflow by hand (`workflow_dispatch`) on the release tag itself:

```bash
gh workflow run release.yml --ref popeye-v<version>
```

In the Actions tab, pick the tag `popeye-v<version>` under "Use
workflow from". The run publishes the tag it was started on, runs the
same checks, and skips versions that are already on npm. It refuses
to publish when started on a branch, or when the checked-out commit
is not the commit the run was started for, because npm provenance
records the run's commit, not the checkout. A dispatch retries a
failed upload or login; it cannot fix a defect in the tagged code,
which needs a new release.

Never run `npm publish` in a package directory: npm does not replace
`workspace:*` specifiers, so the published manifest names
dependencies no consumer can install. Every uninstallable version on
npm has those specifiers unreplaced.
