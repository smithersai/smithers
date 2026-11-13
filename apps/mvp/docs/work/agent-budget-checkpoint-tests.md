---
title: Enforce zero budgets and strengthen checkpoint and replay tests
status: done
area: agent
owner: Codex
updated: 2026-11-13
links: [https://github.com/smithersai/smithers/issues/4973]
---

Zero latency ceilings refuse the first model call and evaluator reading.
Unsupported checkpoint flows and invalid reader paths refuse before checkout.
Regression coverage separates each zero ceiling, fixes the UTC day while
recovering daily spend, compares replayed values and transitions, and follows
journal decisions and completed recovery sweeps without mocks or fixed sleeps.

Validation: 218 agent tests and 90 standard-tools tests pass, together with
both package typechecks and lint. Broader suite and tooling failures are
documented in the linked issue.
