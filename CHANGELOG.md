## [1.1.0](https://github.com/independo-gmbh/capacitor-inderun/compare/v1.0.0...v1.1.0) (2026-10-04)

### Features 🚀

* bridge checkCapabilities() for provider availability ([3c44262](https://github.com/independo-gmbh/capacitor-inderun/commit/3c44262382ad36b109894e856a747f014546e57c))
* bridge IndeRun Mode 2 streaming (closes [#149](https://github.com/independo-gmbh/capacitor-inderun/issues/149)) ([#23](https://github.com/independo-gmbh/capacitor-inderun/issues/23)) ([d4fa341](https://github.com/independo-gmbh/capacitor-inderun/commit/d4fa3414bdfa49e150f321609f3deb60a21ba3ad))
* **web:** register the web on-device providers from configure() ([40c30ee](https://github.com/independo-gmbh/capacitor-inderun/commit/40c30ee5db97d37d72cee841f6c3fb56d4d71074))

### Bug Fixes 🛠️

* **deps:** track inderun 0.3.2 on all three platforms ([1e54a0b](https://github.com/independo-gmbh/capacitor-inderun/commit/1e54a0b4413578921fd6d8532afdc193f7ae78f9))
* **deps:** track the stable inderun 0.3.0 release on all three platforms ([82cde1c](https://github.com/independo-gmbh/capacitor-inderun/commit/82cde1c7ef476d273e7dec87bf35a45c7b2fd7c6))
* **example-app:** hide elements whose display is set by a class ([e191124](https://github.com/independo-gmbh/capacitor-inderun/commit/e191124366e9dc321a06dd78a8360dc1ebb0be5b))
* **ios:** coerce encoded payloads to JSObject instead of casting ([d7e56d4](https://github.com/independo-gmbh/capacitor-inderun/commit/d7e56d4f3b3ea3a6df574f32bde93c97bba7384f)), closes [#if](https://github.com/independo-gmbh/capacitor-inderun/issues/if)
* **ios:** declare the iOS 16 floor the IndeRun dependency requires ([05ec452](https://github.com/independo-gmbh/capacitor-inderun/commit/05ec4528151c388ee0bde183d26d33e01b3f41e6))
* **ios:** decode the OpenAI endpoint from the endpointUrl wire key ([#22](https://github.com/independo-gmbh/capacitor-inderun/issues/22)) ([6073c37](https://github.com/independo-gmbh/capacitor-inderun/commit/6073c37daa6e206f3593996e44806ddaf21107a5))
* make the plugin consumable by a Capacitor app on both platforms ([78c58b4](https://github.com/independo-gmbh/capacitor-inderun/commit/78c58b42a50144bd241cbdda9a9b41f87592ac4b)), closes [#if](https://github.com/independo-gmbh/capacitor-inderun/issues/if)
* **release:** only treat an upper-case, colon-terminated footer as a breaking change ([4be1fe3](https://github.com/independo-gmbh/capacitor-inderun/commit/4be1fe3eab499df9a494f686401c5e1c5835b90e))

### Documentation 📚

* **example-app:** showcase streaming, provider routing and failure surfaces ([c328675](https://github.com/independo-gmbh/capacitor-inderun/commit/c32867579adc81a7ee1937768db4ba0aa4b92227))
* lead with on-device execution and cloud fallback ([c6307b7](https://github.com/independo-gmbh/capacitor-inderun/commit/c6307b71c446e08b73d0a545c71d118ad25f39f3))
* **readme:** state the supported inderun version and retire the prerelease rule ([b9e0183](https://github.com/independo-gmbh/capacitor-inderun/commit/b9e01835fae63f65a7f3aaecfc15da1bc4be3ee1))

### Miscellaneous Chores 🛠️

* **deps-dev:** bump @semantic-release/changelog from 6.0.3 to 7.0.0 ([c892b5f](https://github.com/independo-gmbh/capacitor-inderun/commit/c892b5feccaf2751a140c026d8a31bb3bab4d4a6))
* **deps-dev:** bump @semantic-release/git from 10.0.1 to 11.0.1 ([14d1e71](https://github.com/independo-gmbh/capacitor-inderun/commit/14d1e71f17e2c6ce557f5491ae5875828fe082e8))
* **deps-dev:** bump @types/node ([cd55a96](https://github.com/independo-gmbh/capacitor-inderun/commit/cd55a9661d8c427fe9489bb70c6c006f7d5e6f4d))
* **deps-dev:** bump vitest from 4.1.11 to 5.0.2 ([0ac08ac](https://github.com/independo-gmbh/capacitor-inderun/commit/0ac08ac49f60d15d9530e7e52613c2be1ec7d88b))
* **deps:** bump actions/setup-java ([191bb4f](https://github.com/independo-gmbh/capacitor-inderun/commit/191bb4f9e19f6c52ac3b95762542e0f4384d2189))
* **deps:** bump org.json:json from 20260522 to 20260814 in /android ([85e8136](https://github.com/independo-gmbh/capacitor-inderun/commit/85e81363a1501be73293fc9f137767fde1f36a2a))
* **deps:** bump the gradle-routine group in /android with 6 updates ([c779b44](https://github.com/independo-gmbh/capacitor-inderun/commit/c779b440ac299117db3590783a66f1c696b88a60))
* **deps:** bump the npm-routine group across 1 directory with 2 updates ([a1858cb](https://github.com/independo-gmbh/capacitor-inderun/commit/a1858cb50908025c9965565797c5c365ac04c05e))
* **deps:** bump vitest to ^4.1.11 ([5ecf9d1](https://github.com/independo-gmbh/capacitor-inderun/commit/5ecf9d1366fe6f771a81197a74fd72d6df44feeb)), closes [6-#8](https://github.com/independo-gmbh/6-/issues/8) [#9](https://github.com/independo-gmbh/capacitor-inderun/issues/9)
* **deps:** refresh fast-uri, undici and js-yaml to patched versions ([6b4125a](https://github.com/independo-gmbh/capacitor-inderun/commit/6b4125a4c7cd69d76e8642553204ac243c80c51e)), closes [2-#5](https://github.com/independo-gmbh/2-/issues/5) [#12](https://github.com/independo-gmbh/capacitor-inderun/issues/12) [#9](https://github.com/independo-gmbh/capacitor-inderun/issues/9)
* **deps:** stop Dependabot bumping inderun, @types/node majors and Capacitor core ([561ae29](https://github.com/independo-gmbh/capacitor-inderun/commit/561ae29ec7ded6014805a83f60f3bc792a270459)), closes [#27](https://github.com/independo-gmbh/capacitor-inderun/issues/27)

### Code Refactors 🏗️

* **web:** type the createIndeRunWeb options from the SDK's own interface ([13796ac](https://github.com/independo-gmbh/capacitor-inderun/commit/13796ac60bc8be61b38365ced014b5d991418841))

### Tests 🛠️

* cover nested route-plan diagnostics across the JSON bridge ([4b6df0d](https://github.com/independo-gmbh/capacitor-inderun/commit/4b6df0da8c309e8aa85ea9ec4b6ddbd6bd341618))

## 1.0.0 (2026-08-17)

### Features 🚀

* seed standalone Capacitor bridge from the IndeRun monorepo ([91f8a5a](https://github.com/independo-gmbh/capacitor-inderun/commit/91f8a5a6499f79d1d3f32a0a9428a64130097aaf)), closes [#73](https://github.com/independo-gmbh/capacitor-inderun/issues/73)

### Bug Fixes 🛠️

* rename release.config.js to .cjs for ESM compatibility ([f073278](https://github.com/independo-gmbh/capacitor-inderun/commit/f073278852535f70c61c5260963ef620a159d82b)), closes [#14](https://github.com/independo-gmbh/capacitor-inderun/issues/14)

### Miscellaneous Chores 🛠️

* **deps-dev:** bump typescript from 6.0.3 to 7.0.2 ([f1e4243](https://github.com/independo-gmbh/capacitor-inderun/commit/f1e424316f38dac5a6c94da7c6d46f627a264e75))
* **deps:** bump actions/setup-node in the actions-routine group ([53d53e6](https://github.com/independo-gmbh/capacitor-inderun/commit/53d53e6a46e30d2ab0d67b0bf975b554e17d7b23))
* initialize repository ([987da36](https://github.com/independo-gmbh/capacitor-inderun/commit/987da36d27a2b4c6b588b3dc29cd6bcea7763f25))
* prep repo for first publish on inderun 0.2.2 ([4ed3309](https://github.com/independo-gmbh/capacitor-inderun/commit/4ed3309f916e0f703bd80bfde71a61baf6bf6b00))
