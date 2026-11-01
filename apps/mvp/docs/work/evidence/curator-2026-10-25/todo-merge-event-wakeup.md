---
title: Wake waiting TODOs from GitHub merge events
status: in-progress
area: app
owner: Codex TODO-run repair job assigned by lead; Codex curates tracker
updated: 2026-10-23 01:04 PDT
links: [hosted-smithers-dogfood.md, ../rulings.md, everything-is-a-durable-flow.md]
---

## Tracker reconciliation — 2026-10-23 01:04 PDT

**What:** Wake waiting TODOs from GitHub merge events while preserving cancellation.

**Why:** A merged predecessor should promptly release its follower without polling or reviving cancelled work.

**Current state:** At 00:54 the lead reports this repair on main a78c2907; at 00:57 it is live since 00:55. Production webhook wake remains untested until a person merges #4435. Deployment alone does not close acceptance.

**Next step:** After the human merge, retain the production webhook wake receipt and verify follower advancement and cancellation permanence.

**Open questions for Will:** Review and merge #4435, then #4436; agents never merge.

Evidence: script-extracted user-typed text and assistant replies, 2026-10-23 06:04–08:04 UTC, session 6253ecf2; requested continuation 265921d3 unavailable. Rulings and queue answers govern older planning docs and surviving briefs. Product receipts are lead-reported; this tracker validates only the maintainer-site build. Existing implementation ownership and earlier history are retained.

## Earlier tracker history (retained)



## Tracker reconciliation — 2026-10-22 16:04 PDT

**What:** Wake waiting TODOs from GitHub merge events without reviving cancelled work.

**Why:** Merge notification must preserve terminal cancellation and durable recovery.

**Current state:** At 15:39 PDT the lead reports the repaired webhook wake stack ready with conflicts resolved, queued immediately after command-speed work with lander 1. The 15:26 cancellation and resume regressions pass as previously recorded. No integrated landing or live webhook acceptance receipt is present.

**Next step:** Complete the integrated gate after the command-speed stack, land and deploy, then verify merge wakeup, permanent cancellation and duplicate-event recovery.

**Open questions for Will:** None newly required.

Evidence: script-filtered lead text replies from approximately 14:03–16:03 PDT in session 6253ecf2, plus surviving DEPLOYER-STATE.md for the deployment receipt. Both supplied transcript paths checked; continuation 265921d3 is unavailable. Relayed agent messages and automated refresh prompts are excluded as user authority. Rulings and queue answers govern historical decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped files are not outstanding work. Implementation owners and prior history are retained; Codex curates documentation. Product results are reported receipts; this refresh verifies the maintainer-site build only.

## Earlier tracker history (retained)

## Tracker reconciliation — 2026-10-22 15:34 PDT

**What:** Wake waiting TODOs on GitHub merge events while preserving terminal cancellation.

**Why:** A webhook must not revive permanently cancelled work.

**Current state:** At 15:26 PDT the lead reports the third TODO repair fixed and with lander 1. Cancellation could interrupt the step recording cancellation, leaving a run suspended. The unchanged original test now passes; new tests fail on the old code. This also clears the flaky resumes-where-it-stopped test: a helper let the killed engine reconnect and compete with its replacement. No landing or production webhook receipt is reported.

**Next step:** Complete the landing gate, land and deploy; verify merge wakeup, permanent cancellation, duplicate events and recovery. Check this repair before continuing the overlapping sandbox-resume investigation.

**Open questions for Will:** None newly required; earlier unresolved questions remain in retained history.

Evidence: lead text replies script-extracted from the last approximately two hours, 2026-10-22 13:33–15:33 PDT. Both supplied transcript paths checked; only 6253ecf2 is available and contains the recent replies. No user-typed ruling occurs in this window. Rulings and queue answers take precedence over older docs and surviving briefs; reboot-wiped files are not outstanding work. Product receipts below are lead-reported, not rerun by this tracker refresh. Implementation owners retained; Codex curates documentation.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 15:04 PDT

**What:** Wake waiting TODOs on GitHub merge events without reviving terminally cancelled work.

**Why:** A webhook must preserve permanent cancellation.

**Current state:** At 15:04 PDT the third TODO fix failed its own regression: a permanently cancelled TODO can be revived by a webhook and remain suspended instead of cancelled. A Codex Astra job is repairing it. The existing seventy-second merge check still notices merges.

**Next step:** Fix cancellation preservation, retain the failing regression and gate the webhook repair before landing. The dogfood loop can proceed through the existing merge check.

**Open questions for Will:** None newly required; earlier unresolved questions remain in retained history.

Evidence: script-filtered user-typed text and lead text replies across both supplied transcript paths, latest approximately two hours through 2026-10-22T22:04:03Z. Automated notifications and tool payloads excluded; no user-typed product ruling appears in this window. Rulings and queue answers govern older decisions, proposals, TODOs and rules. No matching feature/host/panel/design briefs survive in the supplied scratchpad; wiped files are not missing work. Product receipts are lead-reported, not rerun here. Codex curates documentation; execution owners retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 14:34 PDT

