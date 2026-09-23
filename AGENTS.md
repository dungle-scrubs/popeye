# popeye — agent guidance

This file is the repo-scoped `AGENTS.md`. Global rules live in `~/.agents/GLOBAL.md` and apply unchanged; this file adds harness-independent, repo-specific guidance.

## De-facto e2e testing method (for now)

Local LM Studio endpoint on `mini` is the de-facto e2e provider until a recorded-fixture or fake-provider soak replaces it.

- **Endpoint:** `http://127.0.0.1:1234/v1` (same on `pro` and `mini`; `mini` is the current de-facto host)
- **Models on that host:** `lmstudio-community/qwen3.6-27b-mlx`, `openai/gpt-oss-20b`, `qwen3.6-35b-a3b-mlx`, `unsloth/qwen3.6-27b-mlx`, `gemma-4-31b-it-mlx` — prefer the `qwen3.6-27b` per global privacy guidance
- **Detect:** `curl -s --max-time 2 127.0.0.1:1234/v1/models`
- **If on `air` (24 GB cannot fit the 27B):** tunnel to the serving host for the same local URL — `ssh -f -N -L 1234:127.0.0.1:1234 mini` (global prefers `pro`, but `mini` is the repo's de-facto for now; `ssh pro` is the fallback)
- **Run the live e2e:** `POPEYE_LIVE_ENDPOINT=http://127.0.0.1:1234/v1 POPEYE_LIVE_MODEL=lmstudio-community/qwen3.6-27b-mlx POPEYE_LIVE_MODEL_ALT=openai/gpt-oss-20b pnpm vitest run --project @popeye/cli src/entry/live.test.ts` (10 tests; add `POPEYE_LIVE_HOSTED_*` only for the hosted variant)
- **Other live smoke:** `packages/kernel/src/ai/live-smoke.test.ts` gates on the same endpoint

This keeps traffic on the tailnet behind `127.0.0.1:1234` and satisfies the privacy rule — local work never routes to a hosted model. Update this section when the de-facto changes.

## References

- Ubiquitous language: `CONTEXT.md`
- Testing with fixtures: `docs/testing-with-fixtures.md`
- Package graph: `@popeye/journal` (durable), `@popeye/kernel` (Turn/Driver), `@popeye/plugins`, `@popeye/protocol`, `@popeye/cli` (Heads)
