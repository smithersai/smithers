---
title: Stop repeated unacknowledged TODO commits
status: in-progress
area: app
owner: Production TODO-start repair job and deployer; Codex curates tracker documentation
updated: 2026-10-22 00:44 PDT
links: [todo-production-start-latency.md, todo-drop-cancels-run.md, production-database-pooler.md, ../rulings.md]
---

**What:** Give a committed TODO a durable acknowledgement and deduplicate repeat submission.

**Why:** The browser resends a TODO commit every ten seconds while it receives no answer.

**Current state:** At 00:26 the lead identifies repeated browser submission and assigns it as an additional finding for the existing TODO-start repair job. No fix receipt exists.

**Next step:** Trace admission and acknowledgement with safe identifiers; fix the cause through the durable outbox/flow contract, retain a regression for an unresolved response and prove one run per attempt.

**Open questions for Will:** None.

Evidence: script-filtered user-typed text and lead text replies, 22:43–00:43 PDT across both supplied transcript paths; automated notifications, tool results and local commands excluded. The continuation path is absent; recent continuation-era replies survive in 6253ecf2. Current rulings and queue answers govern older plans. Reboot-wiped artifacts are not missing work. Product receipts are lead-reported; Codex curates tracker documentation and retains execution ownership.
