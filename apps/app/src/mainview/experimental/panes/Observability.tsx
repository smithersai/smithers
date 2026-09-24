/*
 * Mock: Observability. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.observability`. Self-contained on purpose — see ../Pane.ts.
 *
 * The metric handles, the validated `Resource`, the OTLP endpoint and the
 * `JournalLogger` are all wired and running in this process, and none of it
 * reaches a person using the product: the counters are readable only by the
 * fiber that holds them, and the exporter a host did not compose is
 * `Otlp.layerNoop`. Fields belong to `Metric`, `Resource`, `Endpoint`, `Otlp`,
 * `Otel`, `JournalLogger`, and the `NodeOtel` / `BrowserOtel` subpaths the
 * root entry deliberately does not re-export.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Code, Facts, Graph, Rail, Section, Split, Table } from "../Primitives"

const METRICS = [
  { id: "flows_run_throughput", kind: "counter", value: "412", tone: "ok" as const },
  { id: "flows_seat_active", kind: "gauge", value: "3", tone: "info" as const },
  { id: "flows_quota_park", kind: "counter", value: "7", tone: "warn" as const },
  { id: "flows_observability_log_dropped", kind: "counter", value: "0", tone: "ok" as const },
  { id: "flows_observability_otlp_dropped", kind: "counter", value: "2", tone: "bad" as const }
]

const SIGNALS = [
  { id: "traces", label: "traces", note: "/v1/traces", tone: "muted" as const },
  { id: "metrics", label: "metrics", note: "/v1/metrics", tone: "muted" as const },
  { id: "logs", label: "logs", note: "/v1/logs", tone: "muted" as const }
]

const NODES = [
  { id: "metric", label: "Metric", depth: 0, lane: 0, tone: "info" as const },
  { id: "logger", label: "Logger", depth: 0, lane: 1, tone: "info" as const },
  { id: "tracer", label: "Tracer", depth: 0, lane: 2, tone: "info" as const },
  { id: "otlp", label: "Otlp.layer", depth: 1, lane: 1, tone: "muted" as const },
  { id: "journal", label: "JournalLogger", depth: 1, lane: 3, tone: "ok" as const },
  { id: "collector", label: "collector", depth: 2, lane: 1, tone: "muted" as const },
  { id: "entries", label: "telemetry.log", depth: 2, lane: 3, tone: "ok" as const }
]

const EDGES: ReadonlyArray<readonly [string, string]> = [
  ["metric", "otlp"],
  ["logger", "otlp"],
  ["tracer", "otlp"],
  ["logger", "journal"],
  ["otlp", "collector"],
  ["journal", "entries"]
]

const RECORD = `{
  "version": 1,
  "level": "Warn",
  "message": "otlp_export_discarded",
  "annotations": { "code": "otlp_export_discarded", "bytes": 1310720, "total": 2 },
  "cause": { "version": 1, "reasons": [] },
  "fiberId": 431,
  "traceId": "4f8a2c1d9b0e77a3f6c5d4e3b2a10987",
  "spanId": "9b0e77a3f6c5d4e3",
  "timestamp": "2026-09-18T14:35:02.114Z"
}`

export const Pane = pane({
  id: "observability",
  title: "Observability",
  summary: "Metric handles, the OTLP target and the trace out",
  packages: ["@smthrs/observability"],
  render: (context) => <ObservabilityBody {...context} />
})

function ObservabilityBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const signal = typeof props.signal === "string" ? props.signal : "traces"
  return (
    <Split
      left={
        <>
          <Section title="Resource" right={<Badge tone="ok">validated</Badge>}>
            <Facts rows={[
              { label: "service.name", value: "flows", mono: true },
              { label: "service.version", value: "1.0.0-rc.0", mono: true },
              { label: "deployment.environment", value: "canary", mono: true },
              { label: "host.name", value: "mac-studio-1", mono: true },
              { label: "encoded", value: "3 118 / 131 072 B", mono: true }
            ]} />
          </Section>
          <Section title="Endpoint">
            <Rail items={SIGNALS} selected={signal} onSelect={(id) => runCommandSet("signal", id)} />
            <Facts rows={[
              { label: "baseUrl", value: "http://localhost:4318", mono: true },
              { label: "url", value: `http://localhost:4318/v1/${signal}`, mono: true },
              { label: "maxRequestBytes", value: "1 048 576", mono: true },
              { label: "reservedBatchBytes", value: "909 312", mono: true },
              { label: "maxBatchSize", value: "1 000", mono: true }
            ]} />
          </Section>
        </>
      }
      right={
        <>
          <Section title="Metric" right="this process">
            <Table
              columns={[
                { key: "id", label: "name", mono: true },
                { key: "kind", label: "kind" },
                { key: "value", label: "value", mono: true, right: true }
              ]}
              rows={METRICS.map((row) => ({
                id: row.id,
                kind: row.kind,
                value: <Badge tone={row.tone}>{row.value}</Badge>
              }))}
            />
          </Section>
          <Section title="Export" right={<Badge tone="muted">Otlp.layerNoop</Badge>}>
            <Graph nodes={NODES} edges={EDGES} />
            <Facts rows={[
              { label: "discarded", value: "2 batches", mono: true },
              { label: "code", value: "otlp_export_discarded", mono: true },
              { label: "reader", value: "NodeOtel · BrowserOtel subpath", mono: true }
            ]} />
          </Section>
          <Section title="JournalLogger" right={<Badge tone="ok">forwarding</Badge>}>
            <Facts rows={[
              { label: "sourceId", value: "flows/observability/logger", mono: true },
              { label: "eventType", value: "telemetry.log", mono: true },
              { label: "runId", value: "run_8c31f0", mono: true },
              { label: "capacity", value: "256 / 65 536", mono: true },
              { label: "minimumLogLevel", value: "Info", mono: true },
              { label: "mergeWithExisting", value: "false" }
            ]} />
            <Code label="telemetry.log">{RECORD}</Code>
          </Section>
          <Section title="Span" right={<Badge tone="warn">not exported</Badge>}>
            <Facts rows={[
              { label: "traceId", value: "4f8a2c1d9b0e77a3f6c5d4e3b2a10987", mono: true },
              { label: "spanId", value: "9b0e77a3f6c5d4e3", mono: true },
              { label: "scope", value: "@smthrs/observability", mono: true },
              { label: "tracerProvider", value: "borrowed", mono: true },
              { label: "metricReader", value: "owned by the layer scope", mono: true }
            ]} />
          </Section>
        </>
      }
    />
  )
}
