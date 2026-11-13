---
title: Rework once serialization recovery
status: done
area: flow
owner: codex-fix-amend-d847d43b-081245
updated: 2026-10-22
links:
  - packages/smithers/flows/flow/src/Action/once.ts
  - packages/smithers/flows/flow/test/IdempotencyCompatibility.test.ts
---

Uses the library catalog durable-workflow entry, `@smthrs/flow`.
An active-key lookup can adopt a persisted object without acquiring the writer
permit; a miss rechecks under the permit before writing. This preserves local
serialization without making recovery wait on a dead incarnation. Names and
keys remain out of once telemetry.

Amends bounced d847d43bdb74 on parent 0d66db742e1e. The added attempt `site`
and three-element key preimage changed persisted identities for explicit
parent scopes. Restore the parent's runtime derivation exactly: explicit
parent scope, including an empty string, takes precedence over `includeAttempt`.
No existing pinned key changes. Ten new golden keys were captured using the
parent's production files; that regression fails on the bounced implementation.
The engine's ActionIdentityGaps suite likewise fails on the bounced change
(1 failure, 8 passes) and passes on the parent (9 passes).

Mac mini, Node 26.5.0, `pnpm install --frozen-lockfile --offline`:

- Flow `pnpm exec vitest run --maxWorkers=2`: 930 tests in 71 files pass;
  statement, branch, function and line coverage all 100%.
- Engine, same command: 614 tests in 76 files pass; all four coverage measures
  100%.
- `pnpm exec tsc --noEmit` in apps/mvp: passes with the parent's production
  files and with the amendment.
- Targeted dprint and production ESLint pass. None of flow, engine or
  engine-store declares an importRules target.
- Flow `pnpm exec tsc -p tsconfig.test.json --noEmit` reports the four
  `number | undefined` errors in unchanged `RetryPolicy.test.ts:657-658`.
  Repeating it with the parent's production files produces identical output;
  no errors in amended files.
- Astra review: no actionable findings.

Engine-store's first run exposed the clone's missing native filesystem helper.
`cargo build --offline --locked -p smithers-ffi --bin smithers-jj-export` built
it locally. The full SQLite rerun passes all 2,181 tests in 217 files, but its
coverage gate fails (99.95% statements/lines, 99.8% branches, 99.85% functions).

The standard `pnpm run test:matrix --maxWorkers=2` passes all 2,181 SQLite tests;
PostgreSQL passes 2,180 and fails `HeartbeatReceipts.test.ts:68` (the persisted
status is still `running` after the receipt finalizer ends, rather than
`cancelled`). Combined coverage reaches 100% statements, lines and functions,
but 99.97% branches, missing `RunDriver.ts:2765`. The matrix gate remains red;
no thresholds were changed.

`pnpm run test:matrix test/HeartbeatReceipts.test.ts --coverage.enabled=false
--maxWorkers=2` with the parent's production files reproduces the exact
PostgreSQL failure (SQLite 4/4, PostgreSQL 3/4). That test does not call
`Action.once` or `Action.idempotencyKey`. Keep that separate heartbeat issue
out of this amendment. No Playwright tests ran.
