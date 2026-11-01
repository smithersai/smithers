---
title: Run repository check scripts as durable sandbox jobs
status: in-progress
area: sdk
owner: sandbox builder assigned by lead; Codex curates tracker
updated: 2026-10-22 14:04 PDT
links: [sandboxes.md, ci-parity-long-commands.md, hosted-smithers-dogfood.md, cloudflare-engine-drive-time-budget.md, ../rulings.md]
---

## Tracker reconciliation — 2026-10-22 14:04 PDT

**What:** Run repository checks as durable detached sandbox jobs and collect their real outcomes.

**Why:** Long commands must survive host execution windows and return their actual result.

**Current state:** At 13:25 PDT the lead reports a production TODO completed one twenty-minute detached command: checked 28 times, settled once successfully, then resumed. This supersedes the earlier unproven direct-TODO state. The browser harness caller-timeout fix remains with lander 1; no landing or deployed browser regression pass is reported.

**Next step:** Retain the twenty-minute production receipt; land and deploy the separate caller repair, then verify browser result collection, cancellation and single launch.

**Open questions for Will:** None newly required.

Evidence: script-extracted lead text replies in the two-hour window ending 2026-10-22T21:03:39Z; product receipts are reported, not rerun here. Both transcript paths checked; the continuation path is unavailable. Current rulings and queue answers govern older docs and surviving briefs. Implementation ownership is retained; Codex curates documentation.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 13:24 PDT

**What:** Run repository checks as durable detached sandbox jobs and collect their real outcomes.

**Why:** The caller must wait long enough to receive a completed command result.

**Current state:** At 13:13 PDT the lead reports the long-command repair with lander 1: a flat 600-second harness tool-call ceiling cut off the result even though the server command completed. The caller repair is separate from push 24’s one-hour command cap and the continuing command-speed work. No production acceptance receipt for the repaired caller or twenty-minute TODO test is reported.

**Next step:** Land the caller repair, deploy with no command in flight, and prove browser tool collection and direct TODO waiting in production, including completion, cancellation and single launch.

**Open questions for Will:** None newly required.

Evidence: lead text replies through 20:23 UTC, script-filtered from the latest approximately two hours across both requested transcript paths. Automated notifications and relayed agent reports are excluded from human authority. Current rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped files are not outstanding work. Product receipts are lead-reported; Codex maintains documentation and validates the site build. Implementation ownership is retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 13:04 PDT

**What:** Run repository checks as durable detached sandbox jobs and collect their real outcomes.

**Why:** A completed server command must reach its caller reliably.

**Current state:** The 12:54 PDT production rerun found a real failure after the earlier disk-related recording failure: the 570-second command completed, but its tool stopped at exactly 600 seconds with roughly 67 seconds of overhead. At 12:55 the lead confirms the one-hour cap alone does not repair the caller deadline. Push 24 is on main at 12:57; its deployment and twenty-minute direct TODO job-wait test are pending.

**Next step:** Repair caller result waiting with the command-speed builder and rerun production acceptance, including browser tool and direct TODO wait. Retain completion, cancellation and exactly-once collection evidence.

**Open questions for Will:** None newly required.

Evidence: lead text replies at 19:54–19:58 UTC, script-extracted from the latest two-hour transcript window ending 20:03:40 UTC. Both requested paths were checked; only the original is present. Automated notifications are not human instructions. Rulings and queue answers govern historical decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped files are not outstanding work. Product results are lead-reported; Codex curates documentation and runs the site build. Implementation ownership is retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 12:38 PDT

**What:** Run repository checks as durable detached sandbox jobs.

**Why:** Commands must survive bounded engine drives and collect completion once.

**Current state:** Push 23 (90ea5caf) deployed the sandbox command jobs at 12:04, with clean smoke checks and a passing agent-tools test in the surviving deployer state. At 12:37 the lead confirms the ten-minute production command settled once; its browser test failed from local disk exhaustion and is being rerun. The separate one-hour cap remains queued for a later push; no production acceptance of that cap is established.

**Next step:** Retain a passing production result-collection rerun; land and deploy the separate hour-cap stack only with no sandbox command running.

