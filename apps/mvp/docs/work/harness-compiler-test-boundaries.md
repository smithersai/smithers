---
title: Test cell compiler failures through parser injection
status: done
area: sdk
owner: Codex
updated: 2026-11-13
links: [https://github.com/smithersai/smithers/issues/4818]
---

Uses the library catalog entry `@smthrs/harness` and its existing cell validator.

Replace the parser module mock with an optional parser dependency on
`CellValidation.validate`, keeping Babel as the default. Remove the extraction
test that claims top-level return semantics while asserting only text order;
`ReplRealm.test.ts` already tests the real realm's top-level return rejection.

Validation:

- Seven compiler-failure regression cases fail against the previous validator
  and pass with parser injection.
- Full harness suite: 2,690 passed, 3 skipped; 100% statements, branches,
  functions and lines.
- Source and test VibeLang typechecks, scoped source ESLint, package formatting
  and circular-import checks pass.
- Generated API and LLM documentation drift checks and all 52 published package
  tarball checks pass.
- Astra and Fable reviews: no blocking findings. The delegation assertion checks
  the source and language options without duplicating every parser option.

Existing validation limits: the package check stops at a stale realm bundle,
and package lint flags an ignored generated declaration; both reproduce with
the original source and tests. The docs flow wrappers lack their native helper,
so their underlying modules were checked directly. The broader API docs suite
retains an unrelated flows quickstart release-pin failure.
