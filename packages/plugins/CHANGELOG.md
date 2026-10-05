# Changelog

## [0.2.0](https://github.com/dungle-scrubs/popeye/compare/popeye-plugins-v0.1.7...popeye-plugins-v0.2.0) (2026-10-05)


### Fixed

* **cli:** /reload performs a real Generation swap ([#96](https://github.com/dungle-scrubs/popeye/issues/96)) ([a64954e](https://github.com/dungle-scrubs/popeye/commit/a64954e0e07ea21912abe1f787527be304ada6fa)), closes [#93](https://github.com/dungle-scrubs/popeye/issues/93)

## [0.1.7](https://github.com/dungle-scrubs/popeye/compare/popeye-plugins-v0.1.6...popeye-plugins-v0.1.7) (2026-10-04)


### Changed

* **popeye-plugins:** Synchronize popeye versions

## [0.1.6](https://github.com/dungle-scrubs/popeye/compare/popeye-plugins-v0.1.5...popeye-plugins-v0.1.6) (2026-10-04)


### Changed

* **popeye-plugins:** Synchronize popeye versions

## [0.1.5](https://github.com/dungle-scrubs/popeye/compare/popeye-plugins-v0.1.4...popeye-plugins-v0.1.5) (2026-10-04)


### Fixed

* **release:** publish installable packages from one guarded release path ([#79](https://github.com/dungle-scrubs/popeye/issues/79)) ([2eaa24f](https://github.com/dungle-scrubs/popeye/commit/2eaa24f13ddeadd19d8748fed1319f4124b7bf38)), closes [#69](https://github.com/dungle-scrubs/popeye/issues/69)


### Changed

* **deps-dev:** bump effect from 3.22.1 to 3.22.2 ([#35](https://github.com/dungle-scrubs/popeye/issues/35)) ([321d3e4](https://github.com/dungle-scrubs/popeye/commit/321d3e4cbf65518cc9597599ee6c4c17f9e0cd93))

## [0.1.4](https://github.com/dungle-scrubs/popeye/compare/popeye-plugins-v0.1.3...popeye-plugins-v0.1.4) (2026-09-27)


### Added

* **cli,kernel,plugins:** opt-in gate plugins and test hardening (M8,M9) ([902280c](https://github.com/dungle-scrubs/popeye/commit/902280c8650a2fa07c760711197915f79ad7e46f))
* **cli,plugins,protocol:** reload swap and PluginInteractions seam (M5,M7) ([529120c](https://github.com/dungle-scrubs/popeye/commit/529120c6f43a18eb34a4647b991b15f29b5dd0b1))
* **kernel,plugins:** session-keyed Tool views and import timeout (M2,M6) ([2bd58e3](https://github.com/dungle-scrubs/popeye/commit/2bd58e3f8c087fe0824ac168808c253bcfb1ae22))
* **plugins,cli:** GenerationRuntime single owner (M2 04-architecture-deepening) ([03a718a](https://github.com/dungle-scrubs/popeye/commit/03a718af09c16bf6241210be69ea5e91a0927c79))
* **plugins:** generation lease primitive checkout (M1) ([c8cfb80](https://github.com/dungle-scrubs/popeye/commit/c8cfb8026c5a7a75c8113683b872ef232bb08efb))
* **plugins:** PluginPipeline deep module (C3 architecture review) ([05b6666](https://github.com/dungle-scrubs/popeye/commit/05b66666c6a35b94209dd089dd886c5f5ee18c1e))


### Changed

* **plugins:** delete generation shim; makeGenerationRuntime is the one constructor ([983366e](https://github.com/dungle-scrubs/popeye/commit/983366ef292cb831dbc08919ada2e52b71d68533))
* refresh deep-module headers for RpcHead and Plugin seams ([cc965b7](https://github.com/dungle-scrubs/popeye/commit/cc965b7ed73b07bc77eb8e7a2dc5643ec09e37f3))
* **release:** lockstep versioning across packages; document policy ([#37](https://github.com/dungle-scrubs/popeye/issues/37)) ([5b72d4d](https://github.com/dungle-scrubs/popeye/commit/5b72d4d945fc583a2eeb89bb96cd8133a6871af8))
* **release:** public-release readiness - scope rename, templates, controls, automation ([#26](https://github.com/dungle-scrubs/popeye/issues/26)) ([1d28d16](https://github.com/dungle-scrubs/popeye/commit/1d28d1696f2166e69395e77fff5915a0e492289e))
* **release:** sync versions to shipped registry state ([#36](https://github.com/dungle-scrubs/popeye/issues/36)) ([703668c](https://github.com/dungle-scrubs/popeye/commit/703668cf9c8f3fda45af46cb98a8c4f5a27d85a0))
