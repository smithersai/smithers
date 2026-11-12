---
title: Literal check markers and Markdown links
status: completed
area: sdk
owner: codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/4741
---

String entries in `Checks.includes`, `Checks.excludes` and `Checks.leakage`
are literal; intentional patterns use `RegExp` values. The character suite's
YAML regex uses an explicit pattern object. URL checks recognize Markdown
wrappers and parenthesized targets without stripping URL-owned suffixes.

The new check regressions failed against the original implementation.
Validation: 710 scorer test runs across SQLite and PostgreSQL, 100% combined
coverage; scorer lint, scorer and evaluation-package typechecks, and all 31
character tests pass. `pnpm docs:sync` and `pnpm docs:check` pass, including
52 published-package tarballs.

The broader offline agent baseline still differs by 26 observations.
An unchanged copy of the parent revision reproduces the same 20 differing
expected/observed results and six missing observations.
