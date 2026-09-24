# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4](https://github.com/dungle-scrubs/popeye/compare/popeye-v0.1.3...popeye-v0.1.4) (2026-09-24)


### Added

* **cli,kernel,plugins:** opt-in gate plugins and test hardening (M8,M9) ([902280c](https://github.com/dungle-scrubs/popeye/commit/902280c8650a2fa07c760711197915f79ad7e46f))
* **cli,kernel:** system-prompt composition, skills allowlist, tool-free isolation (RFC-02 P4) ([8b30ae4](https://github.com/dungle-scrubs/popeye/commit/8b30ae4100b3b3a1eb2ca6818f621bae4ba5d9bd))
* **cli,plugins,protocol:** reload swap and PluginInteractions seam (M5,M7) ([529120c](https://github.com/dungle-scrubs/popeye/commit/529120c6f43a18eb34a4647b991b15f29b5dd0b1))
* **cli:** CliEntry deep module (01 architecture review) ([8e7b366](https://github.com/dungle-scrubs/popeye/commit/8e7b366cd1b2a9ca96a3c7f23d9754e651ec0fab))
* **cli:** composition root over makePluginRuntime (M4) ([b13574f](https://github.com/dungle-scrubs/popeye/commit/b13574f9fd2636df3e30c38b06ba1220e40078b0))
* **cli:** FirstPartySuite deep module (02 architecture review) ([6602f14](https://github.com/dungle-scrubs/popeye/commit/6602f14104af1171e1e79a49699643f857d8654f))
* **cli:** HCN grant flags parsed; resume-last refused at config (RFC-02 P4) ([d129efb](https://github.com/dungle-scrubs/popeye/commit/d129efbfed96a6152f2d5e5262ca892677ee1586))
* **cli:** hcn head mode with run event mapper, taxonomy, and exit matrix (RFC-02 P1) ([bdc2cfc](https://github.com/dungle-scrubs/popeye/commit/bdc2cfc60d3cd3754a42ae6ad45cdcceb9b58390))
* **cli:** HeadSessionLoop deep module (01 architecture review) ([f0bebc2](https://github.com/dungle-scrubs/popeye/commit/f0bebc2f96ea3cac34386d67809c2077807818b0))
* **cli:** HeadWire deep module (C1 architecture review) ([ba57fc0](https://github.com/dungle-scrubs/popeye/commit/ba57fc085f303c1982ace3c09c66ab56458e65f6))
* **cli:** RPC close op drains with 5s grace and emits terminal closed shape (RFC-02 P2) ([0fab424](https://github.com/dungle-scrubs/popeye/commit/0fab424512c11f17642ef520ce5422deab11c52a))
* **cli:** RpcSessionBridge deep module (02 architecture review) ([21339f8](https://github.com/dungle-scrubs/popeye/commit/21339f850e4432a2f49333cd329f2662f76094bc))
* **cli:** RpcTransport deep module (M4 04-architecture-deepening) ([f9880fa](https://github.com/dungle-scrubs/popeye/commit/f9880facc3dc41cb76a7a4fd5fb4834f014a97f3))
* **cli:** session-id first line on json head; loop owns settled turns for all heads (RFC-02 P1 item 1) ([e478b9b](https://github.com/dungle-scrubs/popeye/commit/e478b9ba728defe4dc248e49e1bfe0a6b25945af))
* **cli:** session-keyed ToolRegistry view via startup generation (M3) ([8113a55](https://github.com/dungle-scrubs/popeye/commit/8113a55e8cc7391b959d2fa6f709ff382db5bfc0))
* **cli:** tool grant filter, effort ladder, context-window override (RFC-02 P4) ([f6a9d89](https://github.com/dungle-scrubs/popeye/commit/f6a9d892a58740e6f1ac2bd32c116ba31c5aae62))
* **cli:** ToolGateService deep module (M3 04-architecture-deepening) ([44475fb](https://github.com/dungle-scrubs/popeye/commit/44475fb68dcfd5cdaf5f73b644b4f6e6da646bc7))
* **cli:** ToolInvocationPipeline deep module (02 architecture review) ([ab8d569](https://github.com/dungle-scrubs/popeye/commit/ab8d56924cba4dae78516bc99cee4a66da7e3a5c))
* **journal,cli:** JournalStore deep module (C4 architecture review) ([2c8b243](https://github.com/dungle-scrubs/popeye/commit/2c8b24349d04b25b406bfaab199187963af03b8d))
* **journal:** report-only readExport with torn-tail flag for HCN transcript arm (RFC-02 P3) ([06deff8](https://github.com/dungle-scrubs/popeye/commit/06deff8d39b991d30657c854c0239e2f03667d93))
* **journal:** transcript mapping contract, fixtures, and digest pin for HCN reader arm (RFC-02 P3) ([f4259d1](https://github.com/dungle-scrubs/popeye/commit/f4259d17dd799d664fc2848ae482eec73d65b5c8))
* **kernel,plugins:** session-keyed Tool views and import timeout (M2,M6) ([2bd58e3](https://github.com/dungle-scrubs/popeye/commit/2bd58e3f8c087fe0824ac168808c253bcfb1ae22))
* **kernel:** C2 diagnostic extension, transient and status on provider_error (RFC-02 P1) ([bb2ffff](https://github.com/dungle-scrubs/popeye/commit/bb2ffffc6846b9e88993c9dc054eb164ecf4da4a))
* **kernel:** closeSession drains session queue with 5s grace, settles turn, returns snapshot (RFC-02 P2) ([0a8ea28](https://github.com/dungle-scrubs/popeye/commit/0a8ea285604f077cfe9529e710a21278bdb24ea5))
* **kernel:** provider usage reporting through the ai seam (RFC-01) ([33927be](https://github.com/dungle-scrubs/popeye/commit/33927be63ef629579d153d60d4d5a826e61240f7))
* **kernel:** RecoveryEngine deep module (C1 architecture review) ([be2f831](https://github.com/dungle-scrubs/popeye/commit/be2f8310ff32b280870b91c7123a99fbc83872e1))
* **kernel:** SessionConductor deep module (C5 architecture review) ([e8bda74](https://github.com/dungle-scrubs/popeye/commit/e8bda749cdfcae86add99491277f79078b9df58d))
* **kernel:** SessionStore single Journal caller (M1/M2 05-journal-drift) ([ca2b2b0](https://github.com/dungle-scrubs/popeye/commit/ca2b2b05996aa9808d5d2708b570ccca27039a32))
* **kernel:** SessionView deep module (01 architecture review) ([f1a9561](https://github.com/dungle-scrubs/popeye/commit/f1a9561f724e18a4f66217ed5c4a1beba70fa038))
* **kernel:** TurnDurability deep module (C2 architecture review) ([ba57fc0](https://github.com/dungle-scrubs/popeye/commit/ba57fc085f303c1982ace3c09c66ab56458e65f6))
* **kernel:** TurnOrchestrator deep module (M1 04-architecture-deepening) ([37bf3d8](https://github.com/dungle-scrubs/popeye/commit/37bf3d86541e30e93918640f4e4d4ba29f66479e))
* **plugins,cli:** GenerationRuntime single owner (M2 04-architecture-deepening) ([03a718a](https://github.com/dungle-scrubs/popeye/commit/03a718af09c16bf6241210be69ea5e91a0927c79))
* **plugins:** generation lease primitive checkout (M1) ([c8cfb80](https://github.com/dungle-scrubs/popeye/commit/c8cfb8026c5a7a75c8113683b872ef232bb08efb))
* **plugins:** PluginPipeline deep module (C3 architecture review) ([05b6666](https://github.com/dungle-scrubs/popeye/commit/05b66666c6a35b94209dd089dd886c5f5ee18c1e))
* **protocol,cli:** SnapshotView deep module (C2 architecture review) ([38d6aa9](https://github.com/dungle-scrubs/popeye/commit/38d6aa9bac50f5cd321229f0efeda5e5e6dd8040))


### Fixed

* **cli,kernel:** close bypasses stalled prompts; single close budget; mid-turn close tests ([cb98123](https://github.com/dungle-scrubs/popeye/commit/cb9812336ba2577145ee000fbe9951755d610821))
* **cli,kernel:** keep compaction summary on replace; filter reload cache; strict grant values; print turnOptions ([7ce6de2](https://github.com/dungle-scrubs/popeye/commit/7ce6de2e0427c97a8f33610821662c0681279c26))
* **cli:** context-window rides provider layer; strict empty grant lists; honest RPC refusal ([2d2b887](https://github.com/dungle-scrubs/popeye/commit/2d2b887d5d042d81322bd3947a5b728906040291))
* **docs:** position unit is byte-offset, matching the bookmark digest input ([91cfeaa](https://github.com/dungle-scrubs/popeye/commit/91cfeaaeae2f1c8bab0afc47ab3bfb33ccd4db43))
* **journal:** suppressRepair layer flag reports pre-torn tails; doc clarifications from P3 review ([a8e1d44](https://github.com/dungle-scrubs/popeye/commit/a8e1d4454003a17d20e709ef2b913aa9eeb907c5))


### Changed

* **cli:** built-bin RPC close probe returns terminal closed shape ([f158f27](https://github.com/dungle-scrubs/popeye/commit/f158f273d85ca0f1f8d578ce8869de38773cd0fe))
* **cli:** delete heads/shared facade; import HeadWire directly ([759af1e](https://github.com/dungle-scrubs/popeye/commit/759af1e52a4834087b018d61966cc5413ed133ea))
* **cli:** delete tool-gate facade and ToolGateService aliases ([5b5e0d8](https://github.com/dungle-scrubs/popeye/commit/5b5e0d805ca3f9d4d5f836ba3b35b9a4bcf6964f))
* **cli:** document ToolInvocationPipeline alias retain ([d0d3cf2](https://github.com/dungle-scrubs/popeye/commit/d0d3cf2edba91dbe9c8838387e55ab8be6617f8a))
* **cli:** shared scripted head drivers, capture writer, hcn cli fixture ([3049579](https://github.com/dungle-scrubs/popeye/commit/3049579eea7178826ba126acead01f685ac0eb94))
* ignore local bearings briefings ([2a2f56a](https://github.com/dungle-scrubs/popeye/commit/2a2f56a63ade8443513f7524cd57b07db94ba798))
* **kernel:** delete Turns shim; Driver depends on TurnOrchestrator ([ca7dbe7](https://github.com/dungle-scrubs/popeye/commit/ca7dbe732584608d71e3ce9e85489d30651dfd45))
* **plans:** track 03/04/05 implementation and plan databases ([359894e](https://github.com/dungle-scrubs/popeye/commit/359894edf284e41550d2383b600d94bb6a2568b3))
* **plugins:** delete generation shim; makeGenerationRuntime is the one constructor ([983366e](https://github.com/dungle-scrubs/popeye/commit/983366ef292cb831dbc08919ada2e52b71d68533))
* prefer-offline for the clean-room conformance consumer ([e133a22](https://github.com/dungle-scrubs/popeye/commit/e133a229930bf4b0be16d2be843de5e0417c16a5))
* refresh deep-module headers for RpcHead and Plugin seams ([cc965b7](https://github.com/dungle-scrubs/popeye/commit/cc965b7ed73b07bc77eb8e7a2dc5643ec09e37f3))
* **release:** public-release readiness - scope rename, templates, controls, automation ([#26](https://github.com/dungle-scrubs/popeye/issues/26)) ([1d28d16](https://github.com/dungle-scrubs/popeye/commit/1d28d1696f2166e69395e77fff5915a0e492289e))
* **release:** sync versions to shipped registry state ([#36](https://github.com/dungle-scrubs/popeye/issues/36)) ([703668c](https://github.com/dungle-scrubs/popeye/commit/703668cf9c8f3fda45af46cb98a8c4f5a27d85a0))
* repo AGENTS.md and CLAUDE.md, brand mark assets ([f29db02](https://github.com/dungle-scrubs/popeye/commit/f29db026f26cadeac8201aade3b42997499e6f3c))
* RFC-02 Accepted (OQ1 audit confirmed by GLM, OQ2 incremental) ([0aeb75b](https://github.com/dungle-scrubs/popeye/commit/0aeb75bff6413f8de6337a8c488a83617dd71540))
* RFC-02 Popeye HCN route (Draft, GLM cross-reviewed) ([cdb0e6d](https://github.com/dungle-scrubs/popeye/commit/cdb0e6dd1d985ecc96bc29518c630940dc2cb27b))

## [Unreleased]
