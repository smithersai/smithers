---
title: Step cache conflict diagnosis and ledger retention
status: done
area: flows
owner: codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/4554
---

Correct the troubleshooting distinction between provenance and head conflicts,
qualify the README ledger-retention guarantee, and remove the publication test
that spies on internal encoders and its unused helper.

Library catalog entry: `@smthrs/step-cache`. No new libraries or runtime changes.

Validation:

- The two new documentation guards fail against the original pages; the SQL
  witness reaches those guards successfully.
- The SQLite/PostgreSQL package matrix passes all `602` tests with `100%`
  statement, branch, function and line coverage. Typecheck and lint pass.
- After the review cleanups and rebase, the two affected test files pass all
  `109` tests; typecheck and lint pass again.
- Site API and LLM projections, redirect-map generation/checking and the docs
  checks for all `52` published package tarballs pass. Generation produces no
  tracked changes. The `pnpm docs:sync` and `pnpm docs:check` flow invocations
  cannot discover their flow without the `smithers-jj-export` native helper;
  their existing documentation modules were checked directly.
- Astra and Fable reviews pass; the wording and redundant-assertion findings
  are resolved.
