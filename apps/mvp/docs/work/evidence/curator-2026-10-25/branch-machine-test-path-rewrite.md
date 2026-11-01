---
title: Repair branch-machine test path rewriting on Latitude
status: in-progress
area: sdk
owner: Codex branch-machine repair job and lander 2; Codex curates tracker
updated: 2026-10-22 07:34 PDT
links: [main-reds-burn-down.md, sandboxes.md, dev-stack-hygiene.md, ../rulings.md]
---

## Tracker reconciliation — 2026-10-22 07:34 PDT

**What:** Restrict test path rewriting to sandbox-user paths.

**Why:** Latitude private temporary directories must remain intact.

**Current state:** The 07:15 repair passed all 20 tests without weakening assertions. At 07:25 the lead reports lander 2 emptied its queue, superseding the earlier waiting-to-land state. No explicit post-landing rerun of this focused suite is given in lead text.

**Next step:** Retain the landed repair and collect its post-landing Latitude validation receipt.

**Open questions for Will:** None.

Evidence: lead text replies script-extracted across both requested transcripts for 05:33–07:33 PDT, 2026-10-22; automated notifications, tool blocks and relayed agent messages excluded from user authority. Rulings and queue answers govern decisions, proposals, TODOs, rules and surviving briefs. No matching feature/host/panel/design briefs survive in the supplied final directory; reboot-wiped files are not outstanding work. Product receipts are reported, not tests rerun by this curator. Implementation owners retained; Codex owns tracker curation.

## Earlier tracker history (retained)


**What:** Restrict the test helper’s path rewriting to sandbox-user paths.

**Why:** Rewriting every path under /home breaks Latitude’s private temporary folders and makes main’s branch-machine tests fail.

**Current state:** At 07:05 the lead reports all 12 tests in the failing file red on main 9039b6ce. At 07:15 the repair is with lander 2; all 20 tests pass, with no assertions weakened. Landing is not yet reported.

**Next step:** Land the repair, rerun the affected Latitude suite and collect a green-main receipt.

**Open questions for Will:** None.

Evidence: script-filtered assistant text replies in the latest approximately two hours through 07:15 PDT on 2026-10-22. Both requested transcript paths were checked; 265921d3 is absent, and recent replies survive in 6253ecf2. No user-typed messages occur in this window; automated notifications and tool blocks are excluded. Rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Wiped scratch files are not outstanding work. Product receipts are lead-reported; this refresh verifies the maintainer-site build only. Execution owners are retained.
