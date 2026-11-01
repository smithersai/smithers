---
title: Branch-creation test isolation rework
status: done
area: app
owner: Codex tracker (documentation); lead and test-isolation builder (implementation)
updated: 2026-10-24 00:44 PDT
links: [conversations-and-history.md, harness-test-flows.md, main-reds-burn-down.md, ../rules.md]
---

**What:** Rework branch-creation fixture isolation against the landed harness changes.

**Why:** Avoid competing fixture designs and keep branch-creation tests independent.

**Current state:** The retained conversation note records the earlier fixture change bounced for conflicting designs. At 00:39 PDT the lead reports the test-isolation rework landed as 97174ab1, together with a generated-file ordering correction. This closes the rework’s landing; /new itself and the main-check repairs remain queued. No new production or full-suite acceptance claim is made.

**Next step:** Retain the landing receipt and use the isolated fixtures for /new validation; track broader acceptance in the linked notes.

**Open questions for Will:** None.

Evidence: lead text at 2026-10-24 07:39 UTC, from scripted text-only extraction for 05:43–07:43 UTC. Both transcript paths checked; the continuation file is absent at this refresh. No user-typed ruling appears in this window. Current rulings and queue answers govern older docs and surviving briefs. These are lead-reported receipts, not product checks rerun here; reboot-wiped files are not outstanding work. Codex owns documentation curation; implementation ownership and earlier history are retained.
