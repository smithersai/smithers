---
title: About freshness review fixes
status: done
area: app
owner: Codex GPT-6.1 Sol
updated: 2026-11-02
links:
  - visitor-about-quota.md
  - ../features/repo.md
---

Amend the single unlanded About fix on main without landing, pushing or claiming a review.
The server and HTTP caches must not serve expired About; already-read tab memory is outside this bound.
Client deadlines, render guards and expiry refreshes were removed per Will's narrower scope.
Legacy HTTP responses without a deadline remain readable, so they cannot strand a healthy repository.

Catalog entries used: `@smthrs/flow` for bounded durable retries; `@smthrs/effect-tanstack-db`
for tab state; `@smthrs/integrations` for GitHub reads; `@smthrs/ui` for the aside's retry control.
No new dependency or feature interface.

Keep must-revalidate (including max-age=0), zero GitHub reads on lookup/claim failure,
bounded client retries, the aside retry control and the claim generation fence.
Migration 0098 follows published 0097_runner_reconfirmation. Its comment records the one-deploy
old-writer overlap bound; a stalled old-worker write lives for one claim.

Validation receipts are in the scratchpad's `sol/about-fix5-mini-*.log`, outside the repository.
All commands use `mini-run`; focused Vitest runs disable coverage as requested.
- All four `pnpm typecheck` projects passed on the Mac mini (exit 0).
- The broad run passed all 335 tests across 22 files, with 0 failed and 0 skipped (exit 0),
  including workerd, the legacy cached response, the aside retry and curated claim failure.
  Initial admission attempts timed out for capacity (exit 75), before executing tests.
- Read the earlier failures: `faults.test.ts:140`, `warm.test.ts:119` and `:187`,
  `embed.test.ts:48` timed out or failed state waits amid database/network timeouts.
  No assertion or timeout was weakened. The obsolete API deadline test was removed;
  the curated recovery failure is fixed by taking the claim before choosing any token.
- The same faults/warm/embed files on main `99e894a1` passed 42 tests across 3 files,
  with 0 failed and 0 skipped (exit 0). Those earlier failures did not reproduce on
  either tree; they are not claimed as proven failures on main.
- Coverage thresholds are unchanged. No 100% executed coverage, production validation,
  landing, push or agent review is claimed.
