# Lane L5 — Sync actions against live plue routes (2026-09-02)

## Replace degraded wording with the live shapes

Where a route answers with a different shape, parse what it returns, render
that, and record the mismatch (field, expected, observed) in the REPORT.

## Tests

Seam tests per route with fixtures shaped as above (mark `unverified` when
not observed live); card tests for each state named in ADR 0005 (authorizing,
active, failed op with Retry, expired key, importing with counts, failed
import with Retry, rate-limited with disabled Retry). Keep existing sync
tests green.

## Verification

`cd apps/app && bun x tsc --noEmit -p . && bun test src/mainview/state/seams src/mainview/cards`, then the full `bun test src` once (3 pre-existing TargetGraph fixture failures; do not touch). Write `L5-sync-live.REPORT.md`.

