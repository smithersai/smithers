---
title: Restore Cerebras access after eval quota exhaustion
status: in-progress
area: infra
owner: lead and production deployer investigate; Codex curates tracker
updated: 2026-10-24 21:44 PDT
links: [cerebras-rate-limits.md, agent-evals.md, agent-eval-regressions.md, model-budget-recovery.md, model-endpoint.md, production-e2e.md, ../rulings.md]
---

## Tracker reconciliation — 2026-10-24 21:44 PDT

**What:** Restore shared production model access and live evals.

**Why:** People without personal keys need working shared model access.

**Current state:** At 21:36 PDT the lead reports the real-question timeline test passed and the agent answers again on smithers.sh. This supersedes the 21:34 quota-blocked report. Whether quota was topped up or reset is unknown; no resumed live-eval receipt is supplied.

**Next step:** Retain the production answer receipt and verify remaining live evals; do not ask Will to restore access already observed working.

**Open questions for Will:** None required to proceed.

Evidence: lead assistant text replies at 21:34–21:43 PDT, extracted with a small JSONL script from the latest combined two-hour window (2026-10-25 02:43–04:43 UTC). Both supplied transcript paths were checked; absent reboot-wiped briefs are not pending work. Rulings and queue answers govern older plans. Product results are lead-reported; this refresh runs only the maintainer-site build. Execution ownership and prior history are retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-24 12:51 PDT

**What:** Restore shared production model access and live evals.

**Why:** People without personal keys need the deployment model to answer.

**Current state:** The 12:51 PDT lead update explicitly says the production agent still cannot answer until Cerebras quota is fixed. Resumption after the Claude session limit restores builder activity, not production model access. BYOK remains in development and has no production recovery receipt.

**Next step:** Collect separate shared-provider and personal-key recovery receipts; prove real production answers and live evals after the relevant recovery.

**Open questions for Will:** Top up Cerebras or choose a replacement deployment model, and which model?

Evidence: user-typed text and assistant text replies extracted by script from both supplied transcripts for the combined latest two-hour window, 17:51–19:51 UTC on October 24. Automated task notifications are excluded as user authority. The lead’s 12:51 PDT reply is the latest operational evidence; it supersedes older handoff states. Rulings and 236 queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped files are not outstanding work. Product results are lead-reported; Codex owns tracker curation only and retains execution owners and all prior history.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-24 10:14 PDT

**What:** Restore shared production model access and live evals.

**Why:** People without personal keys still need the deployment model to answer.

**Current state:** At 10:07 PDT the lead still reports agent-dependent production tests blocked by Cerebras quota. Will authorized BYOK at 10:04 and the lead assigned its build at 10:05; once deployed and configured it can restore one person's calls, but it does not replenish the shared key or restore access for people without keys. At 10:08 the deployment fails independently. No successful answer, summary or live-eval recovery receipt appears through 10:13. Research and the lead distinguish the existing second-provider failover proposal from BYOK; neither has a production recovery receipt here.

**Next step:** Retain separate shared-provider recovery and BYOK receipts. After quota restoration or a deployment-model change, prove production answers, summaries and live evals; track authorized personal-key implementation in its own note.

**Open questions for Will:** Top up Cerebras or choose a replacement deployment model, and which model? BYOK approval does not answer that shared-provider decision.

Evidence: script-filtered user-typed messages and assistant text replies from both supplied transcript paths, combined latest two-hour window 2026-10-24 15:13–17:13 UTC. Automated notifications are not user authority. Current rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving briefs; reboot-wiped files are not outstanding work. Checks and implementation progress are lead-reported; Codex curates documentation only and validates the maintainer-site build. Existing execution ownership and earlier history are retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-24 08:44 PDT

**What:** Restore production answers, summaries and live evals.

**Why:** Production model access remains unavailable independently of the deployment build hold.

**Current state:** At 08:18 PDT the lead explicitly confirms production still cannot answer questions until Cerebras quota is topped up or Will chooses another model. No recovery receipt or new model-selection ruling appears through 08:43. The 4,352-test app pass and assigned VibeLang bundling repair do not establish restored provider access.

**Next step:** After Will’s quota or model decision, collect successful real production answer, summary and live-eval receipts; retain separate tracking for the deployment hold.

