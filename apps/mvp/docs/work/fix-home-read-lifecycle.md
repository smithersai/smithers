---
title: Home read and action lifecycle regressions
status: done
area: home
owner: codex
updated: 2026-10-21
links: []
---

Reproduce cancellation, concurrent declaration reads, repository action isolation, and pull request navigation. Existing catalog entries: Effect, @smthrs/effect-tanstack-db, @smthrs/ui; no new libraries.

All four findings reproduced with failing assertions on main@origin. Latitude `pnpm test src/features/home`: baseline 47 passed; final 51 passed across all five files (unit and integration). Both commands exit 1 solely because the existing global 100% coverage gate includes the rest of the app. No new test failures. Focused regressions on the original implementation failed for stuck loading, two declaration reads, stale action state, and an issue URL for a pull request. E2E: not run (mini offline).
