# Add Delivery Routing, Focus Suppression, Dedupe, And Escalation

## Problem

Even once alerts fire, Smithers still needs operator-quality delivery behavior:

- repeated identical conditions should not spam
- silencing should expire
- critical items should escalate if ignored
- notifications should be suppressed when the user is already focused on the relevant workspace or run

## Proposed Changes

- Introduce a delivery router that consumes alert lifecycle events and routes them to logical destinations from policy.
- Implement fingerprint-based dedupe and reopen semantics.
- Implement severity escalation and recurrence tracking.
- Add focus-aware suppression so badges still update while noisy delivery channels stay quiet when the relevant UI is already in focus.

## Delivery Tier MVP

- In-app badge
- In-app toast
- Terminal bell / OSC notification
- PI `notify()`

External systems like Slack or PagerDuty should remain pluggable destinations, not hard-coded runtime behavior.

## Dedupe And Escalation Rules

- One active alert per fingerprint.
- Recurrence increments `occurrenceCount` and reopens the alert instead of creating a parallel active row.
- `approvalWaitExceeded` can escalate from warning to critical after a second threshold.
- `retryStorm` escalates based on repeated occurrences in a time window.
- `silencedUntilMs` suppresses delivery only until expiry; it must not permanently hide a recurring issue.

## Focus Suppression

- Web: suppress toast if the relevant run or inbox is already visible.
- TUI: suppress bell if the operator is already on the attention pane or matching run.
- PI: suppress notify when the active context is already the matching run or node.

## Touch Points

- `src/engine/index.ts`
- `src/db/adapter.ts`
- `src/gateway/index.ts`
- `apps/web/src/app/layouts/app-shell.tsx`
- `src/cli/index.ts`
- `src/pi-plugin/extension.ts`

## Dependencies

- `0001-alert-model-and-policy-snapshot.md`
- `0002-alert-rule-registry-and-event-normalization.md`
- `0004-attention-api-and-gateway-watch-stream.md`
- `0005-web-attention-center-and-run-surfaces.md`
- `0006-cli-tui-and-pi-attention-surfaces.md`

## Acceptance Criteria

- Repeated identical alert conditions do not create duplicate active notifications.
- Recurrence reopens previously resolved alerts and increments the occurrence count.
- Silence expires automatically and delivery resumes after the TTL.
- Escalation changes severity and produces a visible lifecycle update.
- Focus suppression prevents redundant toast, bell, or PI notify events while leaving the inbox and badge state correct.
