# Changelog

## [0.1.4](https://github.com/dungle-scrubs/popeye/compare/popeye-kernel-v0.1.3...popeye-kernel-v0.1.4) (2026-09-26)


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
