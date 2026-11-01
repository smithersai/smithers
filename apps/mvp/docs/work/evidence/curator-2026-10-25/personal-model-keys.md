---
title: Use a personal model API key for chat and TODO runs
status: done
area: app
owner: Opus BYOK builder assigned by lead; Codex curates tracker documentation
updated: 2026-10-25 05:24 PDT
links: [byok-and-subscription-research.md, model-endpoint.md, secrets-proxy.md, settings-screen.md, cerebras-eval-quota-exhaustion.md, land-and-deploy-mvp.md, production-e2e.md, ../rulings.md]
---

## Tracker reconciliation — 2026-10-25 05:24 PDT

**What:** Use account-bound personal model API keys for chat and TODO runs.

**Why:** Keep personal model usage independent of deployment quota.

**Current state:** At 05:18 PDT the lead confirms production a0a12649 matches main and all four BYOK production cases pass: bad-key provider/status display, successful Test and agent answer with a real key, Remove, and summary routing. All 22 automatic summary calls used the deployment model. The bad-key display was “ai-gateway.vercel.sh · HTTP 401”. This supersedes the older personal-key summary behavior below.

**Next step:** Retain the production acceptance receipts and BYOK recording.

**Open questions for Will:** None required.

Evidence: text-only script extraction across both requested transcripts, latest combined two-hour window ending 2026-10-25T12:23:50Z. User text and lead replies only; tool payloads, automated notices and API errors are not authority. Current rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped files are not outstanding work. Product receipts are lead-reported, not independently rerun. Codex curates documentation; implementation owners and all earlier history remain.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-25 04:45 PDT

**What:** Use a personal model API key for durable chats and TODO runs.

**Why:** Keep personal calls independent of shared deployment quota.

**Current state:** At 04:35 the lead confirms BYOK is live on smithers.sh with four passing production tests. Settings accepts an OpenAI-compatible or Anthropic-compatible protocol, public HTTPS base URL, model ID and key. Keys are encrypted and account-bound; only the person saves one, while the agent may Test or Remove. Personal usage is separately metered, outside the deployment budget, and failures never silently fall back to the deployment key. Timeline summaries still use the personal key until the separate follow-up deploys.

**Next step:** Retain the shipped BYOK tests and gifs/byok.gif; follow timeline-summary-model-billing.md for the pending routing change.

**Open questions for Will:** None newly required for this workstream.

Evidence: both requested transcripts were processed by a small JSONL text extractor for 2026-10-25 09:43:39–11:43:39 UTC. Will asks whether BYOK works; the lead supplies its shipped behavior. The surviving LANDER1-STATE.md, updated 04:45 PDT, reports production e717d8cc and ci.spec passing, superseding the earlier deploying replies. These are reported receipts, not tests rerun by this curator. Rulings and 236 queue answers govern older decisions, proposals, TODOs and rules. Reboot-wiped briefs are not outstanding work. Implementation owners and all history are retained; Codex curates documentation only.


## Tracker reconciliation — 2026-10-25 04:03 PDT

**What:** Use a personal key for durable chat and TODO calls.

**Why:** Keep personal calls independent of the deployment’s shared model quota.

**Current state:** The existing four passing BYOK production tests remain the completion evidence for the shipped feature. A separate summary-billing follow-up is now in progress at e9fc1033: the lead treats Will’s “go” as choosing deployment-model summaries. This supersedes the older open billing question below; it does not establish the follow-up is deployed.

**Next step:** Retain shipped BYOK receipts and follow the summary-key change in timeline-summary-model-billing.md through checks, landing and production validation.

**Open questions for Will:** None newly required; summary billing is treated as answered by the lead.

Evidence: script-extracted text replies in the combined latest two-hour window, 2026-10-25 09:03:40–11:03:40 UTC. Both requested transcript paths were checked; only 6253ecf2 survives here. Automated refresh prompts, task notifications and tool payloads are not human authority. The lead’s 03:55–04:03 PDT replies supply these updates; Will’s underlying “go” is not present as typed text in the available window. Current rulings and all 236 queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped briefs are not pending work. Results are lead-reported, not independently rerun. Codex owns tracker curation only; implementation ownership and earlier history are retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-24 23:44 PDT

