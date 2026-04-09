# Workflow alerting, SLOs, and durable alert instances

## Problem

Smithers has metrics and dashboards, but not a first-class alerting model.

Current state:

- dashboards exist, but dashboards are passive
- docs mention using Grafana / PagerDuty externally, but Smithers does not define
  which alerts matter or how alert lifecycle should work
- `DriftDetector` can render an alert element, but that is a workflow-local pattern,
  not a runtime-wide alerting system
- there is no durable alert state for fired / acknowledged / resolved / suppressed
  alerts
- there is no operator inbox for active alerts

This leaves major gaps:

- no standard workflow SLA alerts
- no ack / silence / dedupe behavior
- no shared payload format for routing alerts to external systems
- no distinction between platform alerts and workflow-semantic alerts

## Proposal

Introduce alerting as a first-class Smithers capability with two layers.

### Layer 1: Platform alerts

Prometheus + Alertmanager remain the right place for aggregate platform conditions:

- request error rate
- process memory pressure
- queue depth
- stale heartbeat rate
- gateway connection failures
- retry storm indicators

These are system-level conditions derived from metrics.

### Layer 2: Durable Smithers alert instances

Smithers should also create durable alert instances for workflow and run semantics:

- run failed
- run stalled or heartbeat stale
- approval wait exceeded threshold
- timer wait exceeded threshold
- retry budget exceeded
- token / cost budget exceeded
- repeated tool failures
- workflow-specific alert rules

These alerts should persist as first-class runtime records, not just ephemeral
notifications.

### Alert model

Add a durable alert table, e.g. `_smithers_alerts`:

```sql
CREATE TABLE _smithers_alerts (
  alert_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  rule_name TEXT NOT NULL,
  scope_kind TEXT NOT NULL,         -- system | workflow | run | node
  scope_id TEXT,
  run_id TEXT,
  node_id TEXT,
  severity TEXT NOT NULL,           -- info | warning | critical
  status TEXT NOT NULL,             -- firing | acknowledged | resolved | suppressed
  summary TEXT NOT NULL,
  description TEXT,
  labels_json TEXT,
  payload_json TEXT,
  first_fired_at_ms INTEGER NOT NULL,
  last_fired_at_ms INTEGER NOT NULL,
  acknowledged_at_ms INTEGER,
  acknowledged_by TEXT,
  resolved_at_ms INTEGER,
  silenced_until_ms INTEGER
);
```

### Rule model

Support standard built-in rules first:

- `run_failed`
- `run_stalled`
- `approval_wait_exceeded`
- `timer_wait_exceeded`
- `scheduler_queue_depth_high`
- `retry_budget_exceeded`
- `token_budget_exceeded`
- `tool_error_rate_high`

Then support workflow-defined rules from user config.

### Operator lifecycle

Alerts need explicit lifecycle, not just "fired once":

- fire
- dedupe by fingerprint
- acknowledge
- suppress / silence
- resolve
- re-fire if condition returns

### Surfaces

Expose active alerts through:

- CLI: `smithers alerts`, `smithers alerts ack`, `smithers alerts silence`
- TUI / future devtools alerts panel
- PI overlay / commands
- structured payloads for Alertmanager / webhooks / downstream systems

## Rollout phases

### Phase 1: Built-in rules and persistence

- Define alert record schema and lifecycle.
- Implement a minimal built-in rule set.
- Persist and dedupe firing alerts.

### Phase 2: Operator actions

- Add ack / resolve / silence flows.
- Expose CLI and API surfaces for alert inspection and action.
- Show alert correlation context in output.

### Phase 3: External routing and SLOs

- Ship Prometheus alert rules and Alertmanager examples.
- Support workflow-specific policies and routing labels.
- Add docs for recommended SLOs and default rules.

## Additional steps

1. Keep platform alerts and workflow alerts distinct, but let them share severity,
   owner, and runbook conventions.
2. Add a stable fingerprinting strategy so duplicate evaluations do not create alert
   spam.
3. Add runbook URL and ownership metadata to alert payloads.
4. Support temporary silences without deleting alert history.
5. Preserve alert history after resolution for postmortems and incident review.
6. Avoid shipping built-in Slack / PagerDuty clients; emit standard payloads and let
   routing happen through pluggable delivery mechanisms.

## Verification requirements

### Unit and integration tests

1. **Built-in run failure rule** - A failed run creates a critical durable alert.
2. **Approval SLA rule** - A run waiting for approval beyond threshold creates a
   firing alert with run and node context.
3. **Deduping** - Repeated evaluations of the same active condition update the same
   alert record instead of creating duplicates.
4. **Acknowledge** - Ack transitions an alert to `acknowledged` and records who
   acknowledged it.
5. **Resolve** - When the condition clears, the alert transitions to `resolved`.
6. **Silence** - Silenced rules suppress re-notification while preserving history.
7. **Prometheus rules bundle** - Bundled alert rules load successfully in local
   Alertmanager / Prometheus tooling.

### End-to-end tests

8. **CLI inbox** - `smithers alerts` lists active alerts with severity, owner,
   rule, age, and correlation context.
9. **TUI visibility** - Active alerts are visible alongside run details.
10. **External payload shape** - Alert payloads include runbook, severity, labels,
    and correlation fields expected by downstream systems.

### Corner cases

11. **Flapping condition** - Rapid fire/resolve cycles do not create unbounded alert
    records.
12. **Continue-as-new** - Alerts retain lineage across continued runs where
    appropriate.
13. **Suppressed but unresolved** - The alert remains queryable even while silenced.

## Observability

### New events

- `AlertFired { alertId, ruleName, severity, scopeKind, scopeId, timestampMs }`
- `AlertAcknowledged { alertId, acknowledgedBy, timestampMs }`
- `AlertResolved { alertId, timestampMs }`
- `AlertSilenced { alertId, silencedUntilMs, timestampMs }`

### New metrics

- `smithers.alerts.fired_total{rule,severity}`
- `smithers.alerts.active`
- `smithers.alerts.acknowledged_total{rule}`
- `smithers.alerts.resolved_total{rule}`
- `smithers.alerts.suppressed_total{rule}`
- `smithers.alerts.time_to_ack_ms`
- `smithers.alerts.time_to_resolve_ms`

### Logging

- `Effect.withLogSpan("alert:evaluate")`
- `Effect.withLogSpan("alert:fire")`
- `Effect.withLogSpan("alert:ack")`
- Annotate with `{ ruleName, severity, runId, nodeId, alertId }`

## Codebase context

### Existing behavior

- `src/components/DriftDetector.ts`
- `docs/components/drift-detector.mdx`
- `docs/guides/monitoring-logs.mdx`
- `docs/design-prompts/devtools-prd.md`

### Runtime and surfaces

- `src/effect/metrics.ts`
- `src/observability/index.ts`
- `src/server/index.ts`
- `src/cli/index.ts`
- `src/cli/tui/`
- `src/pi-plugin/extension.ts`

### Adjacent work

- `.smithers/tickets/prometheus-grafana-observability-parity.md`
- `.smithers/tickets/create-smithers-alert-policy-api-and-docs.md`

## Effect.ts architecture

Alert evaluation, persistence, and lifecycle transitions should stay inside Effect.

- Alert firing should be transactional and durable.
- External delivery should happen through explicit boundaries / services.
- Do not model alerts as random side-effect callbacks sprinkled through the engine.
