---
title: Stable execution labels for private build dependencies
status: done
area: sdk
owner: Codex
updated: 2026-11-12
links: []
---

`ci` could reject compatible build and test plans when their private
dependencies received labels in different traversal orders. Private execution
labels now come from canonical positions in the declaration graph. Named labels
and private query visibility stay unchanged. Base lookups leave unused verb
callbacks untouched; the first kind-only lookup completes a deterministic scan.

The original four regressions fail with the old planner. All 15 focused planner
and merge tests pass with 100% statement, branch, function and line coverage for
the new label module. Typecheck, lint, the public `ci` fixture, target-index
regeneration and drift check, and documentation sync and checks pass. All 52
published package documentation tarballs pass. Independent Astra and Fable
reviews pass.

The full package run recorded 3,480 passing tests, 11 failures and 28 skips.
Four invalid control fixtures and the new raw-error audit delta are corrected.
The remaining six failures reproduce when the original parent planner is
restored: permission-sensitive cases, two runner expectations, a stale raw-error
inventory and a child process missing the VibeLang loader. The package-wide
100% coverage gate is not green; existing thresholds and audit expectations
have not been relaxed.
