---
title: Stop in-flight followers when their base TODO is dropped
status: in-progress
area: app
owner: Codex repair job assigned by lead; Codex curates tracker
updated: 2026-10-23 01:04 PDT
links: [todo-predecessor-failure-gate.md, todo-drop-cancels-run.md, todo-merge-event-wakeup.md, hosted-smithers-dogfood.md, ../decisions/0016-todos-and-the-stack.md, ../rulings.md]
---

## Tracker reconciliation — 2026-10-23 01:04 PDT

**What:** Stop in-flight followers immediately when their base TODO is dropped.

**Why:** Followers must not finish obsolete work and open immediately closed pull requests.

**Current state:** At 00:54 the lead reports the repair on main a78c2907; the revision is live since 00:55. The deployer records base-closed-early and migration 0045 in this deployment. No new production drop-during-implementation acceptance receipt is reported.

**Next step:** Retain production evidence for dropping a base during follower implementation, duplicate-event safety and explicit Retry recovery.

**Open questions for Will:** None.

Evidence: script-extracted user-typed text and assistant replies, 2026-10-23 06:04–08:04 UTC, session 6253ecf2; requested continuation 265921d3 unavailable. Rulings and queue answers govern older planning docs and surviving briefs. Product receipts are lead-reported; this tracker validates only the maintainer-site build. Existing implementation ownership and earlier history are retained.

## Earlier tracker history (retained)


**What:** Dropping a TODO immediately stops in-flight TODOs built on its branch through the durable notification mechanism used for merge notices.

**Why:** A follower currently implements a full change before discovering its base was dropped, then opens a pull request that closes immediately.

**Current state:** At 15:35 PDT the production dogfood loop exposes this defect. The lead assigns a Codex repair job. No implementation, landing or acceptance receipt is reported.

**Next step:** Retain a regression for dropping a base during follower implementation, implement durable follower invalidation, and prove prompt stop, duplicate-event safety, cancellation permanence and explicit Retry recovery through the app.

**Open questions for Will:** None.

## History

2026-10-22 15:44 PDT: Codex adds this distinct workstream from the lead’s 22:35:16Z reply. Script extraction covered approximately 20:43–22:43Z across both requested transcript paths; the continuation path is absent, and recent replies survive in the original. Automated notifications are excluded as user authority. Rulings and queue answers govern older docs; reboot-wiped briefs are not missing work. Implementation remains owned by the assigned repair job.
