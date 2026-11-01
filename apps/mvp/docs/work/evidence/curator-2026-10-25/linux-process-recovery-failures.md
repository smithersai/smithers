---
title: Repair Linux process restart, signal and cleanup failures
status: in-progress
area: sdk
owner: Separate Codex Linux process repair job assigned by lead; Codex curates tracker
updated: 2026-10-22 15:44 PDT
links: [linux-cancellation-regression.md, main-reds-burn-down.md, ../rules.md, ../rulings.md]
---

## Tracker reconciliation — 2026-10-22 15:44 PDT

**Current state:** At 15:43 PDT the lead reports all nine failures repaired and queued with lander 2. One real Linux host bug failed to treat an exited process’s /proc entry as gone; other changes correct test timing and remove dead code. All 1,301 package tests pass on Linux with full coverage. No landing receipt is reported.

**Next step:** Complete the integrated landing gate and record the landed revision; preserve Linux coverage and process restart, signal and cleanup regression receipts.

**Open questions for Will:** None newly required; previous unresolved questions remain below.

Evidence: lead text replies through 2026-10-22T22:43:40Z, script-filtered over the last two session hours. Both requested transcript paths checked; only 6253ecf2 exists. Automated notifications are excluded as user authority. Rulings and queue answers govern older docs and surviving briefs. Implementation owners and earlier history retained; Codex curates the tracker. Product receipts are lead-reported, not independently rerun here.


**What:** Repair nine existing Linux failures in process restart, signal handling and child-process cleanup tests.

**Why:** A passing focused cancellation suite does not establish safe process recovery or cleanup.

**Current state:** At 15:26 PDT the full package run exposes nine failures also present on main. The lead starts a separate Codex repair job. The package and individual failure names are not reported in the lead replies; the 15:29 receipt of 28 passing runtime tests belongs to the separate cancellation investigation.

**Next step:** Reproduce each failure on Linux, retain behavioral regressions, repair the owning host/runtime services and pass the complete affected suites without retries, raised timeouts or skipped tests.

**Open questions for Will:** None.

## History

2026-10-22 15:34 PDT: Added from the lead’s 15:26 update. Evidence: lead text replies script-extracted from the last approximately two hours, 2026-10-22 13:33–15:33 PDT. Both supplied transcript paths checked; only 6253ecf2 is available and contains the recent replies. No user-typed ruling occurs in this window. Rulings and queue answers take precedence over older docs and surviving briefs; reboot-wiped files are not outstanding work. Product receipts below are lead-reported, not rerun by this tracker refresh. Implementation owners retained; Codex curates documentation.
