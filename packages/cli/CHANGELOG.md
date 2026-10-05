# Changelog

## [0.2.0](https://github.com/dungle-scrubs/popeye/compare/popeye-v0.1.7...popeye-v0.2.0) (2026-10-05)


### ⚠ BREAKING CHANGES

* **kernel:** the kernel no longer exports TurnOptionsResolver or keepTurnOptions, and TurnOrchestratorService.openTurn loses its resolveOptions parameter (onAdmitted moves from the sixth position to the fifth). Direct openTurn callers now get Branch settings applied (a journaled model beats the request model) at the cost of one more Branch read per Turn, and Goal continuations re-resolve options on each Turn, so a set-model or set-thinking recorded during a Goal chain applies to the next continuation.

### Fixed

* **cli:** /reload performs a real Generation swap ([#96](https://github.com/dungle-scrubs/popeye/issues/96)) ([a64954e](https://github.com/dungle-scrubs/popeye/commit/a64954e0e07ea21912abe1f787527be304ada6fa)), closes [#93](https://github.com/dungle-scrubs/popeye/issues/93)
* **cli:** tool-call gate Hooks see the calling Session's grants id ([#94](https://github.com/dungle-scrubs/popeye/issues/94)) ([ed5ba0c](https://github.com/dungle-scrubs/popeye/commit/ed5ba0c59a184db551df46e1607dc6d3eb8aa166)), closes [#89](https://github.com/dungle-scrubs/popeye/issues/89)
* **kernel:** every Turn opener resolves a Session's bound Turn options ([#95](https://github.com/dungle-scrubs/popeye/issues/95)) ([80cbd5e](https://github.com/dungle-scrubs/popeye/commit/80cbd5e2f3dcc4e440bacee6907939af2be0b3c2)), closes [#88](https://github.com/dungle-scrubs/popeye/issues/88)

## [0.1.7](https://github.com/dungle-scrubs/popeye/compare/popeye-v0.1.6...popeye-v0.1.7) (2026-10-04)


### Added

* **cli:** the delegate Tool runs a child Agent Session in-process ([#90](https://github.com/dungle-scrubs/popeye/issues/90)) ([ca0a2d3](https://github.com/dungle-scrubs/popeye/commit/ca0a2d34161080c32d25c50d25f598ea95515ac8)), closes [#56](https://github.com/dungle-scrubs/popeye/issues/56)
* **cli:** Tool grants vary per Session within one process ([#86](https://github.com/dungle-scrubs/popeye/issues/86)) ([fa3c918](https://github.com/dungle-scrubs/popeye/commit/fa3c9180ef8f19954f29577f12e5ead6d4e78215)), closes [#54](https://github.com/dungle-scrubs/popeye/issues/54)
* **rpc:** create and resume accept an agent field ([#87](https://github.com/dungle-scrubs/popeye/issues/87)) ([383e763](https://github.com/dungle-scrubs/popeye/commit/383e76319cc327558f29db48d175e1fba5fc60a3)), closes [#55](https://github.com/dungle-scrubs/popeye/issues/55)

## [0.1.6](https://github.com/dungle-scrubs/popeye/compare/popeye-v0.1.5...popeye-v0.1.6) (2026-10-04)


### Added

* **cli:** an Agent tools list narrows the session's Tool grant ([#83](https://github.com/dungle-scrubs/popeye/issues/83)) ([354d520](https://github.com/dungle-scrubs/popeye/commit/354d520e57ad25f51386bd51026fca13e5eb70f1)), closes [#53](https://github.com/dungle-scrubs/popeye/issues/53)

## [0.1.5](https://github.com/dungle-scrubs/popeye/compare/popeye-v0.1.4...popeye-v0.1.5) (2026-10-04)


### Added

* **goals:** only the user creates, replaces, resumes, or clears a Goal ([#76](https://github.com/dungle-scrubs/popeye/issues/76)) ([a87da82](https://github.com/dungle-scrubs/popeye/commit/a87da822e515ba8b2677eda59a2b48cd3906ff01))
* reasoning control for base-URL models, including off; live e2e runs with it ([#77](https://github.com/dungle-scrubs/popeye/issues/77)) ([2871cfb](https://github.com/dungle-scrubs/popeye/commit/2871cfb4899bd88f895732f418ead5a41fd29b28))
* report session lifecycle to reflect-intake (POPEYE_REFLECT_INTAKE) ([#63](https://github.com/dungle-scrubs/popeye/issues/63)) ([f383c0c](https://github.com/dungle-scrubs/popeye/commit/f383c0c223f7128827bf3a9f50c2276e7a669ed1))


### Fixed

* **cli:** read provider API keys only for their own API host ([#70](https://github.com/dungle-scrubs/popeye/issues/70)) ([141efce](https://github.com/dungle-scrubs/popeye/commit/141efceb201df35ccfff508f4a27580209a78ba3)), closes [#66](https://github.com/dungle-scrubs/popeye/issues/66)
* **release:** publish installable packages from one guarded release path ([#79](https://github.com/dungle-scrubs/popeye/issues/79)) ([2eaa24f](https://github.com/dungle-scrubs/popeye/commit/2eaa24f13ddeadd19d8748fed1319f4124b7bf38)), closes [#69](https://github.com/dungle-scrubs/popeye/issues/69)
* resume a Session whose ID starts with a dash ([#65](https://github.com/dungle-scrubs/popeye/issues/65)) ([589926d](https://github.com/dungle-scrubs/popeye/commit/589926dee1cea72acbb91000f02e24691a48fcbe))
* **rpc:** deliver steer to a running Turn without waiting for it to settle ([#71](https://github.com/dungle-scrubs/popeye/issues/71)) ([947fa4c](https://github.com/dungle-scrubs/popeye/commit/947fa4cbf3805cb7a706d42c8f1f1e5da4578e1b)), closes [#67](https://github.com/dungle-scrubs/popeye/issues/67)


### Changed

* add Publish workflow with OIDC and manual dispatch ([#60](https://github.com/dungle-scrubs/popeye/issues/60)) ([dc416d6](https://github.com/dungle-scrubs/popeye/commit/dc416d65ec2f83ded9a3a270e9ab93a83877cc76))
* align README and plugin guide with the shipped packages and behavior ([#72](https://github.com/dungle-scrubs/popeye/issues/72)) ([6f4f898](https://github.com/dungle-scrubs/popeye/commit/6f4f89805c6a6c1cc860e88ee388bad084572c5e)), closes [#68](https://github.com/dungle-scrubs/popeye/issues/68)
* **cli:** stop live e2e assertions from depending on model round count and Goals ([#73](https://github.com/dungle-scrubs/popeye/issues/73)) ([3390a08](https://github.com/dungle-scrubs/popeye/commit/3390a0825c1008491c9abbc86d995c5bce733378))
* **deps-dev:** bump effect from 3.22.1 to 3.22.2 ([#35](https://github.com/dungle-scrubs/popeye/issues/35)) ([321d3e4](https://github.com/dungle-scrubs/popeye/commit/321d3e4cbf65518cc9597599ee6c4c17f9e0cd93))
* give the built-CLI usage-export tests the 15s timeout their peers use ([#64](https://github.com/dungle-scrubs/popeye/issues/64)) ([b3615b4](https://github.com/dungle-scrubs/popeye/commit/b3615b44e9a3cb359dae6ba461f13680789c6cd8))

## [0.1.4](https://github.com/dungle-scrubs/popeye/compare/popeye-v0.1.3...popeye-v0.1.4) (2026-09-27)


### Added

* **cli,kernel,plugins:** opt-in gate plugins and test hardening (M8,M9) ([902280c](https://github.com/dungle-scrubs/popeye/commit/902280c8650a2fa07c760711197915f79ad7e46f))
* **cli,kernel:** system-prompt composition, skills allowlist, tool-free isolation (RFC-02 P4) ([8b30ae4](https://github.com/dungle-scrubs/popeye/commit/8b30ae4100b3b3a1eb2ca6818f621bae4ba5d9bd))
* **cli,plugins,protocol:** reload swap and PluginInteractions seam (M5,M7) ([529120c](https://github.com/dungle-scrubs/popeye/commit/529120c6f43a18eb34a4647b991b15f29b5dd0b1))
* **cli:** agent definitions load and --agent starts a persona session ([#52](https://github.com/dungle-scrubs/popeye/issues/52)) ([#57](https://github.com/dungle-scrubs/popeye/issues/57)) ([ff75959](https://github.com/dungle-scrubs/popeye/commit/ff7595933524d4cfc01ec7a062bff433c5fe343e))
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
* **kernel:** TurnDurability deep module (C2 architecture review) ([ba57fc0](https://github.com/dungle-scrubs/popeye/commit/ba57fc085f303c1982ace3c09c66ab56458e65f6))
* **plugins,cli:** GenerationRuntime single owner (M2 04-architecture-deepening) ([03a718a](https://github.com/dungle-scrubs/popeye/commit/03a718af09c16bf6241210be69ea5e91a0927c79))
* **protocol,cli:** SnapshotView deep module (C2 architecture review) ([38d6aa9](https://github.com/dungle-scrubs/popeye/commit/38d6aa9bac50f5cd321229f0efeda5e5e6dd8040))


### Fixed

* **cli,kernel:** close bypasses stalled prompts; single close budget; mid-turn close tests ([cb98123](https://github.com/dungle-scrubs/popeye/commit/cb9812336ba2577145ee000fbe9951755d610821))
* **cli,kernel:** keep compaction summary on replace; filter reload cache; strict grant values; print turnOptions ([7ce6de2](https://github.com/dungle-scrubs/popeye/commit/7ce6de2e0427c97a8f33610821662c0681279c26))
* **cli:** context-window rides provider layer; strict empty grant lists; honest RPC refusal ([2d2b887](https://github.com/dungle-scrubs/popeye/commit/2d2b887d5d042d81322bd3947a5b728906040291))


### Changed

* **cli:** built-bin RPC close probe returns terminal closed shape ([f158f27](https://github.com/dungle-scrubs/popeye/commit/f158f273d85ca0f1f8d578ce8869de38773cd0fe))
* **cli:** delete heads/shared facade; import HeadWire directly ([759af1e](https://github.com/dungle-scrubs/popeye/commit/759af1e52a4834087b018d61966cc5413ed133ea))
* **cli:** delete tool-gate facade and ToolGateService aliases ([5b5e0d8](https://github.com/dungle-scrubs/popeye/commit/5b5e0d805ca3f9d4d5f836ba3b35b9a4bcf6964f))
* **cli:** document ToolInvocationPipeline alias retain ([d0d3cf2](https://github.com/dungle-scrubs/popeye/commit/d0d3cf2edba91dbe9c8838387e55ab8be6617f8a))
* **cli:** shared scripted head drivers, capture writer, hcn cli fixture ([3049579](https://github.com/dungle-scrubs/popeye/commit/3049579eea7178826ba126acead01f685ac0eb94))
* refresh deep-module headers for RpcHead and Plugin seams ([cc965b7](https://github.com/dungle-scrubs/popeye/commit/cc965b7ed73b07bc77eb8e7a2dc5643ec09e37f3))
* **release:** public-release readiness - scope rename, templates, controls, automation ([#26](https://github.com/dungle-scrubs/popeye/issues/26)) ([1d28d16](https://github.com/dungle-scrubs/popeye/commit/1d28d1696f2166e69395e77fff5915a0e492289e))
* **release:** sync versions to shipped registry state ([#36](https://github.com/dungle-scrubs/popeye/issues/36)) ([703668c](https://github.com/dungle-scrubs/popeye/commit/703668cf9c8f3fda45af46cb98a8c4f5a27d85a0))
