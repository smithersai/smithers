---
title: Retry a failed TODO in place
status: done
area: app
owner: Codex TODO retry builder assigned by lead; Codex curates tracker documentation
updated: 2026-10-22 15:44 PDT
links: [hosted-smithers-dogfood.md, todo-predecessor-failure-gate.md, todo-merge-event-wakeup.md, todos-and-stack.md, ../decisions/0016-todos-and-the-stack.md, ../rulings.md]
---

## Tracker reconciliation — 2026-10-22 15:44 PDT

**Current state:** At 15:35 PDT Retry succeeds through the production app: TODO 4 restarts from main. At 15:39 it publishes PR #4435 with exactly the requested one-line change; at 15:41 TODO 5 publishes draft PR #4436 stacked on its new branch.

**Next step:** Retain the production recovery receipt; follow Smithers checks and human review under hosted-smithers-dogfood.md.

**Open questions for Will:** None newly required; previous unresolved questions remain below.

Evidence: lead text replies through 2026-10-22T22:43:40Z, script-filtered over the last two session hours. Both requested transcript paths checked; only 6253ecf2 exists. Automated notifications are excluded as user authority. Rulings and queue answers govern older docs and surviving briefs. Implementation owners and earlier history retained; Codex curates the tracker. Product receipts are lead-reported, not independently rerun here.


## Tracker reconciliation — 2026-10-22 15:34 PDT

**What:** Retry a failed TODO in place while retaining its attempts and stack position.

**Why:** Closed-base recovery must be safe and observable.

**Current state:** Push 27 is live. At 15:25 PDT the dogfood loop has a concrete Retry case: TODO 4 started on a branch closed while old TODOs were dropped. The deployer expects base-closed and plans to retry on main. No successful production Retry receipt is reported yet.

**Next step:** Observe the failure, retry through the app and prove rebasing on main, preserved history and correct successor stacking.

**Open questions for Will:** None newly required; earlier unresolved questions remain in retained history.

Evidence: lead text replies script-extracted from the last approximately two hours, 2026-10-22 13:33–15:33 PDT. Both supplied transcript paths checked; only 6253ecf2 is available and contains the recent replies. No user-typed ruling occurs in this window. Rulings and queue answers take precedence over older docs and surviving briefs; reboot-wiped files are not outstanding work. Product receipts below are lead-reported, not rerun by this tracker refresh. Implementation owners retained; Codex curates documentation.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 15:24 PDT

**What:** Retry failed TODOs in place, retaining attempt history.

**Why:** Recovery must preserve stack position and cancellation authority.

**Current state:** Push 27, including 656539c3, is live since 15:11 PDT according to the 15:15 lead reply. The clean loop is starting; no dedicated production retry acceptance receipt is reported.

**Next step:** Verify cancellation-gated retry, preserved prior attempts and successor release in production.

**Open questions for Will:** None newly required; earlier unresolved questions remain in retained history.

Evidence: lead text replies extracted by script from the two-hour window ending 2026-10-22T22:23:40Z. Both supplied paths checked; the continuation transcript is absent and recent replies survive in the original. Relayed agent messages and automated tracker prompts are excluded as human authority. Rulings and queue answers govern older docs. Product receipts are lead-reported; this refresh runs the site build only. Existing implementation ownership and all history are retained; Codex owns tracker curation. Reboot-wiped briefs are not outstanding work.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 15:14 PDT

**What:** Retry failed TODOs in place, preserving attempt history.

**Why:** Recovery must retain stack position and cancellation authority.

**Current state:** At 15:10 PDT the lead reports retry landed on main at 656539c3 alongside predecessor-failure waiting. The deployer is deploying that revision; no production retry acceptance receipt is reported.

**Next step:** Collect deployment and verify cancellation-gated retry, preserved prior attempts and successor release in the fresh dogfood loop.

**Open questions for Will:** None newly required; earlier unresolved questions remain in retained history.

Evidence: script-extracted user and lead text across both supplied transcripts, 2026-10-22 13:13–15:13 PDT. No new user-typed product ruling appears in this window. Rulings and queue answers govern older docs and surviving briefs. Product receipts are lead-reported, not rerun here. Implementation owners retained; Codex curates this note only. Reboot-wiped files are not outstanding work.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 15:04 PDT

**What:** Retry failed TODOs in place while retaining attempt history.

**Why:** Recovery must preserve stack ordering and cancellation authority.

**Current state:** At 15:04 PDT the lead reports lander 1 is landing retry now. This is work in progress, not a completed landing receipt.

**Next step:** Collect the pushed revision, deploy and verify retry in the fresh two-TODO dogfood loop.

**Open questions for Will:** None newly required; earlier unresolved questions remain in retained history.

Evidence: script-filtered user-typed text and lead text replies across both supplied transcript paths, latest approximately two hours through 2026-10-22T22:04:03Z. Automated notifications and tool payloads excluded; no user-typed product ruling appears in this window. Rulings and queue answers govern older decisions, proposals, TODOs and rules. No matching feature/host/panel/design briefs survive in the supplied scratchpad; wiped files are not missing work. Product receipts are lead-reported, not rerun here. Codex curates documentation; execution owners retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 14:34 PDT

