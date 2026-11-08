---
title: Client held-write and sign-out review fixes
status: in-review
area: client
owner: Codex GPT-6.1 Sol
updated: 2026-11-02
links:
  - ../features/sign-in.md
  - ../features/coedit.md
---

Round 1 fixed Astra's three findings on b4db02c73fef, test-first. Round 2 is recorded below. This lane remains unlanded and undeployed for Astra's re-review. Libraries: the catalog's `@smthrs/effect-tanstack-db` outbox and `@smthrs/platform-browser` locks.

Decision 0151 is absent on this stack; read the scratch tree's accepted decision. This change preserves the current stack's session-end behavior and explicit sign-out wipe.


## Round 1 result

The sign-out request first owns an exclusive browser Web Lock through its wipe. Reopen senders and receivers take compatible shared guards with `ifAvailable`; a failed request awaits release, and a closing or crashed page cannot leave a persistent marker. Lifecycle records count pending, answered, failed, released and suppressed reopens without identities or payloads.

Held writes stay in the original outbox row with their idempotency keys, owner stamps and optimistic rows. The shared SDK persists hold and dependency metadata and uses the existing executor with an opt-in dependency-aware scheduling patch. Ordinary retries remain FIFO. Dependencies are text id, repository and issue number/create id/settings, repository stack, run, and conversation. Earlier rows recover keys from their persisted payloads. A tab invalidates other tabs with an empty notification; every instance reads owned persisted rows for held status before the executor starts. The tab-local holding set is removed.

## Round 1 test-first receipts

Before production edits, package regressions failed because `b1` never delivered behind held `a1`, and follower held status was undefined. The real two-tab page-wipe regression failed with `ManagedRuntime disposed` when reopening stopped the application before sign-out could mark its wipe. The foreground follower never showed sign-in. Tests were committed in d287e3153fc5 before the fix.

Final mini-run receipts, with coverage disabled and at most three Vitest workers:

- Shared package: 17 files, 198 passing tests; its declared `pnpm check` passed.
- Client identity, wipe, co-edit and boot: 88 passed, two expected failures and one viewer-presence failure under load. That existing viewer-presence test passed when run alone, as required by the owner's flake rule.
- The final focused wipe/co-edit run: five passed, covering the new concurrent-reopen guard, pending sign-out and crash release, real cross-tab wipe, same-text order with another text delivering, and follower/offline restoration before sending.
- Issues, TODOs and remote runs: three files, 130 passed.
- Chat, controls and auth: three files, 134 passed.
- App `pnpm typecheck` passed all four declared VibeLang projects. Across the complete file runs, the isolated viewer test, and the added guard test, 552 distinct tests passed and two remain expected failures. Coverage thresholds were not measured.

No production deployment, browser E2E run, landing, push or agent re-review was performed. Astra's re-review remains pending. There is no open mechanism decision; stack operations deliberately share one repository key to retain numbering and dependency order.

## Round 2

Owner: Codex GPT-6.1 Sol. Addressing Astra’s five findings and crash/lost-acknowledgment evidence in this private jj lane. No landing or deployment. Test-first runs execute only on Latitude.

The round-2 regressions failed before production edits: delayed delivery produced no reload (also failed alone); a request waiting on a cancelled reopen returned `refused` instead of 200 (also failed alone); equal-time replay attempted `second` before `first`; empty keys sent `second` past the hold. The read-count regression failed alone with 3,991,197 row reads while queued invalidations drained. Its original 30-second run timed out; a 120-second diagnostic budget exposed the count. Final runs use no retries or sleeps.

Receivers now retain delayed reopen requests behind sign-out, and hold the shared guard through stopping the page. A cancelled or rejected recovery clears the fetch latch for waiting requests too. Admission sequences persist in transaction metadata and are reconciled before new admissions on leadership change. An ownership-filtered in-memory index and a persisted index of held keys replace per-write scans; follower invalidations coalesce and reuse cached owner stamps. Rows repair the index on startup or leadership change. The existing send-time ownership and server-principal checks remain intact.

The patch grew from 283 to 292 lines and its patch/lock changes squashed without conflicts into the original dependency change, retaining its message. The Web Locks capability failure will be a separate commit. The abrupt-crash test terminates a worker without calling `close`; the real co-edit exactly-once test drops a successful response after the server commit, observes the repeated idempotency key, and checks one stored update per key. Both strengthened tests passed against the preceding implementation, as expected for preserved behavior.

Latitude receipts so far: 17 package files, 202 passed, zero skipped; package `pnpm check` passed. The read-count regression, including a follower, recorded zero transaction-row reads during 1,000 offline admissions and a burst of 1,000 invalidations. No local tests, builds or installs ran.

The separate Web Locks regression failed alone in Latitude run 8 with `TypeError: Cannot read properties of undefined (reading request)`. `PageWipe.open` now returns `unsupported` before reading device marks or opening stores. Startup closes the channel, reports the missing capability directly (the program has not started to drain buffered records), renders the shared failure state, and never starts the program.

Astra's re-review found two additional status-cache defects, both fixed test-first. The live index-failure regression failed with only one index write after the same-held retry; the in-place A-to-B principal regression failed because `held` remained true. Failed index updates now remain dirty through startup or mutation errors and are repaired by the next existing storage/retry/settlement step; hints follow successful persistence. Write diagnostics identify the index stage without error messages or payloads. Cached owner stamps are re-evaluated only when the principal or unstamped policy changes. The new principal test also verifies A's row remains stamped A and is never sent as B.

Astra's final source re-review passed with no remaining finding and no path found that sends A's held write as B. Before the final notification regression, the SDK run passed all 204 tests in 17 files, zero skipped. SDK `pnpm check` and the app's four-project `pnpm typecheck` passed after correcting test host and fault-service return types. The Mac ran no tests, builds or installs. The initial loaded client run had twelve co-edit failures and one boot metric failure; all thirteen passed when each ran alone. Those diagnostic invocations skipped their unselected cases and are not recorded as full-suite passes. The final unfiltered client receipts are recorded below.

A final review also caught a transient notification failure: the index persisted but a failed hint was never retried for an unchanged held row. The added regression failed with the follower still reporting false after `retryNow`. A failed hint now retains the same dirty flag, so the next existing storage step rewrites the small index and republishes it. No scan or retry loop was added.

## Final round 2 receipts

All execution was on Latitude with coverage disabled and at most three Vitest workers:

- SDK: 17 files, 205 passed, zero skipped; `pnpm check` passed.
- Wipe, identity, unsupported startup, boot and app outbox: five files, 67 passed, zero skipped.
- Co-edit: 29 passed, two existing expected failures, zero skipped. This includes the real lost-acknowledgment and held-write ordering cases.
- App `pnpm typecheck`: all four declared projects passed.
- Counting transaction-row reads with a follower: zero during 1,000 offline admissions and zero during the 1,000-invalidation burst.

The loaded NYC-01 run had twelve co-edit failures and one boot metric failure. All passed individually; the subsequent unfiltered runs passed. One final guard invocation never reached Vitest because integration setup failed; the complete run succeeded on NYC-02. No retries or sleeps were added to make a flaky test pass. Filtered diagnostic skips are excluded from the final full-suite receipts.

Astra's final read-only verdict was PASS, with no remaining findings and no path found sending A's held write as B. The patch remains 292 lines, up from 283, and its patch/lock change is in the original dependency change without conflicts. The unsupported Web Locks behavior is in its own commit. No landing, push, deployment, browser E2E or coverage measurement was performed.
