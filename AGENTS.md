# popeye — agent guidance

This file is the repo-scoped `AGENTS.md`. Global rules live in `~/.agents/GLOBAL.md` and apply unchanged; this file adds harness-independent, repo-specific guidance.

## De-facto e2e testing method (for now)

A local LM Studio endpoint behind `http://127.0.0.1:1234/v1` is the
de-facto e2e provider until a recorded-fixture or fake-provider soak
replaces it. Machine names, model ids, and tunnel commands live in
`AGENTS.local.md` (untracked, never committed); the shape below stays
public.

- **Endpoint:** `http://127.0.0.1:1234/v1` on loopback.
- **Detect:** `curl -s --max-time 2 127.0.0.1:1234/v1/models`
- **Run the live e2e:** `POPEYE_LIVE_ENDPOINT=http://127.0.0.1:1234/v1
  POPEYE_LIVE_MODEL=<model-id> pnpm vitest run --project @popeye/cli
  src/entry/live.test.ts` (model ids in `AGENTS.local.md`).
- **Other live smoke:** `packages/kernel/src/ai/live-smoke.test.ts` gates on the same endpoint

This keeps traffic on loopback and satisfies the privacy rule — local
work never routes to a hosted model.

## References

- Ubiquitous language: `CONTEXT.md`
- Testing with fixtures: `docs/testing-with-fixtures.md`
- Package graph: `@popeye/journal` (durable), `@popeye/kernel` (Turn/Driver), `@popeye/plugins`, `@popeye/protocol`, `@popeye/cli` (Heads)
