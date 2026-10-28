# 0124: Background progress is a projection of receipts

Status: accepted (2026-10-28). Implements the root rule "Instant chat; slow work runs in the background" for `/new`, Create issue, Make TODO and Commit. Builds on [0002](0002-local-first.md) (outbox), [0009](0009-notifications-and-live-work.md) (feed, toast stack), [0011](0011-the-agent-runs-in-the-browser.md) (browser engine) and [0123](0123-write-input-receipts.md) (input receipts). Designed twice (PROC-6): Claude Opus and Codex Sol, merged below.

## Decision

A toast says only what a receipt the operation already writes proves. Nothing is stored for presentation: no progress row, owner, lock or generation. Each state has one authority, and a stronger receipt replaces a weaker one for the same subject.

```
           Requested                 Working                  Done / Failed
tab      ─ input receipt (0123),    ─                        ─ this tab's refused admission (Retry)
           admission in flight
device   ─ outbox row; recovery     ─ engine run running     ─ engine run settled; recovery row the route
           row `requested`;                                    answered (`taken` / `not_sent` + reason)
           engine run pending
server   ─                          ─ write pending          ─ the person's notification, folded in the
                                                               result's own transaction
```

| Operation | Subject | Done | Failed |
|---|---|---|---|
| `/new` (`conversation/new`) | `run:<execution>` | engine run completed, or the engine's answer to the dispatch | engine run failed or died; start refused in this tab |
| Make TODO (`todo/issue`) | `run:<execution>` | engine run completed, or the engine's answer to the dispatch | engine run failed or died; start refused in this tab |
| Create issue | `write:<write id>` | `github_writes` done (notification, `issue-writes`) | write failed at GitHub; route refusal; admission refused in this tab |
| Commit | `write:<op id>` | `stack_ops` committed (notification); route's numbered answer; the stack's synced TODO under the op id | route refusal; admission refused in this tab |

1. **The server folds the result into the person's notification in the same transaction** (0009 §6), as it already does for Publish and Update: `WriteFeed.fold` covers `issue/create`, and `Stack.apply` folds a committed TODO. The row cannot disagree with the result it is written with, and it carries 0009's Read, Hide and Dismiss across devices.
2. **The device bridges until that row syncs.** `progressOf` (src/features/attention/progress.ts) is a pure function of the receipts; the store runs it whenever one changes and feeds its rows, marked local, under the synced notifications. A synced row with the same subject wins, unless it still says live while the device holds the result, dismissed or not: the notification and the result reach the device on different shapes, in either order (`merged`).
3. **Tab state proves only Requested or this tab's refusal.** The input receipt survives reload and is resumed once (0123), so Requested reconnects. Another tab never reads it and never infers failure from what it can't see. Each attempt (the press, a reload's resume, Try again) speaks for its command: it clears the last refusal, and a refusal while another attempt runs says nothing. Once the outbox or the engine took an input, it proves Requested at most, and nothing once this tab has shown a stored or server receipt of its subject (the outbox's own row can still roll back, so it retires nothing). An engine operation's input stays until its run settled: a reload meanwhile resumes it, so the tab answers the run's calls again, and a second press joins it. The settled run then admits and retires it, whatever became of the Start reply. `/new`'s line leaves the composer only then, once the run finished: a run that fails, a Try again or a reload never loses it. A tab whose session storage can't keep inputs keeps an engine operation's in memory. A recovery row `not_sent` without a reason is preparation, not evidence, and no tab toasts it; the page keeps showing it as Not sent.
4. **Transport unavailability proves nothing.** A start whose reply was lost, or a read that failed, stays Requested until a receipt arrives; with no attempt running, it offers Try again, which admits the same identity. Only an engine or outbox refusal is Failed, and only a device or server result, never this tab's refusal, outranks a synced row.
5. **`/new` and Make TODO stage their input** like 0123's writes; their admission is the engine recording the run, and their execution is the staged command's. Resume starts the same execution again, which the engine joins. The engine's answer to the dispatch (`result`, at once for a run that settled long ago) is a receipt too: it shows how the run ended where no read shows it, and retires the input.
6. **The engine is read through `BrowserEngine.runs`**, a snapshot-and-follow stream in `@smthrs/platform-browser`: subscribed before its first read, read again after the runs' events and each new leader, and after a failed read on a backoff of its own (250 ms doubling to 5 s), so a run that settled while a read failed shows without another event. It reads only the operations' flows (`flows`), every page created within the list's week (`within`). Terminal runs appear in the snapshot without another event. App code holds no inspection loop.
7. **Device receipts count once stored.** A recovery row is read only when `isSynced`: an optimistic `taken` never shows Done, so a rolled-back write cannot revert Done.
8. **Times are the receipt's own:** the refusal's arrival, the engine's `finishedAtMs`, the route's answer (`answeredAt`, new on both recovery rows), the server's `updated_at`. The 4 s toast counts from them.
9. **Acts on a local entry name its receipt, not a version.** A local Failed is listed; its Dismiss stores the subject with the receipt's time (`attention-dismissed`), hiding only entries of that subject at or before it. A same-id Retry's later receipt shows again. Requested and Working local rows are toast-only, as 0009's launch rows were.
10. **Retry on this tab's refusal resumes the input receipt** through the same path as reload, with the same identity. A settled engine run's failure offers Open (its run page); the person runs it again from where they started.

## Consequences

- Publish and Update keep 0009's launch row (`writeNotices.ts`) until they stage their input like `/new`; their server row already comes from `WriteFeed`. Converting them is the follow-up that deletes `launches`.
- Follower tabs cannot see the leader's undelivered outbox rows (0002: only the leader restores them). Offline, a reloaded follower shows nothing for such a write until the route answers. A tab closed before durable admission leaves no toast; its text stays on the page as Not sent.
- Libraries (docs/libraries.md): `@smthrs/flow` and `@smthrs/platform-browser` (engine runs), `@smthrs/effect-tanstack-db` (outbox, recovery rows), `@smthrs/effect-electric` (notifications, `issue-writes`), `@smthrs/ui` (toast stack).

## Merged from the two designs

From Sol: Commit moves Requested → Done with no Working phase; the precedence order; the SDK snapshot-and-follow stream in place of app re-inspection; acts keyed to the observed receipt; folding Commit in `Stack.apply`. Not taken: an SDK-wide observable outbox admission (the tab's own receipt and the outbox rows suffice), and Failed toasts that never expire (0009's 4 s rule stays; the list keeps failures).

From Opus: tab state limited to Requested and this tab's refusal; `isSynced` gating; receipt times on recovery rows; staging the engine operations so Requested survives reload.

## The findings this rules out

The three earlier builders' twelve review rounds stored a progress row beside the receipts and kept it consistent. Each class is impossible here or has a regression test (src/features/attention/progress.test.ts, background.test.ts, src/writeAdmission.test.ts, src/resumeAdmissions.test.ts): stuck Requested or Working after reload or a failed role or engine read (R1, R4); Retry versions and rollbacks (R2, R3, R11); draft resurrection (R5, R6: Make TODO's draft step is unchanged); cross-tab false failure (R7–R9); refusal after 4 s (R10); orphaned owner, generation or lock (R11, R12); lost Start (R12).

This design's own Codex Astra review ran 15 rounds; each defect it found was in a receipt's precedence or lifetime and was fixed there, with a regression test, never with stored progress. Round 15 found nothing actionable.