**What:** Use a personal model key for durable chat and TODO calls.

**Why:** Work independently of deployment model quota.

**Current state:** At 23:40 PDT the lead confirms production matches main f7dfaadc and all four BYOK production tests pass. Earlier real-key saving, Test and agent-answer proof stands; the test GIF is ~/Desktop/smithers-mvp/prod/gifs/byok.gif. The follow-up fixes have landed and shipped. Timeline summaries currently use the personal key too; changing that is a separate unresolved decision in timeline-summary-model-billing.md.

**Next step:** Retain the four production receipts and recording; handle summary billing separately.

**Open questions for Will:** Should timeline summaries use the deployment model instead of the personal key? The lead recommends yes at 75% confidence; Will has not answered.

Evidence: lead assistant text extracted by script for the combined latest two-hour window ending 2026-10-25 06:43 UTC; both transcript paths were checked. Automated task notifications are not user-typed authority. The 23:40 PDT lead reply confirms production f7dfaadc and BYOK 4/4; LANDER1-STATE.md corroborates the clean gate and empty queue. Rulings and queue answers take precedence over older docs and surviving briefs; wiped scratchpad files are not outstanding work. Existing implementation ownership is retained; Codex curates tracker documentation. Product receipts are reported, not independently rerun here; this refresh validates the maintainer-site build.

## Earlier tracker history (retained)

## Tracker reconciliation — 2026-10-24 23:24 PDT

**What:** Save a personal model key for durable chat and TODO calls.

**Why:** Work independently of deployment model quota.

**Current state:** At 23:13 PDT the lead confirms BYOK is live on smithers.sh at 19df55b0 and says it checked the site and GIF itself. The test account saved a real key, Test passed, and a real question was answered through that key. This resolves the earlier disagreement between the lead’s pending report and the deployer’s completed receipt. The deployer records migration 0056, clean smoke checks, gifs/byok.gif and removal of the test account’s model afterward. The production-spec and timer-test follow-ups still lack landing receipts; this chat proof does not independently prove browser-closed TODO use or all isolation cases.

**Next step:** Land the fixes in personal-model-key-test-followups.md and collect the remaining TODO/isolation acceptance receipts before closing the complete workstream.

**Open questions for Will:** None required to proceed.

Evidence: small-script extraction across both requested transcript paths, latest combined window 2026-10-25 04:23–06:23 UTC. Only 6253ecf2 exists here; automated refresh prompts, task notifications, relayed agent messages and tool payloads are excluded as user authority. Rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped files are not pending work. Existing implementation owners are retained; Codex curates tracker documentation and validates the site build only.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-24 23:04 PDT

**What:** Save a personal model API key for durable chat and TODO calls.

**Why:** Use personal credentials independently of shared model quota.

**Current state:** The surviving deployer handoff reports 19df55b0 deployed with migration 0056, clean smoke checks and signed-out routes returning 401. personal-model.spec passed on production using spec fix f7dfaadc and a real gateway key; gifs/byok.gif records it, and the test account’s model was removed afterward. This is a specific completion receipt in the saved handoff; the later 23:03 lead reply still calls deployment/proof running, so the two sources disagree. The deployment’s OpenAI key was out of credit; the proof used the gateway key. Status remains in-progress while test fixes land and remaining acceptance is reconciled.

**Next step:** Land the production-spec fix and timer-test repair tracked in personal-model-key-test-followups.md; reconcile the proof with the lead and verify remaining TODO/isolation acceptance before closing.

**Open questions for Will:** None required to proceed.

Evidence: latest combined transcript window 2026-10-25 04:03–06:03 UTC, extracted by a small script as user/assistant text only; the continuation path is absent. The 23:03 lead reply still says deployment/proof are running; DEPLOYER-STATE.md’s explicit 10-24 22:40 entry separately reports completed deployment and proof. The handoff receipt is earlier by its stated time, not chronologically newer; reconcile this discrepancy with the lead. Record that receipt without attributing it to the lead. LANDER1-STATE.md at 23:00 still has the timer-test follow-up bounced. Rulings and queue answers govern older docs; reboot-wiped briefs are not pending work. Existing implementation owners and history are retained; Codex curates these notes and validates only the site build.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-24 22:54 PDT

