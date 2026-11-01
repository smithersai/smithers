---
title: Reap crashed test schemas
status: done
area: testing
owner: codex-test-schema-reap
updated: 2026-11-01
links: []
---

Use one timestamped schema naming helper and bounded local-fixture startup cleanup. Minimum age is two hours, three times the farm's 40-minute maximum run. Skip relation locks; never scan old-format schemas for deletion. Real Postgres tests cover crashes, concurrent cleanup, protected names and refusal of remote endpoints. Catalog entry: `@smthrs/database` and the existing Effect PostgreSQL test driver; this is test bootstrap infrastructure, not an app background sweep.


The pure `TestSchemas` root API in `@smthrs/database` owns naming; repository test bootstrap owns the local guard and bounded sweep. Timestamped CLI store prefixes retain their time/random suffix across engine/control/copy schemas; legacy non-test prefixes keep their old mapping. Declared test and check inputs include both new source modules. The reaper is test bootstrap, not a product action or app sweep.

Real Postgres evidence: SIGKILL survivor, separate-process subsequent startup, young/locked/protected/nonmatching survivors, eight concurrent reapers, a bounded schema-object lock race, permission failure, and refusal of remote authorities and endpoint overrides. Worker integration230, database adapters88, CLI history/copy30 (fresh private fixture database), Electric68 and agent/device41 passed. Shared-catalog CLI StoreCopy initially exceeded two 30-second budgets; the same30 cases passed on the fresh database, which was removed afterward; no existing schemas or VACUUM were touched. Astra findings were fixed. Fable could not launch on the mini (`claude-rr` absent), so no Fable review is claimed.

Final focused gate: 74 tests; 100% lines, branches, functions and statements for TestDatabase, timestamp naming and cleanup. All four MVP typecheck projects and changed-file ESLint passed; shared target declaration suite33 passed.
