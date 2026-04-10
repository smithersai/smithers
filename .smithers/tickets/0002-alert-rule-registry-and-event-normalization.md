# Add A Built-In Alert Rule Registry And Normalize Input Signals

## Problem

`alertPolicy.rules` is just a bag of names today. There is no built-in rule registry, no documented runtime mapping from rule name to condition, and some of the conditions described in docs and product notes are only implicit in logs or error payloads.

## Proposed Changes

- Introduce a built-in alert rule registry that gives the current rule names real semantics.
- Keep the existing API backward compatible, but extend `SmithersAlertPolicyRule` so the runtime can express thresholds and escalation windows without hard-coded magic.
- Normalize the runtime inputs the registry consumes from persisted `SmithersEvent` rows and scheduler state.

## Built-In Rules To Support

- `runFailed`
- `approvalWaitExceeded`
- `retryStorm`
- `taskHeartbeatTimeout`
- `tokenBudgetExceeded`
- `workflowReloadFailed`
- `workflowReloadUnsafe`
- `providerDisconnected`

## Required Policy Extensions

Add optional fields to `SmithersAlertPolicyRule`:

- `threshold`
- `windowMs`
- `escalateAfterMs`
- `escalateTo`
- `silenceForMs`

These must be optional so existing policy objects remain valid.

## Event Normalization Work

- Normalize budget-exceeded failures from structured Smithers errors into a rule input instead of forcing the evaluator to pattern-match raw strings.
- Normalize provider degradation and recovery from `AgentEvent` streams. The current Codex agent already emits reconnect warnings that can become first-class inputs.
- Add alert lifecycle events so the rest of the system can react without polling:
  - `AlertFired`
  - `AlertAcknowledged`
  - `AlertSilenced`
  - `AlertResolved`
  - `AlertReopened`

## Touch Points

- `src/SmithersWorkflowOptions.ts`
- `src/SmithersEvent.ts`
- `src/engine/index.ts`
- `src/agents/BaseCliAgent.ts`
- `src/agents/CodexAgent.ts`
- `docs/runtime/events.mdx`

## Dependencies

- `0001-alert-model-and-policy-snapshot.md`

## Acceptance Criteria

- Each built-in rule name has a documented runtime condition and test coverage.
- Existing policies without the new optional fields still type-check and behave the same.
- Provider reconnect warnings and budget-exceeded failures become structured alert inputs.
- Alert lifecycle events are emitted and persisted like other `SmithersEvent` records.
- Runtime event docs describe the new normalized events and alert lifecycle events.
