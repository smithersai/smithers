---
title: Choose which model key pays for timeline summaries
status: done
area: app
owner: BYOK builder assigned by lead; Codex curates tracker documentation
updated: 2026-10-25 05:24 PDT
links: [personal-model-keys.md, model-endpoint.md, token-spend-alerts.md, ../rulings.md]
---

## Tracker reconciliation — 2026-10-25 05:24 PDT

**What:** Keep automatic timeline summaries on the deployment model.

**Why:** Avoid charging automatic summaries to personal keys.

**Current state:** At 05:15 PDT the lead reports a0a12649 landed with 4,465 passing app tests at 100% coverage. At 05:18 production matches a0a12649 and all four BYOK cases pass. In that run all 22 summary calls used the deployment model; the personal key paid only for chat and Tests. This supersedes the pending gate and deployment below.

**Next step:** Retain the production routing receipt and BYOK recording.

**Open questions for Will:** None required.

Evidence: text-only script extraction across both requested transcripts, latest combined two-hour window ending 2026-10-25T12:23:50Z. User text and lead replies only; tool payloads, automated notices and API errors are not authority. Current rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped files are not outstanding work. Product receipts are lead-reported, not independently rerun. Codex curates documentation; implementation owners and all earlier history remain.

## Earlier tracker history (retained)


## Evidence refresh — 2026-10-25 05:13 PDT

**What / why:** Keep automatic timeline summaries on the deployment model so personal keys pay for chats and TODO runs.

**Current state:** The latest lead reply at 05:13 PDT supplies no summary landing or deployment receipt. The surviving 04:45 lander handoff still lists builder commit 2a64c493 in gate sm1 on e717d8cc. Status stays in-progress; the shipped BYOK feature is separately done.

**Next step:** Finish the gate, land and deploy, then verify deployment-key summaries and personal-key chat/TODO routing.

**Open questions for Will:** None newly required; the lead treats the earlier “go” as agreement.

Evidence: small-script extraction of user-typed text and assistant text replies across both requested JSONL files, 2026-10-25 10:13:39–12:13:39 UTC; automated notifications, tool payloads and API errors excluded. Results are lead-reported, not independently rerun. Rulings and queue answers govern older material. Reboot-wiped artifacts are not outstanding work. Implementation ownership and all prior history remain; Codex curates documentation only.


## Evidence refresh — 2026-10-25 05:04 PDT

The latest lead reply at 05:04 PDT adds no summary landing or deployment receipt. The surviving lander handoff still places builder commit 2a64c493 in gate sm1 on e717d8cc. Keep in-progress: finish the gate, land and deploy, then verify deployment-key summaries and personal-key chat/TODO routing. No new question for Will.

Evidence: text-only script extraction across both requested transcripts, combined latest two-hour window 2026-10-25 10:04–12:04 UTC. Task notifications, tool payloads and API errors are excluded. Current rulings and queue answers take precedence over older decisions, proposals, TODOs, rules and surviving briefs. The lead reports production CI 5/5 at e717d8cc and BYOK 4/4; those completed workstreams are already recorded. No missing workstream was found. Reboot-wiped files are not outstanding work. Product receipts are reported, not independently rerun; existing execution ownership and all history remain. Codex curates documentation only.


## Tracker reconciliation — 2026-10-25 04:45 PDT

**What:** Keep automatic timeline summaries on the deployment model.

**Why:** Avoid charging automatic summaries to a person’s key.

**Current state:** The lead reports interpreting Will’s earlier go as choosing deployment-model summaries; the underlying typed approval is outside this window. Its 04:35 BYOK explanation confirms summaries still use personal keys in production. The 04:45 lander brief has the change in gate sm1 on e717d8cc, builder commit 2a64c493, with no new migration. No summary deployment or passing routing acceptance is reported.

**Next step:** Finish gate sm1, land, deploy via the assigned BYOK builder, and verify summary versus personal chat/TODO key selection.

**Open questions for Will:** None newly required for this workstream.