**Open questions for Will:** None newly required.

Evidence: lead text at 19:31–19:37 UTC, script-extracted from the latest approximately two hours across both requested transcript paths; only the original exists. DEPLOYER-STATE.md corroborates push 23. Rulings and queue answers govern older docs. Reboot-wiped briefs are not outstanding work. Product receipts are reported, not rerun by this curator. Implementation ownership is retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 12:14 PDT

**What:** Run repository checks as durable detached sandbox jobs.

**Why:** Commands must survive bounded engine drives and collect completion once.

**Current state:** The 11:34 PDT update places the rebased command fixes with lander 1. At 12:07 the lead also reports the one-hour command cap built and queued, with a real sixteen-minute command completing cleanly. These are reported validation receipts; landing and production acceptance are not yet reported. Command overhead remains separate.

**Next step:** Complete the integrated gate, deploy only when no sandbox command is running, then verify production result collection and configured deadlines.

**Open questions for Will:** None newly required; current rulings supersede historical questions below.

Evidence: script-filtered assistant text replies within 17:13–19:13 UTC on October 22 in session 6253ecf2. No human-typed text appeared in that window; automated notifications and tool content excluded. The supplied continuation transcript is absent even after filename search; continuation-era replies survive in the original. Rulings and queue answers govern historical decisions, proposals, TODOs, rules and surviving briefs. Wiped briefs are not outstanding work. Product checks are lead-reported. Existing implementation owners retained; Codex owns this tracker reconciliation.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 11:34 PDT

**What:** Run repository checks as durable sandbox jobs.

**Why:** Long commands must survive bounded engine drives and collect their results once.

**Current state:** At 11:34 PDT the lead confirms the sandbox command fixes are rebased onto push 22 and waiting for lander 1. Earlier validation passed 3,134 app tests, types, docs and the ten-minute Mac mini command journey. No new landing or production receipt exists.

**Next step:** Complete the integrated landing gate, deploy and verify production command execution; command overhead is a separate workstream.

**Open questions for Will:** None newly required.

Evidence: lead text replies through 2026-10-22T18:34:08Z, script-extracted from the latest approximately two hours. Both supplied transcript paths were checked; the continuation file is unavailable and recent replies survive in the original. Current rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Wiped scratchpad files are not outstanding work. Product checks are reported receipts; Codex curates documentation and verifies the site build. Implementation ownership is retained except the newly assigned recovery job.

## Earlier tracker history (retained)

## Tracker reconciliation — 2026-10-22 10:34 PDT

**What:** Run repository checks as detached durable sandbox jobs.

**Why:** Long checks must survive bounded engine drives and collect results once.

**Current state:** The 10:21 final check passed 3,134 app tests, types, docs and the ten-minute Mac mini command test. At 10:31 the lead confirms the sandbox builder must rebase the stack before lander 1 can take it.

**Next step:** Complete rebase and validate the integrated stack, then land and verify production check execution.

**Open questions for Will:** None newly required.

Evidence: script-filtered lead replies through 2026-10-22T17:33:43Z. Continuation transcript unavailable; original includes recent replies. Rulings and queue answers govern older documentation; wiped briefs are not missing work. Product validation is lead-reported; this curator runs only the site build. Implementation ownership retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 10:24 PDT

**What:** Run repository checks as durable detached sandbox jobs.

**Why:** Full lint and checks must survive bounded engine drives and collect each result once.

**Current state:** At 10:21 PDT the lead reports final validation passed: all 3,134 app tests, type checks, docs and the ten-minute real-command test on the Mac mini. Earlier interrupted attempts came from a Docker restart and a dev-server reload killing a container. The reviewed sandbox-command batch is queued after the TODO stacks; no landing or production acceptance receipt is reported.

**Next step:** Let the lander rebase and land the validated batch, deploy it, and prove full repository checks finish and collect once. Track the detached-only raised cap and over-fifteen-minute proof separately in ci-parity-long-commands.md.

**Open questions for Will:** None newly required.

