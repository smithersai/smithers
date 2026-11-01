---
title: Move model timing persistence behind an injected host service
status: done
area: sdk
owner: Mac mini Codex repair job assigned by lead; Codex curates tracker documentation
updated: 2026-10-22 02:52 PDT
links: [../rulings.md, ../rules.md, model-host-effect-boundary.md, agent-review-finding-repairs.md]
---

## Tracker reconciliation — 2026-10-22 02:52 PDT

**What:** Move model timing persistence behind an injected host service.

**Why:** Keep platform filesystem access in host packages.

**Current state:** At 02:51 PDT the lead reports lander 2 merged the timing repair to main. The earlier receipt reports no filesystem access by default, full coverage and a clean review. This closes the repair finding.

**Next step:** Retain the regression and review receipts; deployment tracking remains separate.

**Open questions for Will:** None newly required; earlier unresolved questions remain in the history.

Evidence: script-filtered user-typed text and lead replies, 00:51–02:51 PDT, session 6253ecf2. Tools, automated notifications and compaction summaries excluded. The supplied continuation transcript is unavailable; recent replies survive in the original file. Rulings and queue answers govern older decisions, proposals and surviving briefs. Reboot-wiped files are not missing work. Product receipts are lead-reported; Codex curates documentation and retains implementation ownership.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 01:54 PDT

**What:** Move model timing persistence behind an injected host service.

**Why:** Platform filesystem access belongs in host packages.

**Current state:** At 01:49 the lead reports the timing fix finished, with no filesystem access by default, full test coverage and a clean review. The commit is with lander 2; no landing receipt is reported.

**Next step:** Collect landing receipt and verify the public model package remains platform-neutral.

**Open questions for Will:** None newly required.

Evidence: lead text replies filtered by script from the latest two hours through 01:53 PDT in session 6253ecf2. The supplied continuation path is absent; recent replies survive in the original transcript. Rulings and queue answers govern older docs and surviving briefs. Reboot-wiped files are not missing work. Product receipts are lead-reported; implementation ownership is retained; Codex curates this note.

## Earlier tracker history (retained)


**What:** Move the model package timing helper’s direct disk writes behind an injected service in the host packages.

**Why:** SDK-4 requires platform access to live in host packages, so the model package can run on every supported platform.

**Current state:** At 01:29 PDT the lead reports the review finding and a Codex repair job running on the Mac mini. No implementation, test or landing receipt is reported. This is separate from the completed model-host Effect-boundary cleanup.

**Next step:** Implement the host service and inject it into the helper; preserve timing behavior with regression tests, verify portable imports, and obtain review and landing receipts.

**Open questions for Will:** None; the platform boundary is already ruled.

History: Added by Codex from script-filtered lead text in session 6253ecf2, latest two hours through 01:33 PDT. Current rulings and queue answers take precedence over older docs. Product checks were not rerun by the tracker.
