---
title: Make personal-flow concurrent-delete coverage deterministic
status: done
area: app
owner: Mac mini coverage repair job assigned by lead; Codex curates tracker
updated: 2026-10-24 22:14 PDT
links: [app-suite-flakes.md, main-reds-burn-down.md, personal-model-keys.md, ../rules.md]
---

## Tracker reconciliation — 2026-10-24 22:14 PDT

**What:** Exercise personal-flow concurrent deletion deterministically.

**Why:** Coverage must not depend on which operation wins the race.

**Current state:** At 22:04 PDT the lead reports the race-test fix landed on main at 022caffc, with 4,359 app tests passing at 100% coverage. This closes the earlier pending repair.

**Next step:** Retain the deterministic regression and full-gate receipt.

**Open questions for Will:** None required to proceed.

Evidence: small-script extraction of user-typed text and lead assistant replies, 2026-10-25 03:13–05:13 UTC. Both requested transcript paths were checked: 6253ecf2 exists and supplies the recent replies; 265921d3 is absent. Automated notifications and tool payloads are excluded. Rulings and all 236 queue answers govern older decisions, proposals, TODOs and rules. Requested scratchpad feature/host/panel/design briefs do not survive; reboot-wiped files are not pending work. Product receipts are lead-reported; this refresh runs only the maintainer-site build. Existing implementation owners and history are retained; Codex owns tracker curation.

## Earlier tracker history (retained)


**What:** Exercise the personal-flow concurrent-delete branch deterministically.

**Why:** Coverage must prove behavior independently of which operation wins a race.

**Current state:** At 12:56 PDT the lead says a small Mac mini job is repairing the race-dependent test exposed by the green deploy gate. LANDER1-STATE.md identifies worker/PersonalFlows.ts:203 and PersonalFlows.test.ts:254. No completed repair or validation receipt is reported.

**Next step:** Retain a behavioral regression that consistently exercises the concurrent delete, then collect the full coverage and landing receipts without weakening thresholds.

**Open questions for Will:** None.

Evidence: script-extracted assistant text replies from the combined latest two-hour transcript window, 2026-10-24 18:03–20:03 UTC. Automated task notifications and tool content are excluded from user authority; no user-typed ruling appears in this window. The original transcript exists; the supplied continuation file is absent. Current rulings and all 236 queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped briefs are not outstanding work. Product results are lead-reported; Codex curates documentation and runs only the maintainer-site build. Execution owners and earlier history are retained.
