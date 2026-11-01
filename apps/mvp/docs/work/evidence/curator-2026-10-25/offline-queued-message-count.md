---
title: Preserve offline queued-message counts across reloads
status: done
area: app
owner: Codex offline-count repair job assigned by lead; Codex curates tracker
updated: 2026-10-22 09:04 PDT
links: [production-e2e.md, local-first.md, ../decisions/0002-local-first.md, ../rulings.md]
---

## Tracker reconciliation — 2026-10-22 09:04 PDT

**What:** Preserve offline branch conversation queues and counts through reload or restart.

**Why:** Pending messages need an accurate durable count.

**Current state:** At 08:58 the lead confirms the offline tests pass against smithers.sh after the 08:54 deploy. At 09:00 production is identified as fae3a9e2; all six earlier production failures now pass.

**Next step:** Retain the deployed reload/restart regression receipts.

**Open questions for Will:** None.

Evidence: script-extracted user text and lead replies across both requested transcript paths, 07:03–09:03 PDT on 2026-10-22. Rulings and queue answers take precedence over older decisions, proposals, TODOs, rules and surviving briefs. Product receipts are lead-reported; Codex validates the site build only. Implementation ownership retained.

## Earlier tracker history (retained)


**What:** Preserve offline branch conversation queues and their counts through reload or restart.

**Why:** Local-first messages must retain an accurate pending count after the browser restarts.

**Current state:** At 08:37 PDT the lead identifies a real product bug, rather than a faulty assertion. At 08:49 the repair is on main and is the last fix for the six earlier production failures. The next deployment carries it; no deployed acceptance receipt is reported yet.

**Next step:** Deploy pushed main and rerun offline queue/count journeys through reload and restart; retain production receipts before marking done.

**Open questions for Will:** None.

Evidence: lead replies extracted by script from the latest two hours through 08:53 PDT across both supplied transcript paths. Rulings and queue answers govern. Historical production-suite updates remain in production-e2e.md. Product results are lead-reported; this curator validates the site build.
