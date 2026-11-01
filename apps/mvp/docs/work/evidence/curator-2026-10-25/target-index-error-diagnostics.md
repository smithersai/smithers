---
title: Expose actionable target-index failure diagnostics
status: in-progress
area: sdk
owner: Codex scoring-recovery builder assigned by lead; Codex owns tracker curation
updated: 2026-10-22 04:14 PDT
links: [durable-scoring-job-recovery.md, observability.md, ../rules.md, ../rulings.md]
---

**What:** Make a failed CLI target-index build name the failure and its diagnostic log.

**Why:** An opaque generic error prevents the agent from diagnosing a dependency from its records (OBS-3 and OBS-4).

**Current state:** At 04:08 PDT the lead reports target-index generation fails only with the scoring repair applied, with “Something went wrong on our side” and no details. The same Codex job is assigned to repair diagnostics before the underlying scoring failure. No fix or passing receipt is reported.

**Next step:** Surface content-free actionable failure details with a regression test; diagnose and fix the scoring/index failure, then rerun index and docs gates on the landing base.

**Open questions for Will:** None.

Evidence: lead reply at 2026-10-22 11:08:13 UTC, script-extracted from session 6253ecf2; current rulings and queue answers govern. Implementation and test results are not inferred from assignment.
