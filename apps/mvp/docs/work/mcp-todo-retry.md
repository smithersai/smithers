---
title: Retry an existing failed TODO through MCP
status: in-progress
area: mcp
owner: codex-artifact-repair
updated: 2026-11-27
links: []
---

Reuse the stack writer and the hosted TODO execution adapter. Keep the authenticated agent's identity, spending authority, ownership and retry receipt.

The official JSON-RPC tool shares the UI's stack and durable execution host. The writer holds the live grant, repository role, TODO ownership and compute authority across new and repeated receipts. A requeued TODO reports a run only when the host accepted its attempt.

Worker typecheck passed. Eight focused registry, stack HTTP and real Postgres cases passed, covering JSON-RPC invocation, stable replay, revoked grants, ownership and compute eligibility. Coordinated production verification is pending.
