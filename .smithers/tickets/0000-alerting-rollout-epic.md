# Alerting Rollout Epic

## Goal

Make Smithers alerting real end to end:

- `alertPolicy` must execute at runtime instead of stopping at types and docs.
- Approvals and alerts must show up as one operator-facing attention queue.
- Alerts must be actionable, deduped, suppressible, and able to escalate over time.
- Web, CLI/TUI, and PI must use the same attention model and severity language.

## Current Gaps

- `src/SmithersWorkflowOptions.ts` defines alert policy types, but there is no runtime evaluator using `workflow.opts.alertPolicy`.
- `_smithers_alerts` exists and `smithers alerts ...` works, but the local `smithers.db` currently has `0` alert rows.
- Gateway/server/web surfaces aggregate approvals only. Alerts are not part of any live snapshot or operator inbox.
- The web shell badge, run detail banners, CLI/TUI, and PI all represent urgency differently.
- Docs in `docs/guides/alerting.mdx` and `docs/guides/tui.mdx` promise more than the shipped behavior currently delivers.

## Design Direction

- Keep approvals, human requests, and alerts as separate source records.
- Add a unified "attention" read model that unions:
  - pending approvals
  - alert-generated human requests
  - active alerts
- Drive alert evaluation from persisted `SmithersEvent` data plus a small poller for time-based conditions like approval wait age and silence expiry.
- Treat reactions as runtime actions:
  - `emit-only`
  - `cancel`
  - `pause` via human request + scheduler block
  - `open-approval` via a linked operator decision request
  - `deliver` via pluggable destinations

## Rollout Order

1. `0001-alert-model-and-policy-snapshot.md`
2. `0002-alert-rule-registry-and-event-normalization.md`
3. `0003-alert-runtime-and-control-flow-reactions.md`
4. `0004-attention-api-and-gateway-watch-stream.md`
5. `0005-web-attention-center-and-run-surfaces.md`
6. `0006-cli-tui-and-pi-attention-surfaces.md`
7. `0007-delivery-routing-dedupe-and-escalation.md`
8. `0008-docs-telemetry-and-regression-coverage.md`

## Definition Of Done

- A workflow with `alertPolicy` produces durable alert rows in `_smithers_alerts`.
- Active alerts and approvals appear in one live attention inbox with deep links and actions.
- Alert delivery is suppressed when the relevant surface is already focused.
- Repeated identical failures reopen/escalate instead of spamming duplicate notifications.
- The docs describe the behavior that actually ships, and tests cover the core flows.