Evidence: both requested transcripts were processed by a small JSONL text extractor for 2026-10-25 09:43:39–11:43:39 UTC. Will asks whether BYOK works; the lead supplies its shipped behavior. The surviving LANDER1-STATE.md, updated 04:45 PDT, reports production e717d8cc and ci.spec passing, superseding the earlier deploying replies. These are reported receipts, not tests rerun by this curator. Rulings and 236 queue answers govern older decisions, proposals, TODOs and rules. Reboot-wiped briefs are not outstanding work. Implementation owners and all history are retained; Codex curates documentation only.


## Tracker reconciliation — 2026-10-25 04:33 PDT

**What:** Keep automatic timeline summaries on the deployment model; personal keys pay for chats and TODO runs.

**Why:** Avoid charging automatic summaries to a person’s key.

**Current state:** The lead treats Will’s “go” as choosing deployment-model summaries. Commit e9fc1033 was reported with checks running at 03:58 PDT. At 04:27 the lead changes deployment order: the run-page repair deploys first and summaries follow in the next deploy. No summary landing or production acceptance receipt is reported.

**Next step:** Finish checks and landing, deploy after the run-page repair, then verify summary versus chat/TODO key selection.

**Open questions for Will:** None newly required by the lead.

Evidence: text-only scripted extraction across both requested transcript paths, 2026-10-25 09:33:39–11:33:39 UTC. Both paths exist on this refresh. No human-typed text occurs in the window; task notifications, tool payloads and API errors are excluded as authority. Updates above are lead-reported, not independently rerun. Current rulings and queue answers govern retained decisions, proposals, TODOs, rules and surviving briefs; reboot-wiped briefs are not outstanding work. Codex owns tracker curation only; implementation ownership and history are preserved.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-25 04:03 PDT

**What:** Keep automatic timeline summaries on the deployment model; use the personal key for chats and TODO runs.

**Why:** Avoid charging automatic summary traffic to a person’s key.

**Current state:** At 03:55 PDT the lead says it interpreted Will’s “go” as agreement with the deployment-model recommendation and assigned the BYOK builder. At 03:58 the lead reports commit e9fc1033 with full checks running and a test and decision-record update. This changes designing to in-progress; approval is lead-reported rather than a directly available typed ruling. No landing or deployment receipt is established.

**Next step:** Finish checks, send the change to the lander, deploy alongside the run-page repair, and verify summary versus chat/TODO key selection.

**Open questions for Will:** None newly required by the lead; the billing question is treated as answered in its update.

Evidence: script-extracted text replies in the combined latest two-hour window, 2026-10-25 09:03:40–11:03:40 UTC. Both requested transcript paths were checked; only 6253ecf2 survives here. Automated refresh prompts, task notifications and tool payloads are not human authority. The lead’s 03:55–04:03 PDT replies supply these updates; Will’s underlying “go” is not present as typed text in the available window. Current rulings and all 236 queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped briefs are not pending work. Results are lead-reported, not independently rerun. Codex owns tracker curation only; implementation ownership and earlier history are retained.

## Earlier tracker history (retained)


## What

Decide whether timeline summaries use the deployment model when a person configures a personal key.

## Why

Small automatic summaries can produce substantial personal-key usage.

## Current state

At 23:40 PDT the lead says summaries currently use the personal key too. One test run made 163 calls using about 28,000 tokens; the lead estimates deployment-model summaries at about $0.0002 each. These are reported observations, not a benchmark. The lead recommends deployment-model summaries at 75% confidence. No Will answer is present in the recent typed-text window or queue answers.

## Next step

Obtain Will’s billing choice, then assign a generic model-role/service change with durable-call, metering and isolation acceptance. Preserve current behavior until decided.

## Open questions for Will

Should summaries stay on the deployment model so the personal key pays only for chats and TODO runs?

Evidence: lead assistant text extracted by script for the combined latest two-hour window ending 2026-10-25 06:43 UTC; both transcript paths were checked. Automated task notifications are not user-typed authority. The 23:40 PDT lead reply confirms production f7dfaadc and BYOK 4/4; LANDER1-STATE.md corroborates the clean gate and empty queue. Rulings and queue answers take precedence over older docs and surviving briefs; wiped scratchpad files are not outstanding work. Existing implementation ownership is retained; Codex curates tracker documentation. Product receipts are reported, not independently rerun here; this refresh validates the maintainer-site build.
