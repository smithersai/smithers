---
title: Local-first conflicts, one e2e test per class
status: in-progress
area: app
owner: local-first conflicts builder
updated: 2026-10-21 13:44 PDT
links: [local-first.md, ../decisions/0002-local-first.md, ../features/chat.md, ../decisions/0016-todos-and-the-stack.md]
---

## The four reds after 21:00 — 2026-10-21 04:17 PDT

Real model, on the MacBook, against a dev server of its own (another `alchemy dev` stage and `DEV_HTTPS_PORT`), on main 1e94e0ec.

| Test | Cause of the 00:16–00:30 reds | Now |
|---|---|---|
| same question id | The shared dev server reloaded A at 00:16:57 (Vite `full-reload`: someone edited `src/device/identity.ts` and `src/main.tsx` in the checkout it serves). The reload also showed a product bug: the `Not sent` copy Edit took away came back (2 of 2 runs). | Fixed and unmarked. A reload step now guards it. |
| duplicate send | ChatApi rebuilt from 00:19:01 to 00:19:15; the page reloaded, `/api/auth/session` answered 503, and a fresh device showed `Sign in to ask Smithers.` in place of the composer. | Passes; unmarked. |
| taken back after ChatApi took it | The dev server reloaded A at 00:25:33; the reloaded `/app?faults` page runs healthy services, so sync came back and A saw its question. | Passes; unmarked. The inner `BROKEN_WITHDRAW` mark stays. |
| stale tab | The timeline rail's `followSummaries` started one `timeline/summarize` run per message the device held (about 300) on every tab's boot. Those runs held back the device store: a follower tab's restore took 31 to 39 s, so its sends were resent and its answers never arrived. Summaries off: 2 of 2 pass; on: 3 of 3 fail. | Still marked: 1 of 2 fail. In the failing run both of device A's tabs saw the second question arrive (`question stored`, `inserted`), then lost it. Cause not found. |

Fixes:

