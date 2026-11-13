---
title: Burn down flows and database reds on main
status: done
area: sdk
owner: codex-flows-reds
updated: 2026-10-22
links: []
---

Reproduced on b698e0591730 through Latitude. Local jj commits only; no push.
Catalog entries: `@smthrs/flows`, `@smthrs/platform-node`, `@smthrs/database`,
`@smthrs/artifacts`, and `@smthrs/sync`.

Flows: 6 failures in 234 tests before; 234 pass after. Branch coverage was
97.22% on untouched main (RuntimeOptions.ts:262); now every metric is 100%.
A real hosted run asserts its configured placement in the admission metric.
The barrel now lists RunMetrics and verifies private packages stay unpublished
(e6609cc6bdfc deliberately introduced private secrets). The retry regression
installs its cleanup before announcing the interruption barrier, retaining all
assertions. The containment child keeps registration info off its PID stdout.
New lease and presence failures carry tags; the raw-site guard is unchanged.
Artifacts: 415 pass / 100%. Sync: 654 pass / 100%. All three package typechecks
and changed-production-source lint checks pass; changed flows files format.

Database: plain Vitest reproduces 95.55% lines, 94.84% statements, 92.04%
branches, 95.17% functions. It runs one backend. The existing declared matrix
(3cf2cf6dc920; PACKAGE.ts and docs/concepts/sqlite-only.md) passes unchanged:
SQLite 301 pass / 13 skipped; PostgreSQL 342 pass; merged coverage 100% in
all metrics. All reported uncovered single-lane lines execute in the matrix;
there is no uncovered database code to test or delete. No gate was changed.

Latitude Node 26 requires NODE_OPTIONS=--no-experimental-webstorage for the
strict containment stderr assertion; without it the runtime emits its own
localStorage warning. This environment-only diagnostic was proved separately.
All installs and validation ran remotely, one lat-run invocation at a time.
Full classification, ordered commits, commands and logs are recorded in the
requested sibling flows-reds-REPORT.md.
