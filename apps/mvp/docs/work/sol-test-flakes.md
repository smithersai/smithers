---
title: Remove runner, idle probe, chat and store test flakes
status: in-progress
area: app
owner: Codex GPT-6.1 Sol (sol-flakes workspace)
updated: 2026-11-02
links: [app-flakes.md, engine-flake.md]
---

Investigate each named failure with red/green receipts on the real Latitude
Postgres and Electric fixtures. No retries, sleeps or increased timeouts.
One commit per reproduced flake, landed through the workspace landing flow.
The engine-store and eight-clone cases must be exercised with bounded CPU load.

## EffectBoundaryRecords

Reproduced the original exact-log-count assertion on the Postgres matrix leg
under bounded CPU load. A diagnostic-only pass retained the logger's message
in addition to its cause and identified the second record: Effect TestClock's
"A test is using time, but is not advancing the test clock" warning.
See `evidence/sol-test-flakes/boundary-red.txt`.

Fix classification: **test**. The warning test now uses `it.live` for real SQL
I/O, asserts the actual warning text as well as annotations, and separately
asserts its persisted provider cause. Product code, budgets and exact count
assertions are unchanged. Library catalog entry: durable flow engine/stores
(`@smthrs/engine`, existing TestStores) and the existing Effect test services.

Reproduction/validation (run on Latitude from the package directory):

```sh
python3 ../../../../apps/mvp/docs/work/evidence/sol-test-flakes/load.py 1 \
  node ../database/scripts/test-matrix.mjs test/EffectBoundaryRecords.test.ts \
  --coverage.enabled=false --reporter=verbose
```

Set `FLAKE_CPUS=1 FLAKE_BURNERS=8` on the runner. The helper creates only its
own bounded workers, pins them to the chosen CPU, and terminates and joins
them when the test command ends. Each independent invocation has a 240 s CPU
load bound; it stops on the first test failure. This is targeted behavioral
validation, not a package-wide coverage receipt.

Green: the first loaded SQLite/Postgres pair passed all 12 cases with the live
warning test, including its exact single-warning assertion. Further loaded
pairs and the landing check retain independent invocation receipts below.
