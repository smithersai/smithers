---
title: Show the confirmed clone after reload or launch failure
status: in-progress
area: app
owner: codex-astra
updated: 2026-11-27
links: [../features/repo.md]
---

Canary showed Try again on repositories that reached ready on their first attempt. The repository header should use the same authorized clone evidence as its file view.

The repositories shape returned 200 across two pages. Its up-to-date snapshot and Neon agreed that Smithers CI, Voltaire and Tevm Effect were ready on attempt one. The view marked even a failed or partial HTTP page answered, and its header ignored successful refs and let a generic local failure hide a ready row. The specific historical launch transport error was not captured.

Uses the library catalog’s local state and sync entries, `@smthrs/effect-tanstack-db` and `@smthrs/effect-electric`, for collection readiness and visibility-gated reads. Existing authentication, refusal and clone admission controls still decide access.

The header now waits for the first installed snapshot, including in a watching tab. A received ready row clears the earlier generic failure. The Mini exercised an actual clone that became ready after its confirmation timeout, two Electric pages, two tabs sharing storage, and read-only reconnect. Launch and confirmation records include the server-issued attempt UUID. The production reload check follows deployment.
