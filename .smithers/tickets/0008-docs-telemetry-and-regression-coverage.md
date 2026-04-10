# Align Docs, Telemetry, And Tests With The Shipped Alerting System

## Problem

The docs currently describe a richer alert and notification story than the runtime and operator surfaces actually implement. Shipping the feature set without doc and coverage cleanup will leave Smithers in the same mismatched state again.

## Proposed Changes

- Update the alerting and TUI docs to match the actual implemented behavior and command surface.
- Document the built-in alert rule names, reaction semantics, and unified attention model.
- Add telemetry for alert lifecycle health and notification suppression.
- Add integration coverage across runtime, API, and UI surfaces.

## Required Docs Updates

- `docs/guides/alerting.mdx`
- `docs/guides/tui.mdx`
- `docs/runtime/events.mdx`
- any approval or human-request docs that now reference the unified attention model

## Required Metrics

- alerts fired
- alerts acknowledged
- alerts resolved
- alerts silenced
- alerts reopened
- alerts escalated
- deliveries attempted
- deliveries suppressed by focus
- attention backlog by kind and severity

## Required Test Coverage

- rule firing from persisted events
- reopen and dedupe behavior
- pause and open-approval reactions
- gateway snapshot and websocket updates
- web attention query invalidation and deep links
- CLI or TUI attention actions
- PI attention notifications

## Touch Points

- `docs/...`
- `src/effect/metrics.ts`
- runtime, gateway, server, web, CLI, and PI test suites

## Dependencies

- `0001-alert-model-and-policy-snapshot.md`
- `0002-alert-rule-registry-and-event-normalization.md`
- `0003-alert-runtime-and-control-flow-reactions.md`
- `0004-attention-api-and-gateway-watch-stream.md`
- `0005-web-attention-center-and-run-surfaces.md`
- `0006-cli-tui-and-pi-attention-surfaces.md`
- `0007-delivery-routing-dedupe-and-escalation.md`

## Acceptance Criteria

- The alerting docs describe the built-in rules and reactions that actually ship.
- The TUI and notification docs match the real CLI, TUI, and PI surfaces.
- Metrics exist for the full alert lifecycle and suppression behavior.
- Integration tests cover the core backend flow and at least one operator action in each surface family.