Evidence: script-filtered user text and lead replies through 2026-10-22T17:23:40Z. Both requested transcript paths were checked; the continuation path is absent, and recent replies survive in the original. Rulings and queue answers govern older planning documents and surviving briefs. Reboot-wiped files are not outstanding work. Product validation is lead-reported; this curator runs only the site build. Existing implementation ownership and all history are retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 09:04 PDT

**What:** Run repository check scripts as durable detached sandbox jobs.

**Why:** Full lint and check must survive bounded engine drives.

**Current state:** At 09:02 the lead reports four commits with lander 1: local user-setup hang fix, passing ten-minute E2E, check scripts as detached jobs and a work note. All 3,134 app tests passed. Landing and deployed full-check acceptance remain unconfirmed; the raised command cap is a separate batch.

**Next step:** Land and deploy the batch, then prove full checks finish and collect results once.

**Open questions for Will:** None newly required.

Evidence: script-extracted user text and lead replies across both requested transcript paths, 07:03–09:03 PDT on 2026-10-22. Rulings and queue answers take precedence over older decisions, proposals, TODOs, rules and surviving briefs. Product receipts are lead-reported; Codex validates the site build only. Implementation ownership retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 08:53 PDT

**What:** Run repository check scripts through durable detached sandbox jobs.

**Why:** Repository checks must survive host execution limits.

**Current state:** At 08:48 PDT review fixes for detached-command scripts are with lander 1. The builder traced the local E2E hang to sandbox setup waiting on an unread error stream filled by a useradd warning, and fixed it. The ten-minute test is rerunning on the mini after Docker killed the previous run. The check-scripts-as-jobs commit follows a passing result; completion is unconfirmed.

**Next step:** Collect the real-sandbox test result, finish and land check-script migration, then prove checks resume and collect results once.

**Open questions for Will:** None newly required.

Evidence: lead replies script-extracted from the latest two hours across both requested transcript paths, through 08:53 PDT. Current rulings and queue answers govern; product results are lead-reported. Implementation owners retained; Codex curates tracker documentation.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 07:34 PDT

**What:** Move Checks.ts scripts onto durable detached sandbox jobs.

**Why:** Full repository checks must outlast host execution limits.

**Current state:** At 07:32 the successor sandbox builder is assigned this migration after diagnosing the long-command e2e failure. Production statuses already work, but that does not establish detached check-script execution.

**Next step:** Complete the migration through the public sandbox contract and prove interruption, resumption, cancellation and single launch with real checks.

**Open questions for Will:** None.

Evidence: lead text replies script-extracted across both requested transcripts for 05:33–07:33 PDT, 2026-10-22; automated notifications, tool blocks and relayed agent messages excluded from user authority. Rulings and queue answers govern decisions, proposals, TODOs, rules and surviving briefs. No matching feature/host/panel/design briefs survive in the supplied final directory; reboot-wiped files are not outstanding work. Product receipts are reported, not tests rerun by this curator. Implementation owners retained; Codex owns tracker curation.

## Earlier tracker history (retained)


**What:** Move Checks.ts check scripts onto the same durable detached-command jobs as the TODO agent's sandbox commands.

**Why:** Dogfood step 4's full-monorepo lint and check scripts must survive Cloudflare's fifteen-minute host execution limit.

**Current state:** At 06:57 PDT the lead confirms the sandbox builder has moved on to this migration after handing the command repair to lander 1. No finished migration, landing or passing check-script end-to-end receipt exists.

**Next step:** Use the public @smthrs/sandbox SandboxCommand / ExternalJob contract through the existing flow engine; prove host interruption, resumption, exit-status collection, cancellation and single launch. Land and deploy, then run the real step-4 checks. No app-owned retry or redispatch loop.

**Open questions for Will:** None.

Evidence: lead text reply at 06:57:06 PDT, script-extracted from the latest two-hour window across the requested transcripts; surviving deployer and lander briefs supply prerequisite context. DUR-1–3 and TEST-1/4 govern acceptance; current rulings and queue answers override older proposals. This is a separate check-script adoption workstream, not completion of the command primitive or dogfood journey. Implementation ownership belongs to the assigned sandbox builder.