**What:** Wake waiting TODOs from GitHub merge and close events.

**Why:** Waiting for a person’s merge should not require frequent polling.

**Current state:** At 14:30 PDT the lead moves the TODO stacks immediately after the command-speed fixes: retry, predecessor-failure waiting, then GitHub merge wakeup. Push 26 already carries the TODO agent and long-command fixes. This stack has no new landing or production acceptance receipt.

**Next step:** Complete the integrated gate and land waking on GitHub merge notices in the announced order; deploy and validate it in the fresh two-TODO dogfood loop.

**Open questions for Will:** None newly required; existing unresolved questions remain in history.

Evidence: script-extracted lead text replies across both supplied transcripts, 2026-10-22 12:33–14:33 PDT. Both files exist at this refresh; synthetic task notifications and tool payloads do not count as user-typed instructions. Rulings and all queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped scratchpad files are not outstanding work. Product receipts are lead-reported; this tracker validates only the site build. Implementation ownership is retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 11:14 PDT

**What:** Wake waiting TODOs from GitHub merge and close events.

**Why:** Waiting for a person’s merge should not require frequent polling.

**Current state:** At 11:04 PDT the lead reports both waiting fixes rebased onto push 22 after TODO retry and returned to lander 1. The cancellation-path rebase is complete. A final test in the combined batch was interrupted by a Latitude connection loss; the lander must finish validation. No landing or production event-driven acceptance is reported.

**Next step:** Complete lander 1’s gate, land in dependency order and verify event delivery, duplicate delivery, cancellation and recovery in production; people retain merge authority.

**Open questions for Will:** None newly required.

Evidence: lead reply at 2026-10-22T18:04:45.303Z, extracted as text by script from the two-hour session window ending 18:13:40Z. Both requested transcript paths checked; only the original exists here. Rulings and queue answers take precedence over older docs and surviving briefs. Product checks are lead-reported. Implementation ownership and status remain unchanged; Codex curates this note. Reboot-wiped files are not outstanding work.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 10:34 PDT

**What:** Wake waiting TODOs from GitHub merge or close events.

**Why:** Waiting for a person’s merge should avoid frequent polling.

**Current state:** At 10:27 the waiting fixes entered a Codex Astra rebase behind TODO retry because push 22 changed Drop cancellation. Neither this rebase nor production event-driven acceptance is reported complete.

**Next step:** Rebase after retry, preserve cancellation, then land and verify event delivery, deduplication and recovery.

**Open questions for Will:** None newly required; existing decisions remain in retained history.

Evidence: script-filtered lead replies through 2026-10-22T17:33:43Z, covering approximately 08:34–10:34 PDT. The continuation transcript path is absent; recent replies survive in the original. Current rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped briefs are not outstanding work. Product receipts are lead-reported; Codex curates tracker documentation and runs only the site build. Existing implementation ownership retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 08:13 PDT

**What:** Wake waiting TODOs from GitHub merge or close events.

**Why:** Seventy-second polling wastes work while a person decides whether to merge.

**Current state:** At 08:11 the lead reports the repair with lander 1, backed by real-Postgres regressions failing before the fix. Waiting TODOs sleep until a GitHub merge/close event, with an hourly fallback. Landing follows TODO-run integration and retry.

**Next step:** Land the repair, then verify authenticated events, duplicate delivery and recovery without changing person-only merge authority.

**Open questions for Will:** None newly required.

Evidence: lead text replies script-extracted from the latest two hours through 08:13 PDT in session 6253ecf2; current rulings and queue answers govern. The supplied continuation file is absent; post-reboot replies survive in the original session. Automated notifications and tool payloads excluded. Product checks are reported receipts, not rerun here. Implementation ownership is retained; Codex owns tracker curation. Reboot-wiped briefs are not outstanding work.

## Earlier tracker history (retained)


**What:** Resume a TODO from GitHub merge notifications instead of repeated merge-status polling.

**Why:** The hosted coding loop must preserve stack ordering and durable event-driven progress.

**Current state:** At 07:30 the lead assigns Codex to replace the approximately seventy-second pull-request wait polling. The published artifact is waiting for a person and spends no further model tokens.

**Next step:** Use the existing durable flow and webhook contracts; prove authenticated event delivery, deduplication, recovery and person-only merge authority.

**Open questions for Will:** None.

Evidence: lead text replies script-extracted across both requested transcripts for 05:33–07:33 PDT, 2026-10-22; automated notifications, tool blocks and relayed agent messages excluded from user authority. Rulings and queue answers govern decisions, proposals, TODOs, rules and surviving briefs. No matching feature/host/panel/design briefs survive in the supplied final directory; reboot-wiped files are not outstanding work. Product receipts are reported, not tests rerun by this curator. Implementation owners retained; Codex owns tracker curation.
