---
name: smithers-agent-runtime
description: Compose or change the Smithers agent loop, host services, model seats, budgets, sandbox limits, or flow-call authorization.
---

# Smithers agent runtime

Read [the agent composition guide](../../../packages/smithers/agent/README.md) and relevant package tests before changing host wiring or agent boundaries. `Agent.Service` owns one cell loop. Cells reach capabilities through `ctx.call` to ordinary flows; `AgentSession` and `AgentAction` adapt that same loop. A foreign CLI agent implements `Agent.Service` rather than adding a second loop.

The host resolves credentialed seats through `SeatResolver`, supplies quota and budget policy, and declares bounded sandbox limits. The completion evaluator is a host decision: select it before opening resources and refuse missing configuration rather than silently using a scripted or unavailable judge in production.

Budget accounting is durable. An unreadable or unwritable ledger is unknown spend and fails closed. `Budget.check` is advisory; a custom provider boundary needs scoped `reserve` and `record` around the real call. Check authorization before opening a journaled activity so a later grant can unblock a parked action. Keep the flow's declared capabilities and effects consistent with the bound implementation; verify recovery and refusal behavior in tests, not only a fresh run.
