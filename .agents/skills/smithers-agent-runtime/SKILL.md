---
name: smithers-agent-runtime
description: Compose or change the Smithers agent loop, host services, model seats, budgets, sandbox limits, or flow-call authorization.
---

# Smithers agent runtime

Read [the agent composition guide](../../../packages/smithers/agent/README.md) and relevant package tests before changing host wiring or agent boundaries. `Agent.Service` owns one cell loop. Cells reach capabilities through `ctx.call` to ordinary flows; `AgentSession` and `AgentAction` adapt that same loop. A foreign CLI agent implements `Agent.Service` rather than adding a second loop.

The host resolves credentialed seats through `SeatResolver`, supplies quota and budget policy, and declares bounded sandbox limits. The completion evaluator is a host decision: select it before opening resources and refuse missing configuration rather than silently using a scripted or unavailable judge in production.

Budget accounting is durable. An unreadable or unwritable ledger is unknown spend and fails closed. `Budget.check` is advisory; a custom provider boundary needs scoped `reserve` and `record` around the real call. Check authorization before opening a journaled activity so a later grant can unblock a parked action. Keep the flow's declared capabilities and effects consistent with the bound implementation; verify recovery and refusal behavior in tests, not only a fresh run.

For model changes, read [the model guide](../../../packages/smithers/agent/model/README.md): canonical requests exclude credentials, which resolve just before transport. Ambient provider keys do not enable live tests; `SMITHERS_LIVE_MODEL_TESTS=1` opts into quota-consuming calls. For command tools, read [the Std guide](../../../packages/smithers/agent/std/README.md): Bash `hermetic` is a lexical check, not OS confinement, and truncated output must stay visibly truncated. For scheduled or webhook launches, read [the triggers guide](../../../packages/smithers/agent/triggers/README.md): retryable claims require a durable `idempotencyKey` dedupe at `RunnerService.start`. For scoring receipts, read [the scorers guide](../../../packages/smithers/agent/scorers/README.md): a completed batch can contain inconclusive observations, and store failures are warnings; verify persistence by readback before claiming a grade was saved.

For host capability composition, read [the kernel guide](../../../packages/smithers/flows/kernel/README.md). Replace the ordinary host service tags with their guarded implementations in place; a parallel protected service lets dependencies bypass the guard. `Path` is intentionally unchecked, so a path service alone is no confinement boundary.

For untrusted execution, read [the sandbox provider guide](../../../packages/smithers/flows/sandbox/README.md) and choose a provider whose documented boundary meets the threat model. The package itself adds no isolation; `DirectorySandbox` is a scratch directory with process lifecycle, not filesystem, user, or network confinement. Verify provider cancellation with its conformance suite.
