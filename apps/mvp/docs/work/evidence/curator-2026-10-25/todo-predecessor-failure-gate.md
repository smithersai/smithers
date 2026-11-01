---
title: Stop later TODOs when a predecessor fails
status: in-progress
area: app
owner: Codex TODO-run repair job assigned by lead; Codex curates tracker
updated: 2026-10-22 15:44 PDT
links: [hosted-smithers-dogfood.md, ../rulings.md, everything-is-a-durable-flow.md]
---

## Tracker reconciliation — 2026-10-22 15:44 PDT

**Current state:** The 15:25 production receipt proves both new TODOs waited behind failed predecessors. Retry then restarts TODO 4 on main; by 15:41 TODO 5 correctly publishes draft PR #4436 stacked on #4435. Dropping a base still fails to notify in-flight followers promptly; that separate defect now has its own repair workstream.

**Next step:** Retain ordering and recovery receipts, verify green checks, and track dropped-base invalidation in todo-drop-stops-followers.md.

**Open questions for Will:** None newly required; previous unresolved questions remain below.

Evidence: lead text replies through 2026-10-22T22:43:40Z, script-filtered over the last two session hours. Both requested transcript paths checked; only 6253ecf2 exists. Automated notifications are excluded as user authority. Rulings and queue answers govern older docs and surviving briefs. Implementation owners and earlier history retained; Codex curates the tracker. Product receipts are lead-reported, not independently rerun here.


## Tracker reconciliation — 2026-10-22 15:34 PDT

**What:** Keep successor TODOs waiting behind failed predecessors.

**Why:** Successors must use the actual predecessor outcome.

**Current state:** At 15:25 PDT the production loop proves both new TODOs initially wait behind old failed TODOs on push 27. Dropping the old work closes stale PR #4431 and stops its checks. TODO 4 nevertheless starts on the branch then closed; expected failure and recovery remain unverified. This is progress evidence, not completion of ordering acceptance.

**Next step:** Verify closed-base handling and Retry release on main, then prove TODO 5 stacks on the recovered TODO 4 without running against an invalid base.

**Open questions for Will:** None newly required; earlier unresolved questions remain in retained history.

Evidence: lead text replies script-extracted from the last approximately two hours, 2026-10-22 13:33–15:33 PDT. Both supplied transcript paths checked; only 6253ecf2 is available and contains the recent replies. No user-typed ruling occurs in this window. Rulings and queue answers take precedence over older docs and surviving briefs; reboot-wiped files are not outstanding work. Product receipts below are lead-reported, not rerun by this tracker refresh. Implementation owners retained; Codex curates documentation.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 15:24 PDT

**What:** Keep successor TODOs waiting behind a failed predecessor.

**Why:** Later work must use the actual predecessor outcome.

**Current state:** The lead confirms push 27 live since 15:11 PDT with retry and predecessor-failure waiting. Deployment is complete; behavior-specific production acceptance remains open.

**Next step:** Verify a failed predecessor holds its successor and successful recovery releases it; retain the production receipt.

**Open questions for Will:** None newly required; earlier unresolved questions remain in retained history.

Evidence: lead text replies extracted by script from the two-hour window ending 2026-10-22T22:23:40Z. Both supplied paths checked; the continuation transcript is absent and recent replies survive in the original. Relayed agent messages and automated tracker prompts are excluded as human authority. Rulings and queue answers govern older docs. Product receipts are lead-reported; this refresh runs the site build only. Existing implementation ownership and all history are retained; Codex owns tracker curation. Reboot-wiped briefs are not outstanding work.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 15:14 PDT

**What:** Keep successor TODOs waiting behind a failed predecessor.

**Why:** Later work must use the actual predecessor outcome.

**Current state:** At 15:10 PDT the lead reports predecessor-failure waiting landed on main at 656539c3 with retry. Deployment is underway; production verification remains open.

**Next step:** Verify predecessor failure holds the successor and successful recovery releases it after deployment.

**Open questions for Will:** None newly required; earlier unresolved questions remain in retained history.

Evidence: script-extracted user and lead text across both supplied transcripts, 2026-10-22 13:13–15:13 PDT. No new user-typed product ruling appears in this window. Rulings and queue answers govern older docs and surviving briefs. Product receipts are lead-reported, not rerun here. Implementation owners retained; Codex curates this note only. Reboot-wiped files are not outstanding work.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 15:04 PDT

**What:** Keep successor TODOs waiting behind a failed predecessor.

**Why:** Later work must use the actual predecessor outcome.

**Current state:** At 15:04 PDT lander 1 is landing predecessor-failure waiting alongside retry. No completed landing or deployed acceptance is reported.

**Next step:** Collect landing and deployment receipts, then prove failure holds the successor and successful recovery releases it.

**Open questions for Will:** None newly required; earlier unresolved questions remain in retained history.

