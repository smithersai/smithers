---
title: Deterministic personal draft delete race
status: blocked
area: app-tests
owner: codex-personalflows-race
updated: 2026-10-24
links: [../features/flows.md]
---

Force the losing delete to pause before its initial read and before its conditional update using Effect Deferred and the injected SQL statement transformer. Both requests use the real Postgres service and ChatApi handler. Assert the winner commits, the draft is gone, and the loser returns 404 not_found with matching telemetry. No production behavior or public API changes; no new library. The catalog's Effect-first service rule applies: existing Effect SQL and Deferred supply the gate.

The standalone file also checks that an agent's answer is refused without changing the draft. That person-only branch previously relied on PersonOnly.test.ts for coverage, so the focused file alone could not reach 100%.

Validation uses Node 26.5.0 and the unchanged 100% thresholds. The first run on the shared database timed out in the existing beforeEach hook. A private compose fixture (project personalflows-race, Postgres 55492 and Electric 30492) removes that shared database contention; both dependencies remain real. A subsequent run exposed the missing person-only assertion before it was added.

- Thirty consecutive `pnpm test --maxWorkers=2 worker/PersonalFlows.test.ts --coverage.include=worker/PersonalFlows.ts --coverage.reporter=text --coverage.reporter=json-summary --coverage.reportsDirectory=<per-run directory>` runs pass: 39 tests each, 1,170 total. Every run covers statements 391/391, branches 234/234, functions 81/81 and lines 321/321: all 100%. Each run has its own log and coverage-summary.json, independently checked against covered/total counts; no retries.
- `pnpm --dir apps/mvp typecheck` passes all four configurations with zero errors.
- `pnpm exec smithers-build test '//apps/mvp:importRules'` passes (one target executed, zero failures).
- Astra review: no findings. Fable review could not start because all accounts were unavailable; no review result claimed.
- `pnpm test --maxWorkers=2 --coverage.reporter=text --coverage.reporter=json-summary --coverage.reportsDirectory=/tmp/personalflows-race-evidence/full`, wrapped by `full-gate.sh` in the shared full-suite lock: 338 files passed, four existing skipped; 4,366 tests passed, three existing expected failures and ten existing skipped. PersonalFlows.ts is 100% in all four metrics. The full gate exits 1 solely because the unchanged `src/features/terminal/actions.ts:145` leaves one branch uncovered (107/108 there). Overall statements 23,830/23,830, functions 7,117/7,117 and lines 20,586/20,586 are 100%; branches are 13,350/13,351 (99.99%). The lock was removed on exit. This is a coverage blocker, not a load timeout; no retry or unrelated terminal change was made.

Receipts: `/tmp/personalflows-race-evidence/` (30-runs.json, run-01 through run-30 coverage directories and logs, typecheck.log, importRules.log, full-gate.sh and full.log). No production or public API change; package API documentation and a changeset are not applicable.

The deterministic delete fix and its focused/static proof are complete. Delivery remains blocked on the unrelated full-app coverage gap; do not claim the full gate passed.
