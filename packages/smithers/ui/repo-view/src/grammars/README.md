# VibeLang grammar

`VibeLang.tmLanguage.json` is copied byte for byte from
[`smithersai/vibelang`](https://github.com/smithersai/vibelang/blob/3ad97368713b9a1fab1fa408388a017687aa7431/editors/vscode/syntaxes/VibeLang.tmLanguage.json),
commit `3ad97368713b9a1fab1fa408388a017687aa7431` (main, 2026-10-25).
Its SHA-256 is `a9d0e7e47b043ac90372d54d5e7146ff8ccb1352d1c7a611bc586ecec5e26d73`;
`test/vibe-grammar-source.test.ts` pins those bytes to catch local drift.

VibeLang's `editors/vscode/scripts/derive-grammar.mjs` derives it from
microsoft/TypeScript-TmLanguage (MIT; the JSON records the upstream revision).
`ThirdPartyNotices.txt` retains the existing Microsoft copyright and MIT notice;
VibeLang main no longer contains a copy of that file. The JSDoc injection
grammar is not included.

To refresh, resolve smithersai/vibelang main to a commit, copy
`editors/vscode/syntaxes/VibeLang.tmLanguage.json` from that commit without
reformatting, and update this revision and the test's hash. Check the upstream
license and preserve `ThirdPartyNotices.txt` when refreshing.

`../vibe.ts` registers it for `.vibe` files and pre-rename `.effeck` files,
and loads it lazily on the first VibeLang file. The repository views entry in
`docs/libraries.md` supplies the existing Shiki renderer; no new library is needed.
