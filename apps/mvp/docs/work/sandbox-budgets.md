---
title: Sandbox budgets, before we ship
status: done
area: infra
owner: sandbox-ship
updated: 2026-10-25
links: [../features/sandbox-budgets.md, ../decisions/0103-sandbox-budgets.md, ../decisions/0005-sandboxes-secrets-and-the-forge.md, sandboxes.md, token-spend-alerts.md, model-endpoint.md, code-storage-spend-caps.md, design-questions.md]
---

## What

Limits on what branch sandboxes may cost, each an admin setting changed without a deploy, like the model roles ([model endpoint](model-endpoint.md)). The proposed numbers:

| Limit | Proposed | At the limit |
|---|---|---|
| Awake sandboxes, whole deployment | 20 | a new one waits for a slot, shown as "Waiting for a sandbox" |
| Awake sandboxes per person | 2 | same |
| Sandbox spend alert | $100/month | alert to Will, beside the model-spend alert ([token-spend alerts](token-spend-alerts.md)) |
| Snapshots kept | branches touched in the last 30 days | older branches restart from main's snapshot plus their commits |

## Why

A sandbox costs about $14 per branch-month while it stays busy. With zero users the risk is a runaway agent or a forgotten branch.

Will, 22:45 on 2026-10-19, answering design question 8 of 14 (0005 Q3): "Add this as a TODO but we won't worry about this until we ship."

## State

- 2026-10-25: built at ship with the numbers above ([sandbox budgets](../features/sandbox-budgets.md), decision 0103): the ledger and admission (a hard cap, since the `durable_object` policy has no `max_instances`), Waiting for a sandbox on the terminal, the hourly spend alert to the bell, email and Telegram, and the limits in Settings. Snapshot retention waits for snapshots.

- 22:43: asked as design question 8 of 14 ([design questions](design-questions.md)).
- 22:45: deferred until we ship. Decision 0005 records the deferral under Q3, and `todo.md` has the section "Sandbox budgets, before we ship" with three open boxes. Not started.

## Next

Before we ship: set the numbers, build them as admin settings, and route the spend alert through the same `ops/alert` flow as the model and Code Storage alerts ([Code Storage spend caps](code-storage-spend-caps.md)).

## Questions for Will

None until we ship. The alert channel question on [token-spend alerts](token-spend-alerts.md) also serves this alert.
