# Make Alert Policy Execute At Runtime

## Problem

The runtime merges `alertPolicy` into `workflow.opts`, then stops. Nothing evaluates rules, nothing writes `_smithers_alerts`, and the reaction kinds on paper do not affect scheduling or operator flow.

## Proposed Changes

- Create an alert runtime inside `runWorkflowBody` that subscribes to `EventBus` events and polls time-based conditions.
- Evaluate the effective per-run alert policy against the built-in rule registry.
- Persist or reopen alerts through the adapter instead of ad hoc inserts.
- Execute reactions when an alert fires or escalates.

## Reaction Semantics

- `emit-only`
  - Persist the alert and emit alert lifecycle events.
- `cancel`
  - Request run cancellation through the same code path used by operator-driven cancel.
- `pause`
  - Create a linked human request and stop dispatching new work until an operator resumes or cancels.
  - Reuse `waiting-event` with a machine-readable `waitReason: "alert"` instead of inventing a second pause mechanism.
- `open-approval`
  - Create a linked operator decision request backed by `_smithers_human_requests`.
  - Do not inject synthetic workflow nodes into the DAG.
- `deliver`
  - Hand off to the delivery router introduced later, but fire the durable alert first.

## Runtime Requirements

- Time-based rules like approval wait age must be evaluated after restarts, not only in-memory during the original process.
- Recurring identical conditions must reuse the same fingerprint and reopen the alert when appropriate.
- Reactions must be idempotent across resume and replay.
- Alert-generated human requests must link back to the originating alert and run.

## Touch Points

- `src/engine/index.ts`
- `src/events.ts`
- `src/db/adapter.ts`
- `src/human-requests.ts`
- `src/cli/index.ts`
- `src/observability/index.ts`

## Dependencies

- `0001-alert-model-and-policy-snapshot.md`
- `0002-alert-rule-registry-and-event-normalization.md`

## Acceptance Criteria

- A workflow with `alertPolicy.rules.runFailed` writes an alert row when a run fails.
- A workflow with `approvalWaitExceeded.afterMs` fires after the threshold even if the process restarts while waiting.
- `pause` blocks further scheduling until the linked operator request is answered.
- `open-approval` creates an operator request linked to the alert and visible in the unified attention model later.
- Alert firing, reopening, silencing, and resolving are idempotent across replay and resume.
- Integration tests cover at least `runFailed`, `approvalWaitExceeded`, `retryStorm`, and one control-flow reaction.
