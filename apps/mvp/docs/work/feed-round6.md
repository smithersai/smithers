---
title: Remove fixture snapshot contention and fence every authority loss
status: done
area: auth
owner: codex-feed-round6
updated: 2026-11-03
links: [reviewfeed-round5.md, expanded-isolated-classification.md]
---

Will requested three commits: remove fixture retries and their cause, squash only the classification note and empty classification commit, then fence repository and deployment denial/demotion. Red first on the mini; expanded tests and all four typecheck projects at the end, compared by failing test name against pinned main. No landing, push or review.

Existing library catalog entries: Effect SQL and @smthrs/effect-electric ShapeSource. No new library. Receipts: ~/.smithers-lead/scratchpad-mirror/feed6-20261103/.

Fixture red: `fixture-red.stderr.log:16-25` rejects the old TRUNCATE's 409 at `repos.reset.test.ts:25`; lines 36-48 reject the old retry's deadline result instead of the original 503 at `shapeRequest.test.ts:15` (3 failed, 6 passed). The retained Electric server record (`isolated-classification-20261103/electric-stack-third.log:13029-13057`) recreates the exact repo_api.repositories shape after truncate while chat shapes are created on the same Electric, then records its five-second table-lock timeout and the publication configurator's five-second timeout. Independent schemas do not isolate that publication manager. The historical record does not contain the blocking PID, so its exact holder is not established. This change removes both fixture-created hazards: default tests own Postgres/Electric as e9fc62f0's chat fix does; reset deletes rather than truncating and waits for actual replicated deletes. It introduces no retry or sleep. Future refusals retain safe stage/correlation and database lock diagnostics, never SQL text, credentials or response content.

The first two whole-file checks exposed assumptions made possible by TRUNCATE: the route test interpreted historical delete values as live rows, then assumed snapshot boolean text (`false`) instead of replication text (`f`). It now consumes Electric's change log through the inserted row and checks the same current row, fields, false flag, cache policy and subset behavior. Failed attempts are retained, not classified as baseline failures.

Fixture completion: `fixture-complete.stdout.log` passes all 72 tests (62 RepoApi, 9 one-request cases and 1 real Electric reset), zero failed/skipped. This is the first completed whole-file green after correcting the two protocol assumptions. The later expanded command includes the added diagnostic code.

Classification cleanup uses only `jj squash --from 99aa8af8d044 --into 1eac3ae7c369 -m ...`. The result is change qqmqznvy, commit bb4af598e902. `squash-tree.diff` is zero bytes across the entire working tree before/after; all intervening code changes are preserved. Descendant commit identities change only through automatic rebasing.

Authority reds: `fence-red.stderr.log` has six 200-versus-503 failures at Notifications.access.test.ts:433 (6 failed, 2 passed, 10 filtered skips). Four more tests record a real deployment loss and restoration without a second feed read: `deployment-record-red.stderr.log:34-46`, all four fail 200-versus-503 at line 452 (18 filtered skips). This found a missing receipt-side fence beyond the two named sites; both role refresh and new-session receipts now advance it transactionally. The initial focused rank/projection repair passes 95 tests; the final expanded run below includes the receipt-side repair and stronger no-row/stale-observation assertions.

The first expanded run exposes an additional fixture cause: `stack-expanded.stderr.log:7820-7840` records PostgreSQL FATAL 53300 (too many clients) during home fixture setup; 36 cases never execute. Unbounded Vitest file parallelism can exceed the owned stack's 100-connection budget (each file alone has a four-connection pool, plus handler/engine pools and Electric). The default now permits three test files at once. This bounds resource use rather than adding retries, sleeps, deadlines or server connections. The first expanded receipt remains 649 passed, 13 failed, 36 skipped; SDK stages pass 112 and 33. Its typecheck catches an incorrect test logger Options.annotations access, corrected through the existing structured logger formatter. A queued final attempt had already copied those bytes; its receipt is retained separately. Final verification runs the corrected logger and bounded fixture.


Final corrected validation (`verified-expanded.*`): **698/698 app tests across 27 files**, **112/112 Electric SDK**, **33/33 Cloudflare host**; **843 passed, zero failed or skipped**. All four app typecheck projects pass; the overall command exits 0. Feed access passes 22/22 (all 12 new held-loss cases) and RepoRoles 77/77. The monthly-budget threshold case passes in both the completed focused RepoApi run and expanded run. All 16 changed code/configuration files match their tested Mini SHA-256 values (`verified-source-match.txt`).

Pinned main `580a22d5c3165c1df6799e79400fa3788e7d52b2` passes 658 app, 112 Electric and 33 Cloudflare tests (803 total), zero failures/skips, plus all four typecheck projects. `comparison.json` compares file-relative full test names: no shared, stack-only or main-only failures. Names absent on either revision are listed separately, never treated as baseline passes. The second pre-cap attempt's 644 passed / 20 failed / 34 skipped and logger type error are retained along with the first attempt, not described as flakes or baseline failures. No retries or sleeps were added; the owned fixture and bounded concurrency remove shared publication/catalog and connection-capacity interference. The original historical blocking PID remains unknowable from its old log; future 503s capture the safe wait graph.

All work remains on this stack. No landing, pushing or review was performed. The temporary jj main workspace was forgotten and removed after retaining its results.
