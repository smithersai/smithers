---
title: Persistent file tabs and keyboard focus
status: done
area: app
owner: Codex tracker; implementation by mini file-tabs repair jobs through lander
updated: 2026-10-24 22:05 PDT
links: [agent-repo-navigation.md, repo-clone-and-view.md, land-to-main.md, conversations-and-history.md, ../rulings.md]
---

## Tracker reconciliation — 2026-10-24 22:05 PDT

**What:** Keep persistent file tabs and usable keyboard focus.

**Why:** Keyboard file navigation must remain reliable.

**Current state:** At 22:03 PDT the lead reports keyboard file tabs passes when run alone on smithers.sh at every width. The earlier one-tab failure occurred during the heavy run; no product repair is claimed. This supersedes the 21:54 failing state.

**Next step:** Retain the isolated production result and regression; investigate new reproducible failures if they recur.

**Open questions for Will:** None required to proceed.

Evidence: script-extracted user-typed text and lead assistant replies for 2026-10-25 03:04–05:04 UTC across both requested paths; only 6253ecf2 exists at this refresh. Automated notifications and tool payloads are excluded. Will’s typed instruction is “keep going.” Rulings and all 236 queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped files are not pending work. Product results are lead-reported; this refresh executes only the maintainer-site build. Existing implementation owners and all earlier history are retained; Codex owns tracker curation.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-24 21:55 PDT

**What:** Keep persistent file tabs and usable keyboard focus.

**Why:** Keyboard file navigation must remain correct.

**Current state:** The 21:54 PDT lead reply confirms keyboard file tabs still fails: only one tab appears where two are expected. The Codex repair job remains active. Earlier overload-related closures do not supersede this latest failure.

**Next step:** Collect the failing-first repair and rerun hosted keyboard acceptance with a recording.

**Open questions for Will:** None required to proceed.

Evidence: user-typed text and lead assistant replies extracted by a small script from both supplied JSONL paths for the combined latest two-hour window through 2026-10-25 04:54 UTC (21:54 PDT). Automated refresh prompts, tool payloads and relayed messages are not user authority. Current rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped files are not pending work. Product receipts are lead-reported; this tracker validates the site build only. Existing implementation owners and all earlier history are retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-24 21:44 PDT

**What:** Keep persistent file tabs and usable keyboard focus.

**Why:** Keyboard file navigation must remain correct.

**Current state:** Reopened: at 21:36 PDT the lead reports the production keyboard file-tab test fails because the tab list text is wrong. It passed before; the suspected regression is assigned to the Codex issues/file-tabs/docs repair job, with a failing test first. Cause is not yet established.

**Next step:** Reproduce, retain the regression, repair and rerun hosted keyboard acceptance.

**Open questions for Will:** None required to proceed.

Evidence: lead assistant text replies at 21:34–21:43 PDT, extracted with a small JSONL script from the latest combined two-hour window (2026-10-25 02:43–04:43 UTC). Both supplied transcript paths were checked; absent reboot-wiped briefs are not pending work. Rulings and queue answers govern older plans. Product results are lead-reported; this refresh runs only the maintainer-site build. Execution ownership and prior history are retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-24 03:44 PDT

**What:** Keep file tabs across reloads and preserve keyboard focus when closing a tab.

**Why:** Keyboard closure must persist reliably.

**Current state:** At 03:36 PDT the lead reports that the keyboard-close failure does not reproduce on Latitude and attributes it to the overloaded Mac mini. At 03:43 the lead explicitly says to close this workstream again. This supersedes the 03:24 reopening; no product repair is claimed for the load-dependent failure. Earlier production receipts remain in retained history.

**Next step:** Retain the Latitude confirmation and existing keyboard-close regression; reopen only on new reproducible product evidence.

**Open questions for Will:** None newly required.

Evidence: lead replies extracted by a small JSONL script across both requested transcript paths, latest available two-hour window ending 2026-10-24 10:43:42 UTC. Automated task notifications are excluded from user-typed evidence; no new user-typed ruling appears. Rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving shared briefs. Reboot-wiped briefs are not outstanding work. Product validation is lead-reported; this refresh runs only the maintainer-site build. Codex curates documentation; implementation ownership and prior history are retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-24 03:24 PDT

**What:** Keep file tabs across reloads and preserve keyboard focus when closing a tab.

**Why:** Keyboard tab closure must persist just as pointer closure does.

**Current state:** The lead reports at 03:08 PDT on October 24 that the fourth main-repair full run found a file-tab test where closing a tab from the keyboard is not saved. Reopen this workstream pending the lander’s confirmation on current main. Earlier production passes remain historical receipts; they do not establish the later revision works.

**Next step:** Confirm the failure on current main, retain a regression for keyboard close followed by reload, and collect the repair landing plus local and production acceptance receipts.

**Open questions for Will:** None; the lead and lander own confirmation and repair assignment.

Evidence: lead text reply at 2026-10-24 10:08:50 UTC, within the script-extracted latest available two-hour window, 08:23–10:23 UTC, across both requested transcript paths. Only the original transcript exists here; automated task notifications are excluded from user-typed evidence. No new user-typed ruling appears. Rulings and the 236 queue answers take precedence over older decisions, proposals, TODOs, rules and surviving briefs. Product results are lead-reported, not independently rerun by this tracker refresh. Reboot-wiped briefs are not outstanding work. Existing implementation ownership is retained.

## Earlier tracker history (retained)


## What

Keep file tabs across reloads and preserve keyboard focus when a tab closes.

## Why

Closing a tab must persist before reload, and Delete must leave keyboard navigation usable.

## Current state

File tabs landed with 9f03901b and deployed at 01:59. Production keyboard tests found an extra tab after reload. Repair 36a602fa waited for persistence and deployed at 02:58, fixing reload but exposing lost focus after Delete. The next repair was rejected for useLayoutEffect and replaced by a TanStack DB focus row and callback ref (4e8c78ff); production still failed focus after its 04:32 deploy. Final repair bce9128d fixed focus lost by the blob pending-route remount and added focus telemetry. Deployer reports it live at 05:06, with both files keyboard and workspace tests passing in production.

## Next step

Retain the production regressions and receipts. Conversation /new is a separate blocked workstream.

## Open questions for Will

None.

## Evidence

Evidence: surviving scratchpad/final/LANDER1-STATE.md and DEPLOYER-STATE.md (deployer updated 2026-10-23 05:10 PDT). Script-filtered text across both requested transcripts for 2026-10-23 15:49–17:49 UTC contains context-limit errors, /compact and an automated continuation summary, with no new user product direction; the summary is not a new ruling. Rulings and queue answers govern older decisions, proposals, TODOs and rules. Reboot-wiped briefs are not outstanding work. Receipts above are handoff-reported, not product tests rerun by this curator. Implementation ownership retained; Codex curates documentation.