**What:** Save a personal model API key in Settings for durable chat and TODO calls.

**Why:** Personal keys let people work independently of shared quota.

**Current state:** At 22:45 PDT the lead reports BYOK landed on main as 19df55b0, alongside the production pinning test; all 4,436 app tests pass. The builder is deploying because the deployer is near its usage limit. No completed deployment or real-key production proof is reported. A small follow-up using a timer in a test was returned for repair.

**Next step:** Finish the timer-test repair, collect the deployment receipt, and run the real-key production journey with its GIF.

**Open questions for Will:** None required to proceed.

Evidence: small-script text-only extraction for 2026-10-25 03:53–05:53 UTC. Both supplied transcript paths were checked; only 6253ecf2 exists, and it contains recent lead replies. User authority excludes task notifications, tool payloads and local-command output; Will’s typed instruction is “keep going.” Current rulings and queue answers govern decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped files are not outstanding work. Product receipts are lead-reported; this refresh validates the site build only. Existing implementation ownership is retained; Codex owns tracker curation.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-24 22:24 PDT

**What:** Save a personal model API key in Settings for durable chat and TODO calls.

**Why:** Personal keys let people work independently of shared quota.

**Current state:** At 22:22 PDT the lead reports a two-commit BYOK stack with the lander. The builder’s full test run is still running; landing, deployment and real-key production proof remain pending. The earlier 4,434-test/100% coverage report is a previous receipt, not the result of this new gate.

**Next step:** Collect the full-gate result, landing and deployment receipts, then the deployer’s real-key production proof and GIF.

**Open questions for Will:** None required to proceed.

Evidence: script-extracted user-typed text and lead assistant text replies, 2026-10-25 03:23–05:23 UTC. Both transcript paths were checked: 6253ecf2 exists; 265921d3 is absent. Tool payloads, task notifications and local-command output are excluded. Will’s typed instruction is “keep going.” Current rulings and queue answers override older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped feature/host/panel files are not outstanding work. Product results are lead-reported; this refresh validates only the site build. Existing execution ownership and earlier history are retained; Codex owns tracker curation.

## Earlier tracker history (retained)

## Tracker reconciliation — 2026-10-24 22:14 PDT

**What:** Save a personal model API key in Settings for durable chat and TODO calls.

**Why:** Personal keys allow work independently of shared quota.

**Current state:** BYOK is committed as fb4666f2. At 22:04 PDT the lead says the lander is checking it together with the production pinning test; main is 022caffc. Earlier validation reported 4,434 passing tests at 100% coverage and clean typecheck. No BYOK landing, deployment or real personal-key answer is reported.

**Next step:** Finish landing checks, deploy, then have the deployer run the real-key production proof and retain its GIF. The lead will replace the deployer if its usage limit prevents completion.

**Open questions for Will:** None required to proceed.

Evidence: small-script extraction of user-typed text and lead assistant replies, 2026-10-25 03:13–05:13 UTC. Both requested transcript paths were checked: 6253ecf2 exists and supplies the recent replies; 265921d3 is absent. Automated notifications and tool payloads are excluded. Rulings and all 236 queue answers govern older decisions, proposals, TODOs and rules. Requested scratchpad feature/host/panel/design briefs do not survive; reboot-wiped files are not pending work. Product receipts are lead-reported; this refresh runs only the maintainer-site build. Existing implementation owners and history are retained; Codex owns tracker curation.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-24 21:55 PDT

**What:** Save a personal model API key in Settings for durable chat and TODO calls.

**Why:** Personal keys allow work independently of shared quota.

**Current state:** At 21:49 PDT the lead reports BYOK committed as fb4666f2, awaiting importRules and docs:check before handoff to the lander. The 21:34 report records 4,434 passing tests at 100% coverage and a clean typecheck. No BYOK landing, deployment or real personal-key answer is reported.

