# Changelog

## [0.2.0](https://github.com/dungle-scrubs/popeye/compare/popeye-kernel-v0.1.7...popeye-kernel-v0.2.0) (2026-10-05)


### ⚠ BREAKING CHANGES

* **kernel:** the kernel no longer exports TurnOptionsResolver or keepTurnOptions, and TurnOrchestratorService.openTurn loses its resolveOptions parameter (onAdmitted moves from the sixth position to the fifth). Direct openTurn callers now get Branch settings applied (a journaled model beats the request model) at the cost of one more Branch read per Turn, and Goal continuations re-resolve options on each Turn, so a set-model or set-thinking recorded during a Goal chain applies to the next continuation.

### Fixed

* **deps:** upgrade pi-ai to 1.0.2 ([#78](https://github.com/dungle-scrubs/popeye/issues/78)) ([54ee9fa](https://github.com/dungle-scrubs/popeye/commit/54ee9fad4e23fd5eb278f2a1c85da477023f282a))
* **kernel:** every Turn opener resolves a Session's bound Turn options ([#95](https://github.com/dungle-scrubs/popeye/issues/95)) ([80cbd5e](https://github.com/dungle-scrubs/popeye/commit/80cbd5e2f3dcc4e440bacee6907939af2be0b3c2)), closes [#88](https://github.com/dungle-scrubs/popeye/issues/88)

## [0.1.7](https://github.com/dungle-scrubs/popeye/compare/popeye-kernel-v0.1.6...popeye-kernel-v0.1.7) (2026-10-04)


### Added

* **cli:** the delegate Tool runs a child Agent Session in-process ([#90](https://github.com/dungle-scrubs/popeye/issues/90)) ([ca0a2d3](https://github.com/dungle-scrubs/popeye/commit/ca0a2d34161080c32d25c50d25f598ea95515ac8)), closes [#56](https://github.com/dungle-scrubs/popeye/issues/56)
* **cli:** Tool grants vary per Session within one process ([#86](https://github.com/dungle-scrubs/popeye/issues/86)) ([fa3c918](https://github.com/dungle-scrubs/popeye/commit/fa3c9180ef8f19954f29577f12e5ead6d4e78215)), closes [#54](https://github.com/dungle-scrubs/popeye/issues/54)
* **rpc:** create and resume accept an agent field ([#87](https://github.com/dungle-scrubs/popeye/issues/87)) ([383e763](https://github.com/dungle-scrubs/popeye/commit/383e76319cc327558f29db48d175e1fba5fc60a3)), closes [#55](https://github.com/dungle-scrubs/popeye/issues/55)

## [0.1.6](https://github.com/dungle-scrubs/popeye/compare/popeye-kernel-v0.1.5...popeye-kernel-v0.1.6) (2026-10-04)


### Fixed

* **kernel:** publish thinking Progress while the model reasons ([#84](https://github.com/dungle-scrubs/popeye/issues/84)) ([21568fc](https://github.com/dungle-scrubs/popeye/commit/21568fc1428f902c53d4a881a5ec5c5000b025fb)), closes [#74](https://github.com/dungle-scrubs/popeye/issues/74)

## [0.1.5](https://github.com/dungle-scrubs/popeye/compare/popeye-kernel-v0.1.4...popeye-kernel-v0.1.5) (2026-10-04)


### Added

* reasoning control for base-URL models, including off; live e2e runs with it ([#77](https://github.com/dungle-scrubs/popeye/issues/77)) ([2871cfb](https://github.com/dungle-scrubs/popeye/commit/2871cfb4899bd88f895732f418ead5a41fd29b28))
* report session lifecycle to reflect-intake (POPEYE_REFLECT_INTAKE) ([#63](https://github.com/dungle-scrubs/popeye/issues/63)) ([f383c0c](https://github.com/dungle-scrubs/popeye/commit/f383c0c223f7128827bf3a9f50c2276e7a669ed1))


### Fixed

* **rpc:** deliver steer to a running Turn without waiting for it to settle ([#71](https://github.com/dungle-scrubs/popeye/issues/71)) ([947fa4c](https://github.com/dungle-scrubs/popeye/commit/947fa4cbf3805cb7a706d42c8f1f1e5da4578e1b)), closes [#67](https://github.com/dungle-scrubs/popeye/issues/67)


### Changed

* **deps-dev:** bump effect from 3.22.1 to 3.22.2 ([#35](https://github.com/dungle-scrubs/popeye/issues/35)) ([321d3e4](https://github.com/dungle-scrubs/popeye/commit/321d3e4cbf65518cc9597599ee6c4c17f9e0cd93))

## [0.1.4](https://github.com/dungle-scrubs/popeye/compare/popeye-kernel-v0.1.3...popeye-kernel-v0.1.4) (2026-09-27)


### Added

* **cli,kernel,plugins:** opt-in gate plugins and test hardening (M8,M9) ([902280c](https://github.com/dungle-scrubs/popeye/commit/902280c8650a2fa07c760711197915f79ad7e46f))
* **cli,kernel:** system-prompt composition, skills allowlist, tool-free isolation (RFC-02 P4) ([8b30ae4](https://github.com/dungle-scrubs/popeye/commit/8b30ae4100b3b3a1eb2ca6818f621bae4ba5d9bd))
* **cli:** HeadWire deep module (C1 architecture review) ([ba57fc0](https://github.com/dungle-scrubs/popeye/commit/ba57fc085f303c1982ace3c09c66ab56458e65f6))
* **cli:** session-keyed ToolRegistry view via startup generation (M3) ([8113a55](https://github.com/dungle-scrubs/popeye/commit/8113a55e8cc7391b959d2fa6f709ff382db5bfc0))
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


### Fixed

* **cli,kernel:** close bypasses stalled prompts; single close budget; mid-turn close tests ([cb98123](https://github.com/dungle-scrubs/popeye/commit/cb9812336ba2577145ee000fbe9951755d610821))
* **cli,kernel:** keep compaction summary on replace; filter reload cache; strict grant values; print turnOptions ([7ce6de2](https://github.com/dungle-scrubs/popeye/commit/7ce6de2e0427c97a8f33610821662c0681279c26))
* **cli:** context-window rides provider layer; strict empty grant lists; honest RPC refusal ([2d2b887](https://github.com/dungle-scrubs/popeye/commit/2d2b887d5d042d81322bd3947a5b728906040291))


### Changed

* **kernel:** delete Turns shim; Driver depends on TurnOrchestrator ([ca7dbe7](https://github.com/dungle-scrubs/popeye/commit/ca7dbe732584608d71e3ce9e85489d30651dfd45))
* **release:** lockstep versioning across packages; document policy ([#37](https://github.com/dungle-scrubs/popeye/issues/37)) ([5b72d4d](https://github.com/dungle-scrubs/popeye/commit/5b72d4d945fc583a2eeb89bb96cd8133a6871af8))
* **release:** public-release readiness - scope rename, templates, controls, automation ([#26](https://github.com/dungle-scrubs/popeye/issues/26)) ([1d28d16](https://github.com/dungle-scrubs/popeye/commit/1d28d1696f2166e69395e77fff5915a0e492289e))
* **release:** sync versions to shipped registry state ([#36](https://github.com/dungle-scrubs/popeye/issues/36)) ([703668c](https://github.com/dungle-scrubs/popeye/commit/703668cf9c8f3fda45af46cb98a8c4f5a27d85a0))
