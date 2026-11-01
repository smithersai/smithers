---
title: First remote-run shapes after farm reset
status: done
area: testing
owner: Codex GPT-6.1 Sol (shape-400)
updated: 2026-11-01
links: []
---

The combined unit/e2e farm command selected a private SQL database but left `TestDatabase.electricUrl` on shared Electric. Its 400 body said the generated engine table did not exist. The helper now sets `TEST_ELECTRIC_PORT` with the app's `ELECTRIC_URL`; container configuration is unchanged. This is test infrastructure, not a product plugin.

Regression first: the running-farm endpoint assertion failed on the old helper (expected slot port, received shared port). Before: RemoteRuns 7 failed, 35 passed. After: three independent fresh resets each pass RemoteRuns 42/42, endpoints 27/27 and diagnostics 5/5. The direct run passes RemoteRuns and endpoints 69/69. The diagnostic helper has 100% statement, branch, function and line coverage; all four app typechecks, changed-file ESLint, ShellCheck and five farm contract tests pass. Codex Astra review found no actionable issues. Fable is not available through this session's review tools; no Fable review is claimed.

`firstShape` now surfaces Electric's 400 body and allowlisted correlation headers, preserving expected 403/503 assertions. Catalog: `@smthrs/effect-electric` remains the shape proxy; no library or product runtime changes.

Reproduce the reset path with `MINI_RUN_SRC=$PWD ~/.smithers-lead/scratchpad-mirror/mini-run apps/mvp -- bash -c 'pnpm exec vitest run --coverage.enabled=false worker/RemoteRuns.test.ts db/TestEndpoints.test.ts worker/test/shapeResponse.test.ts' e2e-reset-validation`. The final argument selects the same combined-command mode used by landing batches. Private response/header/log and validation receipts: `~/smithers-builders/shape-400-STATUS.md`.
