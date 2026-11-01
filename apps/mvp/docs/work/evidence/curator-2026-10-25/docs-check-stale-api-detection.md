---
title: Make docs checks reject stale generated API pages
status: todo
area: sdk
owner: Unassigned implementation; Codex owns tracker note
updated: 2026-10-22 15:24 PDT
links: [generated-file-provenance.md, docs-truth-pass.md, docs-check-flow-outcome.md, ../rules.md]
---

**What:** Detect a stale generated API reference page in the docs check.

**Why:** A successful docs check must not accept outdated public API documentation.

**Current state:** At 15:16 PDT the lead reports lander 2 found a stale API reference page that docs check missed. Lander 1 regenerated the page in a later push, so main is current. No repair to the detection gap is reported.

**Next step:** Identify the missed projection, retain a regression that fails on stale generated content and require the docs check to reject it.

**Open questions for Will:** None.

## History

2026-10-22 15:24 PDT: Added from the lead’s recent updates. Evidence: lead text replies extracted by script from the two-hour window ending 2026-10-22T22:23:40Z. Both supplied paths checked; the continuation transcript is absent and recent replies survive in the original. Relayed agent messages and automated tracker prompts are excluded as human authority. Rulings and queue answers govern older docs. Product receipts are lead-reported; this refresh runs the site build only. Existing implementation ownership and all history are retained; Codex owns tracker curation. Reboot-wiped briefs are not outstanding work.
