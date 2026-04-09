# First-class correlation across events, logs, metrics, traces, and UI

## Problem

Smithers already emits durable events, structured logs, metrics, and OTLP data, but
there is no single first-class correlation contract tying them together.

Today, pieces of correlation exist in isolation:

- events often have `runId`, `nodeId`, `iteration`, and `attempt`
- logs are sometimes annotated with subsets of that data
- tool calls have their own `seq`
- token metrics are tagged by `agent` and `model`
- Grafana/Tempo assume traces exist, but the current `SmithersObservability.withSpan`
  helper is implemented with `Effect.withLogSpan`, not a real OTEL span

That creates a practical operator problem:

- You can see that a run failed, but not reliably pivot from the run to the exact
  log lines, tool calls, spans, and downstream alerts that belong to the same causal
  chain.
- You can see an aggregate metric spike, but not reliably answer which workflow,
  node, tool, or agent caused it.
- UI surfaces cannot build robust deep links because there is no normalized
  correlation envelope.

The current state is "some IDs happen to show up in some places". That is not the
same as first-class correlation.

## Proposal

Define a canonical Smithers correlation envelope and propagate it everywhere that
matters.

### Correlation envelope

Introduce a shared internal type, e.g. `SmithersCorrelationContext`, with stable,
bounded keys:

- `runId`
- `workflowName`
- `nodeId`
- `iteration`
- `attempt`
- `nodeLabel`
- `toolName`
- `toolSeq`
- `agent`
- `model`
- `operationKind`
- `triggerKind`
- `correlationId`
- `causationId`
- `traceId`
- `spanId`

### Semantics

- `correlationId` represents the broader causal thread
  - example: a run, or an externally-triggered continuation
- `causationId` represents the immediate parent operation or event
  - example: the event or request that directly caused this action
- `traceId` / `spanId` align Smithers operations with OTEL traces
- Metrics may use a bounded subset of the envelope as labels
  - `workflowName`, `toolName`, `agent`, `model`, `status`
- Metrics must **not** use high-cardinality identifiers
  - `runId`, `causationId`, `correlationId`, file paths, prompt bodies

### Propagation model

The envelope should be created once at the outer boundary and extended inward:

- HTTP request / CLI command / gateway RPC / cron trigger / signal delivery
- run start / resume / continue-as-new
- node attempt execution
- agent call
- tool call
- DB operation
- approval / timer / signal / human wait
- sandbox shipment / execution / diff review

### Persistence

Persist enough correlation data to support drill-down without depending on ephemeral
 logs:

- `_smithers_events`
- tool call rows
- approval / signal / human request rows
- run and node summaries where useful

Do not stuff everything into ad hoc JSON blobs with no query path. Preserve typed
columns for the high-value dimensions and allow a structured metadata JSON column for
the rest.

### UI and operator use

Once the envelope exists, every surface can pivot predictably:

- TUI and PI link from run -> node -> tool -> correlated logs
- Grafana links from a metric series -> trace search -> run details
- `smithers why` explains the active causal chain with the same identifiers
- future devtools can deep-link without inventing their own IDs

## Rollout phases

### Phase 1: Contract

- Define the canonical correlation envelope type and helper APIs.
- Document which fields are required at each execution boundary.
- Add shared helpers for:
  - log annotation
  - span attributes
  - event persistence metadata
  - bounded metric labels

### Phase 2: Runtime propagation

- Propagate the envelope through engine, tools, agents, server, gateway, and
  sandbox flows.
- Normalize field names and stop ad hoc per-module conventions.
- Add trace/span IDs once real spans exist.

### Phase 3: Queryability and UX

- Expose correlation fields in operator surfaces and CLI diagnostics.
- Add deep links / filters by workflow, node label, tool, agent, and model.
- Make alert payloads include the same envelope subset.

## Additional steps

1. Reserve a stable naming convention and never publish both `workflow_name` and
   `workflowName` for the same concept in different surfaces.
2. Keep the envelope bounded and documented; do not let arbitrary user payloads leak
   into correlation fields.
3. Centralize envelope construction so new modules do not invent their own tags.
4. Add a helper for turning the envelope into OTEL span attributes and log
   annotations consistently.
5. Add a helper for deriving safe metric labels from the full envelope.
6. Make `continue-as-new` and resumed runs preserve causal lineage instead of
   appearing as disconnected sessions.

## Verification requirements

### Unit and integration tests

1. **HTTP -> run correlation** - A server request that starts a run produces logs,
   events, and spans that share the same `runId`, `workflowName`, and trace lineage.
2. **Node -> tool correlation** - A tool call within a node includes `runId`,
   `nodeId`, `iteration`, `attempt`, and `toolSeq` across log, event, and persisted
   tool call record.
3. **Resume lineage** - Resumed and continued runs retain a causal link to the
   originating run rather than starting a brand-new disconnected chain.
4. **Signal / approval correlation** - External resolutions can be traced from
   incoming request to the resumed node attempt.
5. **Metric label safety** - Safe label derivation never includes `runId`,
   `correlationId`, file paths, or prompt text.

### Operator-level tests

6. **Alert payload correlation** - Fired alerts include enough context to jump to the
   affected run / node / workflow.
7. **UI drill-down** - PI/TUI/devtools can filter by workflow, node label, tool,
   agent, and model using the same field names.
8. **Tempo search alignment** - Trace attributes match the same field names shown in
   logs and events.

### Corner cases

9. **Parallel branches** - Parallel nodes keep distinct node-level context while
   sharing run-level correlation.
10. **Loop iterations** - Iteration-specific work remains distinguishable without
    losing parent run context.
11. **Sandbox / child process handoff** - Correlation survives process boundaries
    where technically possible; if not, the loss is explicit and tested.

## Observability

### New events / metadata

No new top-level event family is required. The main change is standardized
correlation metadata on existing operations.

### Metrics

Correlation should improve metric labels indirectly by standardizing safe dimensions:

- `workflow_name`
- `node_label`
- `tool_name`
- `agent`
- `model`
- `status`

### Logging

- Every high-value log line should carry the correlation envelope subset that matches
  its scope.
- Add a single helper for applying correlation annotations before logging.

## Codebase context

### Core files

- `src/observability/index.ts`
- `src/events.ts`
- `src/engine/index.ts`
- `src/tools/logToolCall.ts`
- `src/server/index.ts`
- `src/server/serve.ts`
- `src/cli/supervisor.ts`
- `src/agents/BaseCliAgent.ts`

### Adjacent work

- `.smithers/tickets/prometheus-grafana-observability-parity.md`
- `.smithers/tickets/agent-observability.md`
- `.smithers/tickets/gateway-observability.md`

## Effect.ts architecture

Correlation propagation should remain in Effect-native helpers and services.

- Do not manually thread partial maps of IDs through random call sites.
- Do not let UI-specific code define the correlation contract.
- Build one shared runtime primitive and make every boundary consume it.
