---
title: Dropping a TODO cancels its durable run
status: done
area: app
owner: Astra production TODO repair job on Mac mini assigned by lead
updated: 2026-10-22 10:34 PDT
links: [todo-active-run-view.md, todos-and-stack.md, production-e2e.md, observability.md, ../rulings.md]
---

## Tracker reconciliation — 2026-10-22 10:34 PDT

**What:** Cancel a TODO’s durable run when it is dropped.

**Why:** Dropped work must stop consuming resources and leave no child runs.

**Current state:** Push 22 (998199dc) landed and has been live since 10:27 PDT. At 10:30 the lead reports production Drop cancels the run in 3.5 seconds with no child runs left.

**Next step:** Retain the production regression receipts; retry and waiting-fix rebases must preserve this cancellation path.

**Open questions for Will:** None newly required; existing decisions remain in retained history.

Evidence: script-filtered lead replies through 2026-10-22T17:33:43Z, covering approximately 08:34–10:34 PDT. The continuation transcript path is absent; recent replies survive in the original. Current rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped briefs are not outstanding work. Product receipts are lead-reported; Codex curates tracker documentation and runs only the site build. Existing implementation ownership retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 03:04 PDT

**What:** Cancel the durable run when a TODO is dropped.

**Why:** Dropped work must neither start later nor keep consuming resources.

**Current state:** At 02:56 the combined TODO-start/Drop repair is waiting for push 16 because it conflicts with the database repair. A prepared Codex job will rebase it alongside journal fixes and test on Latitude. No deployed cancellation receipt exists.

**Next step:** Rebase after push 16, validate and land; prove Drop before admission and during execution after deployment.

**Open questions for Will:** None newly required; earlier decisions remain in the retained history.

Evidence: script-extracted user-typed messages and lead text replies across both supplied transcript paths, 01:03–03:03 PDT on 2026-10-22. Automated notifications, relayed agent messages, tool payloads and compaction summaries excluded from status evidence. Current rulings and queue answers govern historical docs and surviving briefs. Reboot-wiped files are not outstanding work. Product results are lead-reported; Codex curates documentation and preserves execution ownership.

## Earlier tracker history (retained)

## Tracker reconciliation — 2026-10-22 01:34 PDT

**What:** Cancel a TODO’s durable run when it is dropped.

**Why:** Dropped work must neither start later nor keep consuming sandbox resources.

**Current state:** At 01:27 the lead reports the combined TODO-start/Drop fix written and with lander 1. Its test run was interrupted by Mac mini load, so full Latitude validation is required before landing; no production cancellation pass is reported.

**Next step:** Finish the full tests, land and deploy, then verify Drop before admission and during execution.

**Open questions for Will:** None newly required; unresolved earlier questions remain in history.

Evidence: lead text replies extracted by script, 23:33–01:33 PDT, from session 6253ecf2. The supplied continuation file was not found; recent replies survive in the original transcript. Rulings and queue answers govern older docs and surviving briefs. Product results are lead-reported. Codex maintains tracker documentation; implementation ownership above is retained.

## Earlier tracker history (retained)


**What:** Drop stops an existing run and prevents a racing run from being created.

**Why:** Production failures need observable, durable fixes and real acceptance.

**Current state:** At 00:20 the lead confirms Drop does neither; two test runs still retain their sandbox machines. Astra is assigned the durable cancellation repair.

**Next step:** Cover admission/Drop ordering, cancellation and recovery; deploy and prove runs stop and release held machines.

**Open questions for Will:** None.

Evidence: script-filtered human text and lead replies across the supplied transcript paths, latest two hours through 00:23 PDT; the continuation path is absent at this refresh and recent replies survive in 6253ecf2. Current rulings and queue answers take precedence. Later surviving handoffs are explicitly dated where used. Reboot-wiped briefs are not missing work. Product receipts are reported, not rerun here; Codex curates documentation and retains execution ownership.