**Next step:** Collect the remaining checks and required review receipts, land, deploy and prove real-key chat and TODO calls.

**Open questions for Will:** None required to proceed.

Evidence: user-typed text and lead assistant replies extracted by a small script from both supplied JSONL paths for the combined latest two-hour window through 2026-10-25 04:54 UTC (21:54 PDT). Automated refresh prompts, tool payloads and relayed messages are not user authority. Current rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped files are not pending work. Product receipts are lead-reported; this tracker validates the site build only. Existing implementation owners and all earlier history are retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-24 21:44 PDT

**What:** Save a personal model API key in Settings for durable chat and TODO calls.

**Why:** Personal keys allow work independently of shared quota.

**Current state:** At 21:34 PDT the lead reports 4,434 tests passed at 100% coverage with no typecheck errors. The BYOK builder resumed after the old account weekly limit and is finishing checks for code-review fixes. Landing, deployment and a real personal-key answer remain unproven.

**Next step:** Finish review-fix checks and required reviews, hand off to the lander, deploy, and retain real-key chat/TODO acceptance and recordings.

**Open questions for Will:** None required to proceed.

Evidence: lead assistant text replies at 21:34–21:43 PDT, extracted with a small JSONL script from the latest combined two-hour window (2026-10-25 02:43–04:43 UTC). Both supplied transcript paths were checked; absent reboot-wiped briefs are not pending work. Rulings and queue answers govern older plans. Product results are lead-reported; this refresh runs only the maintainer-site build. Execution ownership and prior history are retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-24 13:14 PDT

**What:** Save a personal model API key in Settings for durable chat and TODO calls.

**Why:** Personal credentials let people work independently of shared model quota.

**Current state:** At 13:05 PDT the lead confirms the rebased full test run is still running, with no result. Astra review was started at 12:52; no completed review is reported. BYOK landing, deployment and a real personal-key answer remain unproven. The f8a2b946 deploy is not a BYOK release.

**Next step:** Collect the full gate and review results, fix findings, complete required review, then land, deploy and retain real-key chat/TODO acceptance and recordings.

**Open questions for Will:** None for the authorized API-key build; subscription login stays separate.

Evidence: script-extracted assistant text replies across both supplied transcript paths, combined latest available window 2026-10-24 18:13–20:13 UTC, and surviving LANDER1-STATE.md. No user-typed text appears in this window after automated notifications are excluded. The continuation path was checked and is absent on this filesystem; the original contains the current lead replies. Rulings and 236 queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped briefs are not pending work. Execution owners and statuses remain unchanged; Codex curates documentation and validates only the site build.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-24 13:04 PDT

**What:** Save a personal model API key in Settings for durable chat and TODO calls.

**Why:** Use server-sealed personal credentials independently of shared quota.

**Current state:** The 12:52 PDT lead reply confirms the build is rebased, with full tests and Astra review running. No completed review, passing gate, BYOK landing, deployment or real-key answer is reported through 13:03. The 12:57 deployment of f8a2b946 does not include a reported BYOK release.

**Next step:** Collect gate and review results, fix findings, finish required review, then land, deploy and prove real personal-key routing.

**Open questions for Will:** None for the authorized API-key build; subscription login remains separate.

Evidence: script-filtered assistant text replies in the combined two-hour window ending 2026-10-24 20:03 UTC. Automated notifications are excluded as user authority. Current rulings and queue answers govern. Product checks are lead-reported; execution ownership and history remain intact. Codex curates documentation only.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-24 12:54 PDT

**What:** Save a personal model API key in Settings and use it for chat and TODO calls through durable public interfaces.

**Why:** Will authorized production BYOK so personal calls can use server-sealed credentials independently of shared quota.

**Current state:** At 12:52 PDT the lead confirms BYOK is rebased onto the new main; its full test run and Codex Astra review are running. This supersedes the earlier pending-rebase state. No passing gate, completed landing, deployment, real-key answer or GIF is reported. Existing isolation, accounting and honest failure requirements remain in force.

