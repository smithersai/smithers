# Prometheus/Grafana observability parity and operator UX

## Problem

Smithers has three different telemetry products today, and they are drifting:

- Grafana reads OTLP-exported metrics through the collector and currently depends on
  `smithers_smithers_*` names because the collector adds a `smithers` namespace on
  top of Smithers' already-prefixed metric names.
- The PI `/smithers-metrics` overlay reads raw `GET /metrics` output directly, but
  several of its hard-coded metric names do not exist.
- The TUI "Telemetry" pane does not consume Prometheus metrics at all; it runs
  bespoke SQLite/event queries and labels the result a "Prometheus Rollup".

This has already created concrete product failures:

- The PI overlay is missing active gauges and most histogram rows because it looks up
  names like `smithers_active_runs` and `smithers_run_duration` instead of
  `smithers_runs_active` and `smithers_run_duration_ms`.
- Grafana queries a different metric namespace than PI and the raw `/metrics`
  endpoint.
- Docs still point Grafana users to port `3000` while the compose stack publishes
  `3001`.

There is also a deeper product gap: the metrics are too low-dimensional for how we
actually use Smithers ourselves in `.smithers/`.

Our internal workflows are multi-stage, multi-agent, and iterative:

- `.smithers/workflows/implement.tsx` runs research, plan, implement, validate,
  and parallel review stages.
- `.smithers/workflows/ticket-implement.tsx` runs looped implement/validate/review
  cycles until approval.

The current Prometheus/Grafana surface mostly answers "is the process generally
healthy?" It does not reliably answer the operator questions we actually need:

- Which workflow is slow or flaky?
- Which stage is the bottleneck?
- Which tool is failing or expensive?
- Which agent/model combination is driving token cost?
- Are approval-gated workflows backing up?

There is also instrumentation drift between server modes:

- `src/server/index.ts` increments `smithers_http_requests` in `sendJson()` /
  `sendText()`.
- `src/server/serve.ts` increments request metrics in Hono middleware for every
  request.

That means the same metric does not have the same semantics across the multi-workflow
server and single-workflow serve mode.

## Proposal

Establish one canonical Smithers telemetry contract and make Grafana, PI, TUI, docs,
and tests all derive from it.

### Canonical contract

- Treat the raw names emitted by `src/effect/metrics.ts` and rendered by
  `renderPrometheusMetrics()` as the canonical metric names.
- Eliminate the extra collector namespace layer, or otherwise centralize the
  translation so consumers do not hard-code different namespaces.
- Add a shared metric catalog describing:
  - metric name
  - type
  - unit
  - optional labels
  - operator-facing description

### Product surfaces

- PI metrics overlay must consume the canonical catalog instead of maintaining its
  own hand-written name list.
- TUI telemetry should stop pretending SQLite aggregates are Prometheus rollups.
  Either:
  - read `GET /metrics` through a shared parser/client, or
  - explicitly position the TUI pane as persisted run analytics, separate from
    Prometheus.
- Grafana dashboards should be generated or at least validated against the same
  catalog so query drift fails tests.

### Instrumentation semantics

- Normalize request counting/latency semantics across `src/server/index.ts` and
  `src/server/serve.ts`.
- Decide exactly which request classes are counted:
  - health
  - JSON API
  - SSE
  - `/metrics`
  - 4xx/5xx responses
- Keep the semantics identical in both server modes.

### Higher-value dimensions

Add bounded labels to the metrics that matter for operators. The goal is better
questions, not cardinality explosions.

Good candidate labels:

- `workflow_name`
- `node_label`
- `tool_name`
- `agent`
- `model`
- `status`

Explicitly do **not** add:

- `run_id`
- free-form prompts
- dynamic file paths

Prefer enriching existing metrics over creating a second parallel family of
"dashboard-only" metrics.

### Grafana experience

Rework the default dashboard from a generic health board into an operator board:

- workflow throughput and failure rate
- node/task latency by workflow and stage
- tool call volume, latency, and error rate by tool
- token usage by agent and model
- approval backlog and wait time
- scheduler depth and concurrency utilization
- process health
- trace drill-downs that align with the same labels

## Rollout phases

### Phase 1: Contract and parity

- Introduce a shared metrics catalog for the canonical Smithers metric surface.
- Fix PI overlay metric names and make them derive from the catalog.
- Fix docs/CLI/compose endpoint drift.
- Add tests that fail if dashboard queries or PI metric names reference unknown
  metrics.

### Phase 2: Semantic alignment

- Unify HTTP request instrumentation across server modes.
- Move TUI telemetry to a shared metrics reader or clearly split it into a
  different analytics surface.
