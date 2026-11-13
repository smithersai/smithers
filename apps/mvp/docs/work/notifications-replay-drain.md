---
title: Drain notification emission withholding
status: in-progress
area: auth
owner: codex-replay
updated: 2026-11-04
links: [feed-emit.md]
---

P1 production replay_required investigation. Read-only production inspection; no land, push or deploy. Reproduce on cfbox pg, preserve before/after evidence, then obtain the requested exact-diff review receipt. Catalog: Effect SQL and @smthrs/effect-electric ShapeProxy. This repairs core authorization, not a new feature plugin.

The replay set is an in-memory result of the emit SQL snapshot, not a stored queue. A readable repository projection can outlive the permission or visibility receipt it reused. Retained rows then fail current authority, and the per-row fallback refuses the whole Electric batch. Ordinary receipt renewal or projection withdrawal may resolve it, but no drain job exists and no transition is guaranteed for stable withholding. Notification creation/update timestamps do not record entry into this computed set.

Migration 0107 adds an independent emission-membership projection. The locked emit transaction withdraws unauthorized retained subjects once and restores them only with current authority, producing Electric transitions after the buffered cursor. Repeated decisions write nothing. The authorization predicate and denial fences remain intact. The fix itself reconciles every requesting recipient; no production write/backfill is required.

The cfbox pg before run reproduces three consecutive replay_required responses with one and 3,395 denied subjects. The initial patched run passes all existing authorization tests and the migration test; its large recovery case exposed a test synchronization error (Electric up-to-date precedes replication of the new commit). The corrected regression follows live protocol pages, never retries a failed response, and checks every recovery insert plus stable row xmin. Initial targeted commands also report the global coverage gate failure because they select only these suites; final focused runs explicitly omit coverage and do not claim a 100% coverage result. All raw evidence, private production aggregates, final test logs and the requested reviewer output remain in the operator's external replay scratchpad; the exact-diff receipt uses the default review store.

The first exact-diff Astra review failed on idle 204 recovery and the short-expiry recovery test. The SDK now validates bodyless polls, and projection reuse requires a fresh underlying grant for the configured route. The new integration case consumes withdrawal through a real idle live response, renews authority, and recovers using live polls only. SDK cases test successful, superseded and failed validation on real idle responses, plus injected unexpected bodyless responses. The current Electric fixture uses 200 JSON heartbeats; waiting specifically for 204 timed out, so the live recovery case follows its actual protocol and the exceptional 204/205/304 paths are covered separately. The regression uses the scripted provider's real fixture installation identity; an intermediate wrong identity triggered the provider's public-copy fallback and was corrected, rather than weakening authorization assertions. Each parameterized person has an independent fixture account. Later raw logs preserve these intermediate failures.