- `followSummaries` follows the conversation's window (chat's `latest` query), not every message, and stops once the summary role answers `unconfigured` (`409 no_route`). Regression tests: `src/features/chat/chat.test.ts` "a device opening a long conversation summarizes only the messages its window shows", `src/features/timeline/store.test.ts` and `engine.test.ts`.
- The same flood is the status-sync red (device A's notifications hydration queued about 38 s): on one dev server, `e2e/status.spec.ts` "needs you" fails on main ("A: a toast says so") and passes with the fix, both tests.
- `e2e/devices.ts` fails a device test as void when the dev server reloaded one of its opened tabs (`e2e/devReload.ts`) and logs the file. Run these specs against a dev server whose checkout no one edits.

Still open: the stale-tab row loss above; a fresh device whose session request fails shows `Sign in to ask Smithers.` and never asks ChatApi again until a reload.

## Tracker reconciliation — 2026-10-21 13:44 PDT
**What:** Preserve questions across lone tabs, stale tabs, reloads and failed session checks.
**Why:** Local-first input and saved state must survive ownership changes.
**Current state:** At 13:41 PDT tracks A (lone-tab false Not sent) and B (one sync writer per device) are ready to land with regressions failing on old code; SDK coverage is reported 100%. Track C session recheck is still underway. Five of six Astra findings are fixed; the clone finding needs its regression. Ten real-model stale-tab runs await the shared lock. No landing or production pass is reported.
**Next step:** Land A/B, finish C and clone regression, run the ten stale-tab journeys and retain withdrawal/reload coverage.
**Open questions for Will:** None.
Evidence: script-filtered user-typed messages and lead text replies from session 6253ecf2, approximately 11:44–13:44 PDT; automated notifications and tool content excluded. Rulings and queue answers govern over historical briefs, panel designs, decisions, proposals, TODOs and rules. Product receipts are lead-reported; this pass validates the site build only. Existing execution owners retained; Codex curates tracker documentation.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 13:38 PDT
**What:** Keep questions consistent across tabs, reloads and offline recovery.
**Why:** A withdrawn question must disappear on every device.
**Current state:** The lead’s 12:48 PDT local sweep found a withdrawn question still visible in another tab and assigned it to the local-first builder. The earlier lock fix does not close this failure. At 13:37 the lead confirmed this builder resumed after the reset; no regression pass or landing is reported.
**Next step:** Retain the two-tab withdrawal regression, finish session recovery and single-writer fixes, then rerun locally and against production.
**Open questions for Will:** None.
Evidence: lead text replies extracted by script from session 6253ecf2, 11:37–13:37 PDT on 2026-10-21. Automated notifications and tool records excluded. Rulings and queue answers override historical briefs, panel designs, decisions, proposals, TODOs and rules. Product results are lead-reported. Existing execution owners retained; Codex owns tracker reconciliation only.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 10:54 PDT
**What:** Prevent lost queued questions and recover failed session checks.
**Why:** Offline input must survive tab leadership and reloads.
**Current state:** At 10:50 PDT the lead reports the first fix ready for landing: the outbox acquires the browser lock directly instead of abandoning leadership after 100 ms. Old-code regressions fail and both SDK packages pass at 100% coverage. Session-check recovery and one sync writer per device are still being built; no landing or production receipt is reported.
**Next step:** Land the lock repair; finish session recovery and single-writer sync, then prove the two-tab and reload cases.
**Open questions for Will:** None. Access, Neon, Telegram and review routing are settled.
Evidence: script-filtered human messages and lead text replies from session 6253ecf2, latest two hours through 10:53 PDT; rulings and queue answers take precedence over historical briefs and docs. Product receipts are lead-reported. Codex curates documentation; engineering ownership is retained.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 10:04 PDT
**What:** Prevent lost queued questions across tabs and recover session checks.
**Why:** Queued input must survive reload and a failed service check must recover.
**Current state:** At 09:54 PDT all four reports are in and the local-first builder is running, confidence 70–80%. Reported causes include independent tab sync writers sharing a store, one-shot session checks, and premature follower detection refusing the first question. These remain findings awaiting repaired-suite receipts.
**Next step:** Implement through the existing durable SDK services and prove two-tab reload, queued-versus-unsent behavior and session-check recovery with retained regressions.
**Open questions for Will:** None.
Evidence: script-filtered user-typed text and lead text replies in session 6253ecf2, latest approximately two hours through 10:03 PDT; automated notifications, compaction summaries and tools excluded. Current rulings and queue answers override historical briefs, designs, decisions, proposals, TODOs and rules. Product receipts are lead-reported; this tracker validates only the site build. Execution ownership retained; Codex curates documentation.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 09:54 PDT
**What:** Prevent lost questions across tabs and recover from a failed initial session check.
**Why:** Local-first use must preserve queued input and distinguish service failure from signed-out state.
**Current state:** At 09:49 PDT the lead relays Fable findings: follower detection after 100 ms refuses the first question; the one-shot identity check turns a 503 into signed out; independent tab sync streams can lose rows on reload. These are investigation findings, not verified repairs. At 09:53 the panel still awaits Opus.
**Next step:** Merge the panel and implement regressions for queued versus unsent, identity-check recovery, and two-tab reload without question loss.
**Open questions for Will:** None; engineering investigation and repair are authorized.
Evidence: script-filtered user-typed messages and lead text replies, 07:53–09:53 PDT, session 6253ecf2; automated requests, summaries and agent-message wrappers excluded. Rulings and queue answers take precedence over briefs and older docs. Product checks are lead-reported; this refresh validates only the site build. Execution owners retained; Codex curates documentation.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 09:34 PDT
**What:** Preserve questions across tabs and recover from an initial identity-check failure.
**Why:** Both failures undermine local-first use and are in the immediate derisk effort.
**Current state:** At 09:26 PDT the lead reports a four-model local-first panel covering question loss between tabs on one device and a failed first sign-in check that currently needs reload. Opus will merge and implement. Earlier conflict fixes awaiting landing do not prove these remaining cases fixed.
**Next step:** Merge findings, implement through the existing SDK and outbox, and retain regressions proving no question loss and sign-in recovery without reload. Verify ordering, leadership changes and reload against the landed revision.
**Open questions for Will:** None new. Provider preference and implementation direction are settled; builders resolve engineering choices.
Evidence: session 6253ecf2, script-filtered user-typed text and lead text replies in the latest approximately two hours through 09:33 PDT; synthetic notifications, tool results and compacted summaries excluded. Rulings and queue answers take precedence over shared briefs/designs, decisions, proposals, TODOs and rules. Product results are lead-reported; this refresh validates only the site build. Execution owners remain unchanged; Codex maintains this tracker entry.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 09:24 PDT
**What:** Preserve questions and authoritative outcomes across tabs and devices.
**Why:** The 09:22 update identifies a remaining question-loss failure despite the earlier workspace-fixes handoff.
**Current state:** The lead now explicitly reports two tabs on one device can lose a question, with a committed test marked broken. Earlier finished conflict fixes awaiting landing do not establish that this case is repaired; no new suite totals or production receipt are reported.
**Next step:** Use the failing test and records in the expanded four-model investigation, then have Opus fix the loss with its regression retained. Reconcile the exact cases fixed by the workspace batch against the still-broken case, and verify ordering, reload and leadership changes.
**Open questions for Will:** None. The provider preference and investigation/implementation direction are explicit; engineering validation remains with the builders.
Evidence: session 6253ecf2, script-filtered user text and lead replies in the last approximately two hours through 09:23:49 PDT; automated notifications, compacted summaries and tool results excluded. Rulings (including ARCH-14), Will’s queue answers, shared feature/host/panel briefs and designs, decisions, proposals, TODOs and rules were reconciled. Product results are lead-reported; this tracker verifies the site build only. Existing feature execution ownership is retained.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 09:17 PDT
**What:** Repair conflicting sends, stale tabs and question ownership with real-model regressions.
**Why:** Local-first chat must preserve ordering and one authoritative outcome across devices.
**Current state:** At 09:15 PDT the lead lists conflict-test fixes among finished workspace work now being rebased and pushed. This advances the earlier debugging-only report, but supplies no exact suite totals or landing receipt. It does not establish that the separately tracked cross-device notification failure is fixed.
**Next step:** Obtain the builder’s exact suite outcomes and regression receipts, then confirm the pushed revision and real-model multi-device behavior; keep the notification investigation separate until a shared cause is proven.
**Open questions for Will:** None new; engineering validation and landing do not need another decision.
Evidence: script-filtered session 6253ecf2 human text and lead replies through 09:15 PDT, including Will’s human-origin queued request at 09:10:54. Rulings and queue answers take precedence over the shared briefs/designs, decisions, proposals, TODOs and rules reviewed for this pass. Product validation is lead-reported; this tracker runs the site build only. Execution ownership retained; documentation curator: Codex.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 04:24 PDT
**Current state:** At 04:24 PDT the lead routed the unresolved status-test finding to the active Opus conflict-test builder: one device receives no notifications and notification data loads in about 38 seconds. A shared cause with the four conflict failures is suspected, not proven. No repaired conflict-suite receipt exists.
**Next step:** Investigate the delay alongside the four failures, reconcile all eleven outcomes and retain root-cause regressions and real-model recordings.
**Open questions for Will:** None new. Existing unresolved questions remain in the retained history.
Evidence: lead text reply at 04:24 PDT, extracted by script from the latest approximately two session hours; no human-typed message in that window. Automated notifications and tool content excluded. Current rulings and queue answers override historical briefs, designs, decisions, proposals, TODOs and rules. Product receipts are lead-reported; the tracker runs only the maintainer-site build. Execution owner retained; documentation curator: Codex.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 03:04 PDT
**Current state:** At 02:56 PDT the lead started an Opus job in its own workspace to reproduce the four unexplained real-model failures, bisect the round-4 changes and fix their causes. No new passing suite receipt exists.
**Next step:** Reconcile all eleven outcomes, fix each root cause and retain real-model regressions and recordings.
**Open questions for Will:** None new; existing unresolved questions remain in the retained history.
Evidence: lead text replies through 03:03 PDT, extracted by script from the latest approximately two session hours; automated notifications and tool blocks excluded. Current rulings and queue answers take precedence over briefs and designs. Execution ownership retained; documentation reconciled by Codex tracker curator. Product receipts are reported, not independently rerun here.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 00:53 PDT
**What:** Retain a real-model end-to-end test for every device-conflict class.
**Why:** Cross-device recovery and ordering need actual passing evidence.
**Current state:** At 00:41 the lead reports 5 of 11 passing, one expected known-broken failure and four unexplained failures after switching to the real model. These reported counts leave one outcome unaccounted for. Earlier scripted-agent passes do not establish real-model correctness. The failing tests are to be retained as known-broken for landing.
**Next step:** Reconcile all eleven outcomes, retain exact failure evidence and investigate causes first after deployment. Follow local-first-conflict-coverage.md; do not call the suite passing.
**Open questions for Will:** None; page.clock is approved only for clock cases (TEST-12).
Evidence: script-filtered user-typed messages and lead text replies, session 6253ecf2, 22:53–00:53 PDT; rulings and queue answers through 00:17:42 PDT; shared feature/host/panel briefs and designs, decisions, proposals, TODOs and rules. Automated notifications and tool blocks excluded. Product receipts are lead-reported; this tracker validates the site build only. Execution ownership and prior history retained.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-20 23:44 PDT

**What:** Retain one end-to-end test per real device-conflict class.

**Why:** Prove recovery, ordering and cross-device consistency.

**Current state:** Will approved Playwright page.clock at 23:37 (TEST-12) for clock tests only. This resolves the pending permission in older history; it grants no broader mocking exception. No new all-green conflict-suite receipt is reported.

**Next step:** Use the approved page clock in clock cases, use the real model for happy paths, and fix the four reported product bugs with retained regressions.

**Open questions for Will:** None on clock simulation.

Evidence: user-typed text and lead text replies extracted by script from session 6253ecf2, approximately 21:44–23:44 PDT; queue answers through 23:38:44, current rulings, decisions, proposals, TODOs, rules and shared briefs/designs. Synthetic notifications and tool content excluded. Later rulings supersede retained history. Product receipts are lead-reported; this tracker validates the maintainer-site build. Execution ownership retained; documentation reconciled by Codex tracker curator.

## Earlier tracker history (retained)


## What

Will, about 18:36 on 2026-10-20, on the "local-first tabs and devices" walkthrough: "you should show more than 1 type of conflict I'd prefer to see all of them". `e2e/local-first-conflicts.spec.ts` has one test per conflict class the device store and the outbox resolve, on two devices or two tabs, each with chaptered steps and a summary for its video's title card.

## Classes, checked against the code

Last runs: real model on the MacBook, 2026-10-21 00:16 to 00:30 (`pnpm e2e local-first-conflicts.spec.ts --grep-invert "same TODO"`); the TODO test on the mini at 23:54, which asks no model.

| Class | Real? | How it resolves | Test | Last result |
|---|---|---|---|---|
| Two devices change the same thing | yes: one question id from two writers; one TODO dropped twice | 409 keeps the device's copy `Not sent`, Edit asks it again; a second drop changes nothing | `same question id`, `same TODO on two devices` | red: after Edit and Enter the question never showed on A (passed on the mini with a scripted agent); passed |
| An edit against a delete | no | a stored message is never edited or deleted; TODO Amend is 0016 slice 2 | none | |
| Both offline, back in either order | yes | Postgres' arrival order | `back in either order` | passed |
| A duplicate send | yes | 200 `existing`, stored once | `duplicate send` | red: A's composer didn't open (passed on the mini) |
| A stale tab after a leader switch | yes | `sent_elsewhere`: not sent twice | `stale tab` | red: tab 2's second question never showed (on the mini, tab 1 went blank) |
| Withdraw while another tab sends | yes | `Outbox.withdraw` under the permit + `outboxFollower.ts` | `taken back before it is sent`; `taken back in one tab, gone from the other`; `taken back after ChatApi took it` | passed; fixed & passed (mark removed); red before its mark: A saw its question arrive though its sync was down (on the mini it failed at its mark) |
| Server refusal: permission revoked offline | yes: 401, 403 `view_only` | `Not sent`, never resent | cut: see Next | |
| Schema or payload change across a deploy | yes: `plan_changed`, `payload_changed` | `chat/Close`: `Couldn't answer`, Retry | `new build refuses a parked answer` | passed |
| Clock skew | across devices: handled; one device's clock stepping back: not | arrival order; the outbox orders writes by `createdAt` | `clock skew`; `clock steps back` | passed; the next question showed twice for 5 s, so its broken mark moved to that assertion (not rerun) |
| Co-edited draft (CRDT) | not landed | | none | |

## Bugs found

- **Fixed:** `IssueWrites.layer` handed over its outbox writes with `OutboxWrites.of`, replacing co-editing's `text-update`, so every keystroke in the composer threw "Unknown mutation function: text-update". It now uses `OutboxWrites.adding`; `src/outbox.test.ts` "every feature's mutation reaches the one outbox" fails on the old code.
- **Marked broken, not fixed:** Edit after ChatApi took a question the device hasn't seen arrive takes it back anyway; after a device clock steps back, the next question shows twice and the outbox orders writes by that clock (`@tanstack/offline-transactions` 1.1.3 orders and schedules by `createdAt` and `nextAttemptAt`).
- **Seen once, not marked:** on the mini at 21:05, about 20 s after a tab lost the outbox's lead its `views` collection errored and its conversation went blank; the MacBook run didn't show it.
- `e2e/devices.ts` gave a resent question's second response to its first post; each response now goes to the first post of its id still open.

## Run

The tests ask the real model (23:05: the lead ruled out a scripted agent without Will's yes), so they run on the MacBook under the heavy lock; the TODO test asks nothing and runs on the mini. The two clock tests use Playwright's clock, which Will approved for them only (ruling TEST-12, 23:37). The mini run in the table above used a scripted agent that has since been removed.

## Next

- Status todo: the four red tests (same question id, duplicate send, stale tab, taken back after ChatApi took it). Each passed or failed at its mark on the mini at 21:00, against a scripted agent and that hour's tree; on the MacBook at 00:16 they failed before their assertions on the composer, a question's row or the sync fault. Find each cause in the run's records under `scratchpad/lfc-final/`, fix it or mark it broken, and rerun the spec.
- Status todo: access lost while offline. Maya makes Ben a viewer of her branch while his question waits offline; ChatApi refuses it (403 `view_only`) and it stays `Not sent`. It needs a tracked branch (GitHub) and the dev teammate's sign-in: on the MacBook at 23:03 the teammate cookie signed in as local-developer, and at 19:18 the share route answered 503 `sql:SqlSyntaxError`.
- Videos from the last runs: `~/Desktop/smithers-mvp/videos/local-first-conflicts/`, and GIFs in `~/Desktop/smithers-mvp/gifs/`.
