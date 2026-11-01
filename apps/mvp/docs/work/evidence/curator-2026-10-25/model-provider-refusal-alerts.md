---
title: Alert on model provider refusals and stop futile retries
status: in-progress
area: app
owner: Codex implementation job assigned by lead; Codex curates tracker
updated: 2026-10-23 20:34 PDT
links: [cerebras-eval-quota-exhaustion.md, observability.md, model-endpoint.md, durable-answering.md, production-e2e.md, ../rulings.md, ../rules.md]
---

## What

Alert when the provider refuses model calls, show “model unavailable”, and stop repeatedly retrying permanent refusals through the existing durable runtime.

## Why

The lead reports the production agent outage went unnoticed for about 4.5 hours. Spend alerts alone did not expose unavailable model service.

## Current state

At 20:27 PDT the lead reports a Codex job implementing these changes. No implementation, passing regression, landing or production alert-delivery receipt is reported. This repair is separate from restoring account quota.

## Next step

Finish the refusal classification, durable retry policy and visible failure state. Prove alert delivery and bounded retries with faulty injected provider services, preserve content-free telemetry, then retain review, landing and hosted acceptance receipts. Successful model calls still require provider recovery.

## Open questions for Will

None required for this repair. Billing and model choice stay in the separate quota incident.

Evidence: lead text replies extracted by script from both requested transcript paths, latest available two-hour window 2026-10-24 01:33–03:33 UTC. Automated notifications are not user authority. Rulings and queue answers govern older plans. Results are lead-reported; this tracker refresh executes only the site build. Earlier entries remain history.
