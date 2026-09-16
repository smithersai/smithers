# Agent and flow health policy

This page summarizes the intended health contract in `docs/design/agent-flow-health.md`. It does not certify implementation or current deployment behavior.

## Authority

Control and PTY lifecycle remain authoritative. Observational callbacks must not approve, resume or establish terminal success. Unknown exit outcome is not success, and a nonzero exit is failing.

## Activity and freshness

Quiet or chatty output alone must not establish semantic activity. Unobserved or stale nonterminal work has unknown activity and health. Known authoritative waits and terminal states retain their meanings. Only a configured semantic checker may report working, idle or needs-input.

## Delivery

Health publication must use committed evidence and incarnation scoping. Alert delivery requires a real configured sink; a noop sink must not claim delivery. Read receipts are separate from health.
