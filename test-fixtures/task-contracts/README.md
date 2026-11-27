# Vendored task-contract fixtures

`text-to-speech.json` is a byte-identical copy of `contracts/fixtures/task-contracts/text-to-speech.json` from
the inderun repository (https://github.com/independo-gmbh/inderun) at commit `99ce979`
(branch `feat/311-speech-controls`, contract 1.1).

This is the **one** copy in this repository. The Vitest conformance test (`src/conformance.test.ts`) and the
Android and iOS native tests all read it from here; do not duplicate it. Refresh it by copying the file again from
a newer inderun commit and updating the commit above. Not published: it sits outside the npm `files` allowlist.
