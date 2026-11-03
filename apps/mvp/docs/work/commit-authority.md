---
title: Commit-time write authority
status: in-progress
area: access
owner: Codex GPT-6.1 Sol
updated: 2026-11-02
links: []
---

Five reported write-authority races, tested against main `6d773cef` in an isolated workspace. No landing, pushing, production access or review is authorized. Each reproduced finding gets its own commit and public-safe issue draft. Tests run on Latitude against isolated Postgres schemas; gates use explicit handshakes, without sleeps or retries.

The existing Effect SQL transaction services are the seam; no new library is selected (library catalog: Effect SQL, existing app database host).

Finding 1 reproduced before the fix: `AssertionError: expected [ 200, { links: 1, changed: 1 } ] to deeply equal [ 403, { code: 'not_authorized' } ]` (session, alias and expiry cases; 3 failed, 8 filtered skips). After: WorkLinks.test.ts 12 passed, 0 skipped. Real SQL client spans measure +2 round trips for a signed-in write, +3 with an alias, +0 for reads and sessionless writes. Session locks and clock validation run inside the existing work-link transaction.
