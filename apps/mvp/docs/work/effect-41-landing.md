---
title: Effect 4.1 landing validation
status: blocked
area: mvp
owner: Codex
updated: 2026-11-07
links: []
---

Restored persisted pending conversation acts before exposing the store, so a pre-restore empty snapshot cannot appear settled before resumption. All 20 unchanged conversations tests pass.

Preserved the reviewed sandbox database-route call forms after upgrade formatting. Both unchanged database-route tests pass. No tests or coverage thresholds changed.

The dependency upgrade remains blocked by regressions reproduced against the previous dependency cohort. Landing validation retains paired baseline and upgrade results for every reported red gate and the complete app suite.