Evidence: script-filtered user-typed text and lead text replies across both supplied transcript paths, latest approximately two hours through 2026-10-22T22:04:03Z. Automated notifications and tool payloads excluded; no user-typed product ruling appears in this window. Rulings and queue answers govern older decisions, proposals, TODOs and rules. No matching feature/host/panel/design briefs survive in the supplied scratchpad; wiped files are not missing work. Product receipts are lead-reported, not rerun here. Codex curates documentation; execution owners retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 14:34 PDT

**What:** Keep successor TODOs waiting after a predecessor fails.

**Why:** Later work must start from its predecessor’s actual result and preserve stack ordering.

**Current state:** At 14:30 PDT the lead moves the TODO stacks immediately after the command-speed fixes: retry, predecessor-failure waiting, then GitHub merge wakeup. Push 26 already carries the TODO agent and long-command fixes. This stack has no new landing or production acceptance receipt.

**Next step:** Complete the integrated gate and land waiting behind a failed TODO in the announced order; deploy and validate it in the fresh two-TODO dogfood loop.

**Open questions for Will:** None newly required; existing unresolved questions remain in history.

Evidence: script-extracted lead text replies across both supplied transcripts, 2026-10-22 12:33–14:33 PDT. Both files exist at this refresh; synthetic task notifications and tool payloads do not count as user-typed instructions. Rulings and all queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped scratchpad files are not outstanding work. Product receipts are lead-reported; this tracker validates only the site build. Implementation ownership is retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 11:14 PDT

**What:** Keep successor TODOs waiting after a predecessor fails.

**Why:** Later work must start from its predecessor’s actual result and preserve stack ordering.

**Current state:** At 11:04 PDT the lead reports both waiting fixes rebased onto push 22 after TODO retry and returned to lander 1. The rebase is complete; landing and production acceptance are not reported. A final test in the combined batch was interrupted by a Latitude connection loss, with lander 1 responsible for completing the gate.

**Next step:** Complete the integrated gate and land after retry; verify predecessor failure, Drop release, correct predecessor-head selection and unmerged-close handling in production.

**Open questions for Will:** None newly required.

Evidence: lead reply at 2026-10-22T18:04:45.303Z, extracted as text by script from the two-hour session window ending 18:13:40Z. Both requested transcript paths checked; only the original exists here. Rulings and queue answers take precedence over older docs and surviving briefs. Product checks are lead-reported. Implementation ownership and status remain unchanged; Codex curates this note. Reboot-wiped files are not outstanding work.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 10:34 PDT

**What:** Block successor TODOs after predecessor failure.

**Why:** Later work must use its predecessor’s actual result.

**Current state:** At 10:27 the lead assigned one Codex Astra job to rebase retry and then both waiting fixes over push 22 Drop cancellation. Earlier real-Postgres regressions remain evidence of the prepared repair, not landing.

**Next step:** Land after retry and verify failure, Drop release, predecessor-head selection and unmerged-close behavior in production.

**Open questions for Will:** None newly required; existing decisions remain in retained history.

Evidence: script-filtered lead replies through 2026-10-22T17:33:43Z, covering approximately 08:34–10:34 PDT. The continuation transcript path is absent; recent replies survive in the original. Current rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped briefs are not outstanding work. Product receipts are lead-reported; Codex curates tracker documentation and runs only the site build. Existing implementation ownership retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 08:13 PDT

**What:** Keep successors waiting when their predecessor fails.

**Why:** The dogfood run opened a changeset-only PR from main after its first TODO failed.

**Current state:** At 08:11 the lead reports the repair with lander 1 and real-Postgres regressions that fail before the fix. A failed predecessor blocks successors; dropping it releases the queue; closing its PR unmerged fails successors. Landing follows the TODO-run integration and retry.

**Next step:** Land in dependency order and verify predecessor-head selection, failure, drop and unmerged-close behavior in production.

**Open questions for Will:** None newly required.

Evidence: lead text replies script-extracted from the latest two hours through 08:13 PDT in session 6253ecf2; current rulings and queue answers govern. The supplied continuation file is absent; post-reboot replies survive in the original session. Automated notifications and tool payloads excluded. Product checks are reported receipts, not rerun here. Implementation ownership is retained; Codex owns tracker curation. Reboot-wiped briefs are not outstanding work.

## Earlier tracker history (retained)


**What:** A later TODO must wait when its predecessor fails instead of starting from main.

**Why:** The hosted coding loop must preserve stack ordering and durable event-driven progress.

**Current state:** At 07:30 the lead assigns Codex to repair the production bug: TODO 1 failed, but TODO 2 opened #4431 from main without the required fix.

**Next step:** Retain a regression covering failure, recovery and correct predecessor-head selection; deploy and rerun stacked PR creation.

**Open questions for Will:** None.

Evidence: lead text replies script-extracted across both requested transcripts for 05:33–07:33 PDT, 2026-10-22; automated notifications, tool blocks and relayed agent messages excluded from user authority. Rulings and queue answers govern decisions, proposals, TODOs, rules and surviving briefs. No matching feature/host/panel/design briefs survive in the supplied final directory; reboot-wiped files are not outstanding work. Product receipts are reported, not tests rerun by this curator. Implementation owners retained; Codex owns tracker curation.
