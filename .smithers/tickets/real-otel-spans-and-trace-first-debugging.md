# Real OTEL spans and trace-first workflow debugging

## Problem

Smithers talks about traces, Tempo, and OTLP export, but the current trace story is
not actually first-class.

The biggest issue is structural:

- `SmithersObservability.withSpan()` currently wraps effects with
  `Effect.withLogSpan`, not a real OTEL span
- most runtime code also uses `Effect.withLogSpan(...)`
- the Grafana dashboard has a Tempo traces panel, but span semantics and attributes
  are not well-defined

That means Smithers currently has log-span naming, not a true trace-first debugging
experience.

Without real spans and a clear taxonomy:

- Tempo queries are shallow or inconsistent
- there is no reliable parent/child trace tree for runs, nodes, tools, and waits
- there is no clean bridge from a slow metric to a representative trace
- operator debugging still falls back to raw logs and SQLite inspection

## Proposal

Make OTEL spans real, intentional, and central to workflow debugging.

### Infrastructure

- Change `SmithersObservability.withSpan()` to create actual spans, not only log
  spans.
- Keep log spans if they add value, but make them complementary to real tracing
  instead of the primary mechanism.
- Add a shared helper for applying the standard Smithers attributes to every span.

### Span taxonomy

Define a stable span hierarchy:

- `server:request`
- `gateway:rpc`
- `engine:run`
- `engine:schedule-turn`
- `node:attempt`
- `agent:call`
- `tool:call`
- `approval:wait`
- `approval:resolve`
- `signal:wait`
- `signal:send`
- `timer:wait`
- `db:query`
- `db:transaction`
- `sandbox:bundle`
- `sandbox:execute`
- `sandbox:diff-review`
- `vcs:jj`
- `memory:*`
- `rag:*`
- `openapi:*`

The goal is that a single trace can explain why a run was slow, blocked, retried, or
failed.

### Required attributes

Add a standard attribute set:

- `smithers.run_id`
- `smithers.workflow_name`
- `smithers.node_id`
- `smithers.iteration`
- `smithers.attempt`
- `smithers.node_label`
- `smithers.tool_name`
- `smithers.agent`
- `smithers.model`
- `smithers.status`
- `smithers.wait_reason`

### Propagation

Propagate trace context across:

- HTTP requests
- gateway RPC
- run start / resume
- sandbox boundaries where technically possible
- child process / tool boundaries where technically possible

Where propagation is impossible, annotate the discontinuity explicitly instead of
pretending it did not happen.

### Trace-first UX

Make traces an operator workflow, not an afterthought:

- metric charts link to representative traces via exemplars where possible
- run / node views expose trace IDs
- docs teach users how to move from a failed or slow run to the right trace
- Grafana / Tempo dashboards use the same vocabulary as logs and metrics

## Rollout phases

### Phase 1: Real spans

- Convert `SmithersObservability.withSpan()` to real OTEL spans.
- Add standard span attribute helpers.
- Preserve existing log output behavior where useful.

### Phase 2: Runtime coverage

- Instrument the major runtime paths with the agreed taxonomy.
- Add status / error handling so failed spans are clearly visible.
- Cover waits and handoffs, not just request/response work.

### Phase 3: Operator workflow

- Add trace IDs to CLI / TUI / PI where useful.
- Add metric-to-trace navigation patterns and docs.
- Improve the default Grafana / Tempo experience around trace search.

## Additional steps

1. Keep span names stable and documented; avoid per-module naming drift.
2. Attach business-useful attributes, not giant blobs of prompt text or raw payloads.
3. Add sampling guidance so production traces stay affordable.
4. Add explicit error status and exception metadata to failing spans.
5. Align trace attributes with the correlation contract and safe metric labels.
6. Add exemplar support from key histograms to trace IDs if the stack supports it.

## Verification requirements

### Unit and integration tests

1. **Real span creation** - `SmithersObservability.withSpan()` creates an OTEL span,
   not only a log span.
2. **Parent/child structure** - A run trace contains nested node, tool, and DB
   spans with correct lineage.
3. **Failure status** - Failed node / tool / server operations mark spans as errors.
4. **Attribute parity** - Key spans include the standard Smithers attributes.
5. **Context propagation** - Trace context survives request -> run -> node -> tool
   where supported.

### End-to-end tests

6. **Tempo visibility** - Running a workflow produces searchable traces in the local
   Tempo stack.
7. **Slow workflow drill-down** - A deliberately slow workflow can be diagnosed from
   histogram spike -> exemplar / trace -> slow child span.
8. **Approval / waiting trace** - A run blocked on approval or timer produces spans
   that make the wait obvious instead of disappearing from visibility.

### Corner cases

9. **Continue-as-new** - Continued runs preserve linkage or emit explicit lineage
   metadata.
10. **Sandbox boundary** - Trace continuity across sandbox handoff is either
    preserved or explicitly represented as linked spans.
11. **Disabled OTEL** - The runtime still behaves correctly when OTEL export is off.

## Observability

### New metrics

No new top-level metric family is required to start. The main outcomes are:

- real span trees
- consistent span attributes
- exemplar-friendly histograms where possible

### Logging

- Keep log spans as an optional complement, not the substitute for tracing.
- Do not let log formatting decisions define tracing semantics.

## Codebase context

### Core observability

- `src/observability/index.ts`
- `src/effect/logging.ts`
- `src/effect/runtime.ts`

### Major runtime coverage

- `src/engine/index.ts`
- `src/events.ts`
- `src/tools/logToolCall.ts`
- `src/server/index.ts`
- `src/server/serve.ts`
- `src/cli/supervisor.ts`
- `src/agents/BaseCliAgent.ts`
- `src/ide/SmithersIdeService.ts`

### Adjacent work

- `.smithers/tickets/observability-correlation-first-class.md`
- `.smithers/tickets/prometheus-grafana-observability-parity.md`
- `.smithers/tickets/agent-observability.md`
- `.smithers/tickets/gateway-observability.md`

## Effect.ts architecture

Tracing should remain an Effect-native concern.

- Prefer shared span helpers over hand-written ad hoc span names everywhere.
- Do not force UI or transport code to invent tracing conventions.
- Treat `withLogSpan` and real tracing as distinct tools with distinct jobs.
