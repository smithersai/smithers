---
title: Browser filesystem stat validation and operation snapshots
status: done
area: platform-browser
owner: codex
updated: 2026-10-21
links: []
---

All five supplied findings reproduced on main@origin with failing regression
assertions. Validate modes as non-negative safe integers and omit timestamps
outside the Date range. Snapshot mkdir/remove options and rename/utimes methods
at construction, retaining the backend receiver. No library added; uses the
existing @smthrs/platform-browser filesystem adapter.

Latitude: five regressions failed before the fix; all 303 tests passed after
the fix, including the configured 100% coverage gate. E2E not run (mini offline).