- Remove ad hoc namespace assumptions from Grafana provisioning.

### Phase 3: Operator-grade dimensions

- Add bounded labels for workflow/tool/agent/model/status where useful.
- Upgrade Grafana panels to exploit those dimensions.
- Add trace-to-metrics navigation that uses the same labels and terminology.

## Additional steps

1. Keep one shared Prometheus text parser/helper instead of separate PI/TUI/Grafana
   assumptions.
2. Add a dashboard/query linter that validates every PromQL metric reference against
   the canonical catalog.
3. Decide whether the default Grafana dashboard should be hand-maintained JSON or
   generated from a typed spec.
4. Ensure any labels added to counters/histograms are bounded and documented.
5. Make docs explicitly distinguish:
   - durable event log / SQLite history
   - raw Prometheus metrics
   - OTLP traces
   - Grafana dashboard views
6. Avoid adding "temporary" alias metric names; that will just preserve drift.

## Verification requirements

### Unit and integration tests

1. **PI overlay parity** - Every metric name referenced by the PI metrics overlay
   exists in the canonical catalog or is a valid histogram suffix (`_bucket`,
   `_sum`, `_count`).
2. **Grafana query parity** - Every PromQL query in the provisioned dashboard
   references known metric names.
3. **Docs parity** - Observability docs, CLI output, and compose files agree on the
   same Grafana/Prometheus/Tempo endpoints.
4. **Server mode parity** - Equivalent requests against `startServer()` and
   `createServeApp()` produce the same `smithers_http_requests` and
   `smithers_http_request_duration_ms_*` semantics.
5. **Metrics disabled** - Surfaces fail clearly when `/metrics` is disabled rather
   than silently showing partial or fake data.
6. **Collector parity** - The local OTLP -> Prometheus -> Grafana stack shows the
   same logical metric names expected by the canonical contract.

### End-to-end smoke tests

7. **Implement workflow visibility** - Run `.smithers/workflows/implement.tsx` and
   verify that Prometheus/Grafana can show workflow-level progress, token usage, and
   tool activity.
8. **Ticket loop visibility** - Run `.smithers/workflows/ticket-implement.tsx` and
   verify that review/validation loops, approvals, and wait time appear in the
   operator surfaces.
9. **Tool breakdown** - A workflow with several tool calls shows per-tool counts,
   error rate, and latency.
10. **Agent/model breakdown** - Token metrics are explorable by `agent` and `model`
    without requiring SQLite log inspection.

### Corner cases

11. **No OTLP collector** - Raw `/metrics` still works and local operator surfaces
    remain useful.
12. **Namespace regression** - If the collector reintroduces a prefix that changes
    names, tests fail immediately.
13. **High-cardinality protection** - New labels do not allow unbounded values such
    as run IDs, prompts, or arbitrary file paths.

## Observability

### New events

No new top-level events are required for the initial fix. Reuse the existing event
stream and improve the metrics contract first.

### Metrics and labels

Prefer evolving the existing metric family instead of introducing a parallel one.

Required outcomes:

- one canonical metric namespace
- consistent histogram naming with `_ms` suffixes preserved
- documented labels for workflow/tool/agent/model/status where added
- no duplicate `smithers_smithers_*` vs `smithers_*` consumer split

### Logging

- Add clear startup logs showing which observability surfaces are enabled:
  - raw `/metrics`
  - OTLP export
  - Grafana stack endpoints
- Annotate parity/lint failures clearly in tests so drift is actionable.

## Codebase context

### Product and dogfooding context

- `.smithers/workflows/implement.tsx`
- `.smithers/workflows/ticket-implement.tsx`
- `docs/design-prompts/devtools-prd.md`

### Metrics and transport

- `src/effect/metrics.ts`
- `src/observability/index.ts`
- `src/server/index.ts`
- `src/server/serve.ts`

### Operator surfaces

- `src/pi-plugin/extension.ts`
- `src/cli/tui/components/MetricsPane.tsx`
- `observability/grafana/dashboards/smithers-dashboard.json`
- `observability/otel-collector-config.yml`
- `observability/docker-compose.otel.yml`
- `docs/guides/monitoring-logs.mdx`

## Effect.ts architecture

Keep instrumentation and metric definition logic in Effect-based runtime code.

- Metric definitions remain centralized in `src/effect/metrics.ts`.
- Prometheus rendering and metric catalog logic should remain shared library code,
  not duplicated in PI or TUI.
- CLI, PI, TUI, and Grafana are consumers of the contract, not independent sources
  of truth.

Do not solve this by adding more one-off adapters with their own metric-name maps.
