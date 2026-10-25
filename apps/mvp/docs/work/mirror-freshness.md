---
title: Keep GitHub mirrors fresh
status: blocked
area: repositories
owner: codex-mirror-fresh
updated: 2026-10-25
links:
  - ../features/repo.md
---

Fix push-driven mirror refresh and distinguish an unsynced commit from a missing file.
Use the library catalog's Code Storage import/read entry and durable flow steps.

Rebased onto batch T, preserving visitor ref resolution before Electric sync and About's per-request work.
Installed-repository pushes and stale reads request a durable refresh; missing commits show Not synced yet with
Refresh, including visitor pages without a synced repository row. Decision 0105 records the permitted not-synced
fallback. No SDK package changed.

Latitude typecheck and importRules pass after rebase. All 664 focused tests pass (7 credential-dependent cases
skipped), with 100% statements, branches, functions and lines on all nine changed logic files. This includes
visitor resolution, concurrent About reads, mirror replay, stalled-shape Refresh and navigation cancellation.
The Mac mini starts the dev server successfully, but skips the newest-commit browser test because its local
Code Storage capability is absent. No browser pass or GIF is claimed; deployment validation remains with the lander.