**What:** Retry failed TODOs in place while preserving prior attempts.

**Why:** A retry must retain stack history and respect cancellation of the stopped run.

**Current state:** At 14:30 PDT the lead moves the TODO stacks immediately after the command-speed fixes: retry, predecessor-failure waiting, then GitHub merge wakeup. Push 26 already carries the TODO agent and long-command fixes. This stack has no new landing or production acceptance receipt.

**Next step:** Complete the integrated gate and land retry in the announced order; deploy and validate it in the fresh two-TODO dogfood loop.

**Open questions for Will:** None newly required; existing unresolved questions remain in history.

Evidence: script-extracted lead text replies across both supplied transcripts, 2026-10-22 12:33–14:33 PDT. Both files exist at this refresh; synthetic task notifications and tool payloads do not count as user-typed instructions. Rulings and all queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped scratchpad files are not outstanding work. Product receipts are lead-reported; this tracker validates only the site build. Implementation ownership is retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 11:14 PDT

**What:** Retry failed TODOs in place while preserving prior attempts.

**Why:** A retry must retain stack history and respect cancellation of the stopped run.

**Current state:** At 11:04 PDT the lead reports TODO retry and both waiting fixes rebased onto push 22 and returned to lander 1. Retry uses the new Drop cancellation path: a stopped TODO is retryable only after its run is confirmed cancelled. Review also repaired preservation of the previous attempt’s branch and pull request. One final test could not run because a Latitude connection dropped; lander 1 must cover it. Landing and production acceptance remain unreported.

**Next step:** Complete lander 1’s gate, including the interrupted test; land and deploy, then verify cancellation-gated retry and prior branch/pull-request history in production.

**Open questions for Will:** None newly required.

Evidence: lead reply at 2026-10-22T18:04:45.303Z, extracted as text by script from the two-hour session window ending 18:13:40Z. Both requested transcript paths checked; only the original exists here. Rulings and queue answers take precedence over older docs and surviving briefs. Product checks are lead-reported. Implementation ownership and status remain unchanged; Codex curates this note. Reboot-wiped files are not outstanding work.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 10:34 PDT

**What:** Retry failed TODOs in place with prior attempts retained.

**Why:** Failures need a usable retry path without losing stack history.

**Current state:** At 10:27 the lead reports retry and waiting fixes conflict with push 22 Drop cancellation. One Codex Astra job is rebasing retry first, then waiting fixes. Retry acceptance of a stopped attempt must use the new cancellation path. No landing or production retry receipt exists.

**Next step:** Complete the ordered rebase, pass cancellation and retry regressions, land and verify production.

**Open questions for Will:** None newly required; existing decisions remain in retained history.

Evidence: script-filtered lead replies through 2026-10-22T17:33:43Z, covering approximately 08:34–10:34 PDT. The continuation transcript path is absent; recent replies survive in the original. Current rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped briefs are not outstanding work. Product receipts are lead-reported; Codex curates tracker documentation and runs only the site build. Existing implementation ownership retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 08:13 PDT

**What:** Retry a failed TODO in its existing stack position with prior attempts retained.

**Why:** A failed TODO currently has no usable retry path.

**Current state:** At 08:10 the lead reports implementation with lander 1: same number, position and issue link, earlier attempts kept; agent retry supported; Members retry their own and Maintainers anyone’s. Landing waits for the TODO-run integration. No deployed retry acceptance exists.

**Next step:** Land after the TODO-run redo; prove authorization, duplicate requests, history preservation and successor release in the clean production loop.

**Open questions for Will:** None newly required.

Evidence: lead text replies script-extracted from the latest two hours through 08:13 PDT in session 6253ecf2; current rulings and queue answers govern. The supplied continuation file is absent; post-reboot replies survive in the original session. Automated notifications and tool payloads excluded. Product checks are reported receipts, not rerun here. Implementation ownership is retained; Codex owns tracker curation. Reboot-wiped briefs are not outstanding work.

## Earlier tracker history (retained)


**What:** Restart a failed TODO while retaining its stack position, title and history.

**Why:** Failed TODOs currently cannot restart: the run page’s Retry excludes TODO runs and no other action replaces it.

**Current state:** At 07:51 the lead assigns a Codex job to build retry in place. A waiting successor should start once the retried TODO publishes. The third dogfood TODO is a temporary installation test, not evidence that retry works.

**Next step:** Use the existing durable TODO/run flows and public plugin interface; consult docs/libraries.md before implementation. Prove authorized retry, duplicate requests, preserved ordering/history, failure recovery and successor release with meaningful regression and real end-to-end tests; deploy and rerun the coding loop cleanly. Keep merge authority with people.

**Open questions for Will:** None; stack preservation and successor behavior are specified in the lead’s update.

Evidence: lead text replies script-extracted across both supplied transcript paths, latest approximately two-hour window through 07:54 PDT on 2026-10-22. Automated notifications, tool payloads and synthetic requests are excluded from user authority. Current rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Product receipts are lead-reported; this curator validates the site build only. Execution owners are retained; Codex owns tracker documentation. Reboot-wiped scratch files are not outstanding work.
