---
title: Name every ShapeProxy 503
status: done
area: observability
owner: Codex GPT-6.1 Sol (shape-reason)
updated: 2026-11-04
links:
  - ../../../../packages/effect-electric/docs/shape-proxy.md
  - ../../../../apps/mvp/docs/features/notifications.md
---

Name the existing proxy refusal paths and notifications cursor checks without changing access or retry behavior. Use the catalog's `@smthrs/effect-electric` ShapeProxy and existing Effect logging/metrics. Regression tests use real Postgres/Electric; failures enter through injected Effect services. Production's historical refusal cannot be classified retroactively; this change makes subsequent refusals identifiable.


Implemented seven closed proxy reasons (the six generated refusals plus Electric's own 503) in the request log and both counters. Non-503 records omit the attribute. Buffered notification validation inherits the proxy correlation ID and emits one count-only refusal line for `cursor_unstable`, `denial_sequence_moved`, or `read_failed`. Access decisions and retry-after behavior are unchanged. This extends existing SDK/core observability rather than adding a product feature or plugin.

Mac mini receipts:
- Old implementation: proxy regressions 9 failed / 43 passed; notifications regressions 6 failed, proving missing diagnostics.
- `pnpm test run test/ShapeProxy.test.ts test/ShapeProxyCanonical.test.ts --coverage.enabled=false`: 135 passed. `pnpm check`: passed.
- `pnpm vitest run worker/Notifications.access.test.ts worker/Notifications.test.ts --coverage.enabled=false`: 112 passed. `pnpm typecheck`: all four ES2022 projects passed.
- V8 JSON changed-code coverage: ShapeProxy 21/21 statements, 27/27 branches, 4/4 functions; Notifications 8/8 statements, 6/6 branches, 6/6 functions. Every changed executable line is exercised. Full-file thresholds were retained and reported as failing: ShapeProxy 95.34% lines, 94.36% statements, 95.03% branches, 96.15% functions; Notifications 100% lines/functions, 99.69% statements, 98.15% branches (unchanged lines 187, 282, 576, 739).
- Full package suite: 257/260 passed; three persisted ElectricCollection tests fail with SQLite `database is locked`, including with one worker. These failures are outside the changed proxy; no baseline pass or fix is claimed.

No deployment or production write. The historical production refusals cannot be named retroactively from their old records.
