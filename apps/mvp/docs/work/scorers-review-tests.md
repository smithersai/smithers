---
title: Scorer error, concurrency and retention contracts
status: done
area: sdk
owner: codex-scorers-review
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4742
---

Used the library catalog's `@smthrs/scorers` and `@smthrs/database` contracts.
Replaced the affected-row module mock with fault injection through the real SQL
client, documented explicit retention, and strengthened error and concurrency
tests. Public behavior and exports are unchanged.

Validation: 724 SQLite/PostgreSQL tests pass with 100% statements, branches,
functions and lines; package typecheck and lint pass. Mutation checks show the
old assertions accept a scorer defect and a concurrent fallback while the new
assertions reject both. The SQL regression rejects a missing claim-count guard.
The documentation regression fails against the obsolete queue and retention text.

The Node subprocess suite preloads the absolute URL resolved from
`vibelang/register`; its existing Quickstart child also fails on the unmodified
base without that loader. `pnpm docs:sync` and `pnpm docs:check` pass, including
all 52 published-package tarballs. API and LLM projections are regenerated.