**Next step:** Collect full-test and Astra-review results, fix findings, complete required review, then land, deploy and prove real personal-key routing with production recordings.

**Open questions for Will:** None required for the authorized API-key build. Vendor-specific subscription login remains a separate decision.

Evidence: script-filtered user-typed text and assistant text replies, latest combined window 2026-10-24 17:53–19:53 UTC. Automated notifications, tool results and command wrappers are excluded. Transcript 6253ecf2 contains the recent lead replies; the supplied 265921d3 continuation path is absent at this refresh. Rulings and queue answers govern older decisions, proposals, TODOs and rules. FEATURES.md, HOST-PLAN.md and panel/design briefs are absent from the supplied final directory; reboot-wiped files are not outstanding work. Results are lead-reported; Codex curates documentation and validates the site build only. Execution owners and all earlier history are retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-24 12:51 PDT

**What:** Save a personal model API key in Settings and use it for chat and TODO calls through durable public interfaces.

**Why:** Will authorized BYOK so personal calls can use server-sealed credentials independently of the shared provider quota.

**Current state:** At 12:51 PDT the lead confirms the BYOK builder resumed after the usage limit. It was finishing the header settings link so Members can reach their model settings, then rebases onto the new main. No completed landing, deployment, real-key answer or GIF is reported. Existing isolation, accounting and honest failure requirements remain in force.

**Next step:** Finish Member access and rebase; validate, land, deploy and prove real personal-key routing with production recordings.

**Open questions for Will:** None needed for the authorized API-key build. Vendor-specific subscription login remains a separate decision.

Evidence: user-typed text and assistant text replies extracted by script from both supplied transcripts for the combined latest two-hour window, 17:51–19:51 UTC on October 24. Automated task notifications are excluded as user authority. The lead’s 12:51 PDT reply is the latest operational evidence; it supersedes older handoff states. Rulings and 236 queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped files are not outstanding work. Product results are lead-reported; Codex owns tracker curation only and retains execution owners and all prior history.

## Earlier tracker history (retained)


## What

Save one personal model configuration (provider protocol, URL, model and API key) in Settings. Seal the key in the existing server vault; after saving, show only its last four characters. Route that person's chat and TODO model calls through their key, using the deployment model when no personal key is configured. Save, Remove and Test are durable flows available to the agent through the same public interface.

## Why

Will requested implementation working in production at 10:04 PDT on October 24, following the BYOK/subscription comparison. Server-held credentials allow TODOs to continue while every device is off; values must stay out of sandboxes, logs and traces.

## Current state

At 10:05 PDT the lead reports an Opus builder assigned through production acceptance. Usage still counts toward the person's total; the research proposes bypassing the deployment token budget for personal-key calls, with accounting boundaries to verify in implementation. Refused or exhausted personal keys must fail honestly without silently switching to the deployment key. No landing, successful deployment, real-key answer or GIF receipt is reported through 10:13. At 10:08 the lead says BYOK will ship with the next successful deployment; VibeLang deployment bundling remains blocked independently.

This is API-key support, not approval for vendor-specific subscription login. PROC-23's vendor-neutral seam remains in force. Implement as a first-party plugin over public interfaces, injected Effect services, the existing secrets/model SDK services and durable model steps.

## Next step

Finish the assigned build, behavioral coverage and local real-service tests; land, deploy after the build blocker clears, then save a real test-account key on production, obtain an answer through it and retain a GIF. Verify isolation, accounting, removal, refused/exhausted keys and continued TODO use without a browser before calling it working.

## Open questions for Will

None required to finish the authorized BYOK build. Subscription-login exceptions remain separate in the research note.

Evidence: script-filtered user-typed messages and assistant text replies from both supplied transcript paths, combined latest two-hour window 2026-10-24 15:13–17:13 UTC. Automated notifications are not user authority. Current rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving briefs; reboot-wiped files are not outstanding work. Checks and implementation progress are lead-reported; Codex curates documentation only and validates the maintainer-site build. Existing execution ownership and earlier history are retained.
