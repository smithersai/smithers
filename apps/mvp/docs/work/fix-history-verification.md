---
title: History copy isolation and verification regressions
status: done
area: history
owner: codex
updated: 2026-10-21
links: []
---

Fixed all three findings using the existing Effect SQL, database and durable engine libraries; no new dependencies.

- PostgreSQL copies refuse external sequence dependencies before inserting rows, and validate again after installing constraints and triggers. Real PostgreSQL default and populated check cases assert refusal, schema rollback and an unchanged external sequence position.
- The report builder marks zero or partial replay divergent whenever recorded successes remain unreplayed, even without a would-execute receipt. Its refusal no longer invents a dispatch.
- Bulk verification reports `unverified` when attempts fail without proven divergence; the CLI exits with `verify_incomplete` and retains each refusal. Real timeout and PostgreSQL CLI cases cover this.

Regression proof: both external-sequence cases originally succeeded incorrectly. Zero and partial replay reports, and a bulk timeout, originally returned `consistent`; all five targeted cases pass after the fixes. The report builder tests use dispatch receipts directly; an attempted full-runtime early-failure fixture stalled during terminal finalization and was not retained.

Validation on Node 26.5.0 after `pnpm install --frozen-lockfile --offline`, using a clone-local PostgreSQL server and `cargo build --locked --offline -p smithers-ffi --bin smithers-jj-export`:

- From `packages/smithers`: `pnpm exec vitest run --coverage.enabled=false test/StoreCopy.test.ts test/HistoryVerify.test.ts test/HistoryVerifyDispatch.test.ts test/HistoryPostgres.test.ts test/HistoryProjection.test.ts test/HistoryCommands.test.ts`. Original files: 55 passed, 1 failed; final files: 59 passed, 1 failed. Both fail the unchanged bulk code-drift case, where both resumes return `code_drift` instead of the expected divergent reports. No new failures in the final comparison.
- Targeted regression selection: 5 passed. The PostgreSQL verification case, including the new real CLI refusal check, also passes alone and in the final suite run.
- Package `pnpm exec tsc -p tsconfig.test.json --noEmit`: passed. `apps/mvp` `pnpm exec tsc --noEmit`: passed before and after.
- ESLint and dprint over the changed source/test files: passed.
- `pnpm exec smithers-build test '//packages/smithers:importRules'`: unavailable before and after (`unknown_label`); this package declares no such target. No fixed sleeps or mocks were added.
- Codex Astra review: no findings.
- E2E: not run (mini clone).