**Open questions for Will:** Top up Cerebras or choose another model? If switching, which model?

Evidence: lead text reply at 2026-10-24 15:18:37 UTC, extracted by a small script across both supplied transcript paths for the latest available combined two-hour window, 13:43–15:43 UTC. Automated task notifications are excluded as user rulings; no user-typed ruling appears in that window. Current rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped briefs are not pending work. Product results are lead-reported; this tracker validates only the maintainer-site build. Existing implementation owners, statuses and history remain intact; Codex curates documentation.

## Earlier tracker history (retained)

## Tracker reconciliation — 2026-10-23 22:14 PDT

**What:** Restore production answers, summaries and live evals.

**Why:** The shared provider account refuses every model call.

**Current state:** The 20:27 lead confirmation identifies the same exhausted Cerebras key in production and evals, with answers down since about 15:48 PDT and summaries stopped. At 21:51–21:53 the lead still reports quota unresolved; the 22:23 lead reply confirms the production model outage still awaits Will’s Cerebras or model decision. No recovery receipt appears through the 22:33 refresh. The earlier forms-and-views score of 1.0 predates the refusal.

**Next step:** After the billing or provider/model decision, retain successful real production answer, summary and live eval receipts. Track refusal alerting separately; its implementation does not restore quota.

**Open questions for Will:** Top up Cerebras or choose another provider/model? If switching, which model? An existing OpenAI key is configuration evidence, not a model-selection decision.

Evidence: script-extracted text across both existing transcript files, 2026-10-24 03:13–05:13 UTC (20:13–22:13 PDT October 23). No user-typed instruction appears in this window; automated task notifications are excluded. Current rulings and 236 queue answers govern historical decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped briefs are not outstanding work. Product receipts are lead-reported; Codex curates tracker documentation and verifies only the site build. Implementation ownership and prior history are retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-23 20:34 PDT

**What:** Restore production answers, summaries and live evals.

**Why:** The shared provider account refuses every model call.

**Current state:** At 20:27 PDT the lead confirms production and evals share the exhausted Cerebras key. Production answers have failed since about 15:48 PDT, and summaries do not run. This supersedes the earlier unconfirmed production impact. At 20:33 the lead still reports the agent down; no recovery receipt exists. Billing or model selection awaits Will.

**Next step:** After Will selects billing recovery or another provider/model, restore access and retain a successful real production answer, summary and eval call. Keep the migration deployment hold separate.

**Open questions for Will:** Top up Cerebras, or switch production to another provider? If switching, which model? The lead reports an OpenAI key already configured; no model choice is authorized by that fact.

Evidence: lead text replies extracted by script from both requested transcript paths, latest available two-hour window 2026-10-24 01:33–03:33 UTC. Automated notifications are not user authority. Rulings and queue answers govern older plans. Results are lead-reported; this tracker refresh executes only the site build. Earlier entries remain history.

## Earlier tracker history (retained)


## What

Restore provider access for real-model evals and establish whether the same exhausted Cerebras account serves production.

## Why

Payment-required refusals stop live evals and may prevent hosted answers. This provider-account incident is distinct from the previously resolved app daily-token budget and the existing capacity/rate-limit campaign.

## Current state

At 20:22 PDT the lead reports the eval key has exhausted its quota and every provider call is refused with “payment required”. At 20:23 the deployer's answer about production account sharing is still pending. Production answer failure is a possibility, not a confirmed incident. The last forms-and-views run scored 1.0 before the refusal; no recovery receipt exists.

## Next step

The lead/deployer checks account sharing without exposing credentials, establishes production impact, and restores access within existing spending authority or brings a concrete billing blocker to Will. Prove recovery with a real eval call and, if affected, a production answer. Keep migration deployment blockers separate.

## Open questions for Will

None actionable until the account and billing requirement are verified. The lead says Will's billing may be needed if production shares this account; that condition remains unconfirmed.

## Evidence

Evidence: lead text replies extracted by script across both requested transcript paths for the latest available two-hour window, 2026-10-24 01:23–03:23 UTC. Relayed agent messages and scheduled prompts are excluded from user authority. Rulings and all 236 queue answers govern older planning docs; surviving briefs were checked and reboot-wiped files are not pending work. Product results are lead-reported. Codex owns tracker curation only; implementation owners and existing statuses are retained.
