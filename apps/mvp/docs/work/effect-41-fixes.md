---
title: Effect 4.1 introduced regression repairs
status: in-progress
area: dependencies
owner: Codex
updated: 2026-11-07
links: []
---

Repair introduced failures by shared cause, retaining existing tests and coverage thresholds. Baseline is a fresh independently installed main@origin source-swap workspace. Detailed incremental receipts: ~/vl/vl-e41fix.REPORT.md. No push or main movement.

Library catalog entries: existing @smthrs/integrations for GitHub; @smthrs/effect-electric for Electric shapes; Effect typed error handling at public domain boundaries. No new library or app retry mechanism.

## Repairs

- `pwxqurxw`: the atomic filesystem promises native Node glob parity. Effect 4.1 deliberately replaces its Node adapter glob with shared Glob (saved changelog lines 248–252), so compare directly with Node's actual glob; preserve every case and pinned assertion. 48/48 pass.
- `vnoxwvvx`: the installed quickstart uses published rc.16 with its compatible Effect 4.0.5 cohort. The unchanged install/replay test passes.
- `yqnylpxq`: patch upstream implementations for own __proto__ environment entries, statically visible NodeWS exports (all eight preserved), signed-int64 OTLP serialization, and VibeLang real error-subclass matching. Existing kernel, error, resource-budget and TUI files pass: 6, 7, 7 and 4 cases.
- `qssnpmpq`: fresh typed domain failures at GitHub, coedit and runner Jobs boundaries; Effect 4.1's eager error mapper now preserves Cause annotations. All seven originally red annotated assertions pass unchanged, in a 13-case focused run.
- `kpknpzpo`: a one-element Effect stream buffer lets finite upstream shape responses observe EOF and release their resource while preserving downstream backpressure and interruption. All 15 worker ShapeProxy and 150 real Podman-backed SDK proxy cases pass unchanged.

Recursive typecheck and check pass, and the patched lockfile installs frozen. Astra reviewed the changes; its NodeWS export-preservation finding is fixed and verified. Fable is unavailable in this session.

## Full-suite control

The inherited launcher shared a 100-connection PostgreSQL between six two-worker shards. Both trees exhausted that fixture (91/132 too-many-client errors observed before stopping). The paired rerun retains tests, six shards, two workers, coverage and 100% thresholds, with 500 fixture connections. No product timeout or coverage threshold was changed. Complete assertion comparison and remaining upgrade-only failures will be recorded in ~/vl/vl-e41fix.REPORT.md before a landing decision. No push, GitHub write or main movement.
