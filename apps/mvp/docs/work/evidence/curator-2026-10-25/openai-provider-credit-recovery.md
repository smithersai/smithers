---
title: Restore OpenAI provider test credit
status: todo
area: infra
owner: unassigned; lead to assign implementation; Codex curates tracker documentation
updated: 2026-10-24 23:44 PDT
links: [personal-model-keys.md, production-e2e.md, cerebras-eval-quota-exhaustion.md, ../rulings.md]
---

## What

Resolve the exhausted OpenAI key used for production acceptance, or explicitly choose a funded test provider.

## Why

Acceptance needs a usable provider without confusing one exhausted key with a hosted outage.

## Current state

At 23:40 PDT the lead reports the OpenAI key is out of credit, the second provider key exhausted this week after Cerebras. BYOK production tests instead passed using the AI Gateway key. The lead believes production does not depend on the OpenAI key but does not claim verified dependency evidence. No replenishment or funded OpenAI call is reported.

## Next step

Identify the affected configured role and test dependency without exposing values; have the credential owner restore credit or select a funded provider, then retain a real-call receipt. Do not infer spending authorization.

## Open questions for Will

Does Will want the OpenAI test key replenished or acceptance to continue using the funded AI Gateway provider?

Evidence: lead assistant text extracted by script for the combined latest two-hour window ending 2026-10-25 06:43 UTC; both transcript paths were checked. Automated task notifications are not user-typed authority. The 23:40 PDT lead reply confirms production f7dfaadc and BYOK 4/4; LANDER1-STATE.md corroborates the clean gate and empty queue. Rulings and queue answers take precedence over older docs and surviving briefs; wiped scratchpad files are not outstanding work. Existing implementation ownership is retained; Codex curates tracker documentation. Product receipts are reported, not independently rerun here; this refresh validates the maintainer-site build.
