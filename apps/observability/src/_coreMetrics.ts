import { Context, Effect, Layer } from "effect";
import {
  type MetricLabels,
  type PrometheusSample,
  renderPrometheusSamples,
  toPrometheusMetricName,
} from "./_corePrometheus.ts";
import type { SmithersMetricType } from "./SmithersMetricType.ts";
import type { SmithersMetricUnit } from "./SmithersMetricUnit.ts";
import type { SmithersMetricDefinition } from "./SmithersMetricDefinition.ts";
import type { MetricName } from "./MetricName.ts";

export type { MetricName } from "./MetricName.ts";
export type { MetricLabels };
export type { SmithersMetricType } from "./SmithersMetricType.ts";
export type { SmithersMetricUnit } from "./SmithersMetricUnit.ts";
export type { SmithersMetricDefinition } from "./SmithersMetricDefinition.ts";

function metricDefinition(
  key: string,
  name: string,
  type: SmithersMetricType,
  options: Omit<SmithersMetricDefinition, "key" | "name" | "prometheusName" | "type">,
): SmithersMetricDefinition {
  return {
    key,
    name,
    prometheusName: toPrometheusMetricName(name),
    type,
    ...options,
  };
}

const DURATION_BUCKETS = [
  100,
  200,
  400,
  800,
  1_600,
  3_200,
  6_400,
  12_800,
  25_600,
  51_200,
  102_400,
  204_800,
] as const;
const FAST_BUCKETS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1_024, 2_048] as const;
const TOKEN_BUCKETS = [
  10,
  20,
  40,
  80,
  160,
  320,
  640,
  1_280,
  2_560,
  5_120,
  10_240,
  20_480,
  40_960,
  81_920,
  163_840,
  327_680,
  655_360,
  1_310_720,
] as const;
const SIZE_BUCKETS = [
  100,
  200,
  400,
  800,
  1_600,
  3_200,
  6_400,
  12_800,
  25_600,
  51_200,
  102_400,
  204_800,
  409_600,
  819_200,
  1_638_400,
  3_276_800,
] as const;

export const smithersMetricCatalog: readonly SmithersMetricDefinition[] = [
  metricDefinition("runsTotal", "smithers.runs.total", "counter", { label: "Runs started", unit: "count" }),
  metricDefinition("nodesStarted", "smithers.nodes.started", "counter", { label: "Nodes started", unit: "count" }),
  metricDefinition("nodesFinished", "smithers.nodes.finished", "counter", { label: "Nodes finished", unit: "count" }),
  metricDefinition("nodesFailed", "smithers.nodes.failed", "counter", { label: "Nodes failed", unit: "count" }),
  metricDefinition("toolCallsTotal", "smithers.tool_calls.total", "counter", { label: "Tool calls", unit: "count" }),
  metricDefinition("cacheHits", "smithers.cache.hits", "counter", { label: "Cache hits", unit: "count" }),
  metricDefinition("cacheMisses", "smithers.cache.misses", "counter", { label: "Cache misses", unit: "count" }),
  metricDefinition("dbRetries", "smithers.db.retries", "counter", { label: "DB retries", unit: "count" }),
  metricDefinition("dbTransactionRollbacks", "smithers.db.transaction_rollbacks", "counter", { label: "DB transaction rollbacks", unit: "count" }),
  metricDefinition("dbTransactionRetries", "smithers.db.transaction_retries", "counter", { label: "DB transaction retries", unit: "count" }),
  metricDefinition("hotReloads", "smithers.hot.reloads", "counter", { label: "Hot reloads", unit: "count" }),
  metricDefinition("hotReloadFailures", "smithers.hot.reload_failures", "counter", { label: "Hot reload failures", unit: "count" }),
  metricDefinition("httpRequests", "smithers.http.requests", "counter", { label: "HTTP requests", unit: "count", labels: ["method", "route", "status_code", "status_class"] }),
  metricDefinition("approvalsRequested", "smithers.approvals.requested", "counter", { label: "Approvals requested", unit: "count" }),
  metricDefinition("approvalsGranted", "smithers.approvals.granted", "counter", { label: "Approvals granted", unit: "count" }),
  metricDefinition("approvalsDenied", "smithers.approvals.denied", "counter", { label: "Approvals denied", unit: "count" }),
  metricDefinition("timersCreated", "smithers.timers.created", "counter", { label: "Timers created", unit: "count" }),
  metricDefinition("timersFired", "smithers.timers.fired", "counter", { label: "Timers fired", unit: "count" }),
  metricDefinition("timersCancelled", "smithers.timers.cancelled", "counter", { label: "Timers cancelled", unit: "count" }),
  metricDefinition("sandboxCreatedTotal", "smithers.sandbox.created_total", "counter", { label: "Sandboxes created", unit: "count", labels: ["runtime"] }),
  metricDefinition("sandboxCompletedTotal", "smithers.sandbox.completed_total", "counter", { label: "Sandboxes completed", unit: "count", labels: ["runtime", "status"] }),
  metricDefinition("alertsFiredTotal", "smithers.alerts.fired_total", "counter", { label: "Alerts fired", unit: "count", labels: ["policy"] }),
  metricDefinition("alertsAcknowledgedTotal", "smithers.alerts.acknowledged_total", "counter", { label: "Alerts acknowledged", unit: "count", labels: ["policy"] }),
  metricDefinition("scorerEventsStarted", "smithers.scorer_events.started", "counter", { label: "Scorer events started", unit: "count" }),
  metricDefinition("scorerEventsFinished", "smithers.scorer_events.finished", "counter", { label: "Scorer events finished", unit: "count" }),
  metricDefinition("scorerEventsFailed", "smithers.scorer_events.failed", "counter", { label: "Scorer events failed", unit: "count" }),
  metricDefinition("tokensInputTotal", "smithers.tokens.input_total", "counter", { label: "Input tokens", unit: "tokens", labels: ["agent", "model"] }),
  metricDefinition("tokensOutputTotal", "smithers.tokens.output_total", "counter", { label: "Output tokens", unit: "tokens", labels: ["agent", "model"] }),
  metricDefinition("tokensCacheReadTotal", "smithers.tokens.cache_read_total", "counter", { label: "Cache read tokens", unit: "tokens", labels: ["agent", "model"] }),
  metricDefinition("tokensCacheWriteTotal", "smithers.tokens.cache_write_total", "counter", { label: "Cache write tokens", unit: "tokens", labels: ["agent", "model"] }),
  metricDefinition("tokensReasoningTotal", "smithers.tokens.reasoning_total", "counter", { label: "Reasoning tokens", unit: "tokens", labels: ["agent", "model"] }),
  metricDefinition("tokensContextWindowBucketTotal", "smithers.tokens.context_window_bucket_total", "counter", { label: "Context window bucket hits", unit: "count", labels: ["agent", "bucket", "model"] }),
  metricDefinition("runsFinishedTotal", "smithers.runs.finished_total", "counter", { label: "Runs finished", unit: "count" }),
  metricDefinition("runsFailedTotal", "smithers.runs.failed_total", "counter", { label: "Runs failed", unit: "count" }),
  metricDefinition("runsCancelledTotal", "smithers.runs.cancelled_total", "counter", { label: "Runs cancelled", unit: "count" }),
  metricDefinition("runsResumedTotal", "smithers.runs.resumed_total", "counter", { label: "Runs resumed", unit: "count" }),
  metricDefinition("runsContinuedTotal", "smithers.runs.continued_total", "counter", { label: "Runs continued", unit: "count" }),
  metricDefinition("supervisorPollsTotal", "smithers.supervisor.polls_total", "counter", { label: "Supervisor polls", unit: "count" }),
  metricDefinition("supervisorStaleDetected", "smithers.supervisor.stale_detected", "counter", { label: "Supervisor stale runs detected", unit: "count" }),
  metricDefinition("supervisorResumedTotal", "smithers.supervisor.resumed_total", "counter", { label: "Supervisor auto-resumes", unit: "count" }),
  metricDefinition("supervisorSkippedTotal", "smithers.supervisor.skipped_total", "counter", { label: "Supervisor skipped auto-resumes", unit: "count", labels: ["reason"] }),
  metricDefinition("errorsTotal", "smithers.errors.total", "counter", { label: "Errors", unit: "count" }),
  metricDefinition("nodeRetriesTotal", "smithers.node.retries_total", "counter", { label: "Node retries", unit: "count" }),
  metricDefinition("toolCallErrorsTotal", "smithers.tool_calls.errors_total", "counter", { label: "Tool call errors", unit: "count" }),
  metricDefinition("toolOutputTruncatedTotal", "smithers.tool.output_truncated_total", "counter", { label: "Tool outputs truncated", unit: "count" }),
  metricDefinition("agentInvocationsTotal", "smithers.agent_invocations_total", "counter", { label: "Agent invocations", unit: "count", labels: ["engine", "model"] }),
  metricDefinition("agentTokensTotal", "smithers.agent_tokens_total", "counter", { label: "Agent tokens", unit: "tokens", labels: ["engine", "model", "kind", "source"] }),
  metricDefinition("agentErrorsTotal", "smithers.agent_errors_total", "counter", { label: "Agent errors", unit: "count", labels: ["engine", "model", "reason", "source"] }),
  metricDefinition("agentRetriesTotal", "smithers.agent_retries_total", "counter", { label: "Agent retries", unit: "count", labels: ["engine", "model", "reason", "source"] }),
  metricDefinition("agentEventsTotal", "smithers.agent_events_total", "counter", { label: "Agent events", unit: "count", labels: ["engine", "event_type", "source"] }),
  metricDefinition("agentSessionsTotal", "smithers.agent_sessions_total", "counter", { label: "Agent sessions", unit: "count", labels: ["engine", "model", "resume", "source", "status"] }),
  metricDefinition("agentActionsTotal", "smithers.agent_actions_total", "counter", { label: "Agent actions", unit: "count", labels: ["action_name", "action_type", "engine", "source"] }),

  metricDefinition("gatewayConnectionsTotal", "smithers.gateway.connections_total", "counter", { label: "Gateway connections opened", unit: "count", labels: ["transport"] }),
  metricDefinition("gatewayConnectionsClosedTotal", "smithers.gateway.connections_closed_total", "counter", { label: "Gateway connections closed", unit: "count", labels: ["code", "reason", "transport"] }),
  metricDefinition("gatewayMessagesReceivedTotal", "smithers.gateway.messages_received_total", "counter", { label: "Gateway messages received", unit: "count", labels: ["kind", "transport"] }),
  metricDefinition("gatewayMessagesSentTotal", "smithers.gateway.messages_sent_total", "counter", { label: "Gateway messages sent", unit: "count", labels: ["kind", "transport"] }),
  metricDefinition("gatewayRpcCallsTotal", "smithers.gateway.rpc_calls_total", "counter", { label: "Gateway RPC calls", unit: "count", labels: ["method", "transport"] }),
  metricDefinition("gatewayErrorsTotal", "smithers.gateway.errors_total", "counter", { label: "Gateway errors", unit: "count", labels: ["code", "stage", "transport"] }),
  metricDefinition("gatewayRunsStartedTotal", "smithers.gateway.runs_started_total", "counter", { label: "Gateway runs started", unit: "count", labels: ["transport"] }),
  metricDefinition("gatewayRunsCompletedTotal", "smithers.gateway.runs_completed_total", "counter", { label: "Gateway runs completed", unit: "count", labels: ["status", "transport"] }),
  metricDefinition("gatewayApprovalDecisionsTotal", "smithers.gateway.approval_decisions_total", "counter", { label: "Gateway approval decisions", unit: "count", labels: ["decision", "transport"] }),
  metricDefinition("gatewaySignalsTotal", "smithers.gateway.signals_total", "counter", { label: "Gateway signals", unit: "count", labels: ["outcome", "transport"] }),
  metricDefinition("gatewayAuthEventsTotal", "smithers.gateway.auth_events_total", "counter", { label: "Gateway auth events", unit: "count", labels: ["outcome", "transport"] }),
  metricDefinition("gatewayHeartbeatTicksTotal", "smithers.gateway.heartbeat_ticks_total", "counter", { label: "Gateway heartbeats", unit: "count" }),
  metricDefinition("gatewayCronTriggersTotal", "smithers.gateway.cron_triggers_total", "counter", { label: "Gateway cron triggers", unit: "count", labels: ["source"] }),
  metricDefinition("gatewayWebhooksReceivedTotal", "smithers.gateway.webhooks_received_total", "counter", { label: "Gateway webhooks received", unit: "count", labels: ["provider"] }),
  metricDefinition("gatewayWebhooksVerifiedTotal", "smithers.gateway.webhooks_verified_total", "counter", { label: "Gateway webhooks verified", unit: "count", labels: ["provider"] }),
  metricDefinition("gatewayWebhooksRejectedTotal", "smithers.gateway.webhooks_rejected_total", "counter", { label: "Gateway webhooks rejected", unit: "count", labels: ["provider", "reason"] }),
  metricDefinition("eventsEmittedTotal", "smithers.events.emitted_total", "counter", { label: "Events emitted", unit: "count" }),
  metricDefinition("taskHeartbeatsTotal", "smithers.heartbeats.total", "counter", { label: "Task heartbeats", unit: "count" }),
  metricDefinition("taskHeartbeatTimeoutTotal", "smithers.heartbeats.timeout_total", "counter", { label: "Task heartbeat timeouts", unit: "count" }),

  metricDefinition("activeRuns", "smithers.runs.active", "gauge", { label: "Active runs", unit: "count" }),
  metricDefinition("activeNodes", "smithers.nodes.active", "gauge", { label: "Active nodes", unit: "count" }),
  metricDefinition("schedulerQueueDepth", "smithers.scheduler.queue_depth", "gauge", { label: "Scheduler queue depth", unit: "count" }),
  metricDefinition("sandboxActive", "smithers.sandbox.active", "gauge", { label: "Active sandboxes", unit: "count", labels: ["runtime"] }),
  metricDefinition("alertsActive", "smithers.alerts.active", "gauge", { label: "Active alerts", unit: "count", labels: ["policy"] }),
  metricDefinition("gatewayConnectionsActive", "smithers.gateway.connections_active", "gauge", { label: "Active gateway connections", unit: "count", labels: ["transport"] }),
  metricDefinition("approvalPending", "smithers.approval.pending", "gauge", { label: "Pending approvals", unit: "count" }),
  metricDefinition("externalWaitAsyncPending", "smithers.external_wait.async_pending", "gauge", { label: "Pending external waits", unit: "count", labels: ["kind"], defaultLabels: [{ kind: "approval" }, { kind: "event" }] }),
  metricDefinition("timersPending", "smithers.timers.pending", "gauge", { label: "Pending timers", unit: "count" }),
  metricDefinition("schedulerConcurrencyUtilization", "smithers.scheduler.concurrency_utilization", "gauge", { label: "Scheduler concurrency utilization", unit: "ratio" }),
  metricDefinition("processUptimeSeconds", "smithers.process.uptime_seconds", "gauge", { label: "Process uptime", unit: "seconds" }),
  metricDefinition("processMemoryRssBytes", "smithers.process.memory_rss_bytes", "gauge", { label: "Process RSS memory", unit: "bytes" }),
  metricDefinition("processHeapUsedBytes", "smithers.process.heap_used_bytes", "gauge", { label: "Process heap used", unit: "bytes" }),

  metricDefinition("nodeDuration", "smithers.node.duration_ms", "histogram", { label: "Node duration", unit: "milliseconds", boundaries: DURATION_BUCKETS }),
  metricDefinition("attemptDuration", "smithers.attempt.duration_ms", "histogram", { label: "Attempt duration", unit: "milliseconds", boundaries: DURATION_BUCKETS }),
  metricDefinition("toolDuration", "smithers.tool.duration_ms", "histogram", { label: "Tool duration", unit: "milliseconds", boundaries: DURATION_BUCKETS }),
  metricDefinition("dbQueryDuration", "smithers.db.query_ms", "histogram", { label: "DB query duration", unit: "milliseconds", boundaries: FAST_BUCKETS }),
  metricDefinition("dbTransactionDuration", "smithers.db.transaction_ms", "histogram", { label: "DB transaction duration", unit: "milliseconds", boundaries: FAST_BUCKETS }),
  metricDefinition("httpRequestDuration", "smithers.http.request_duration_ms", "histogram", { label: "HTTP request duration", unit: "milliseconds", labels: ["method", "route", "status_code", "status_class"], boundaries: FAST_BUCKETS }),
  metricDefinition("hotReloadDuration", "smithers.hot.reload_duration_ms", "histogram", { label: "Hot reload duration", unit: "milliseconds", boundaries: DURATION_BUCKETS }),
  metricDefinition("vcsDuration", "smithers.vcs.duration_ms", "histogram", { label: "VCS duration", unit: "milliseconds", boundaries: FAST_BUCKETS }),
  metricDefinition("agentDurationMs", "smithers.agent_duration_ms", "histogram", { label: "Agent duration", unit: "milliseconds", labels: ["engine", "model"], boundaries: DURATION_BUCKETS }),
  metricDefinition("tokensInputPerCall", "smithers.tokens.input_per_call", "histogram", { label: "Input tokens per call", unit: "tokens", labels: ["agent", "model"], boundaries: TOKEN_BUCKETS }),
  metricDefinition("tokensOutputPerCall", "smithers.tokens.output_per_call", "histogram", { label: "Output tokens per call", unit: "tokens", labels: ["agent", "model"], boundaries: TOKEN_BUCKETS }),
  metricDefinition("tokensContextWindowPerCall", "smithers.tokens.context_window_per_call", "histogram", { label: "Context window per call", unit: "tokens", labels: ["agent", "model"], boundaries: [50_000, 100_000, 200_000, 500_000, 1_000_000] }),
  metricDefinition("runDuration", "smithers.run.duration_ms", "histogram", { label: "Run duration", unit: "milliseconds", boundaries: DURATION_BUCKETS }),
  metricDefinition("promptSizeBytes", "smithers.prompt.size_bytes", "histogram", { label: "Prompt size", unit: "bytes", boundaries: SIZE_BUCKETS }),
  metricDefinition("responseSizeBytes", "smithers.response.size_bytes", "histogram", { label: "Response size", unit: "bytes", boundaries: SIZE_BUCKETS }),
  metricDefinition("approvalWaitDuration", "smithers.approval.wait_duration_ms", "histogram", { label: "Approval wait duration", unit: "milliseconds", boundaries: DURATION_BUCKETS }),
  metricDefinition("timerDelayDuration", "smithers.timers.delay_ms", "histogram", { label: "Timer delay", unit: "milliseconds", boundaries: DURATION_BUCKETS }),

  metricDefinition("gatewayRpcDuration", "smithers.gateway.rpc_duration_ms", "histogram", { label: "Gateway RPC duration", unit: "milliseconds", labels: ["method", "transport"], boundaries: DURATION_BUCKETS }),
  metricDefinition("schedulerWaitDuration", "smithers.scheduler.wait_duration_ms", "histogram", { label: "Scheduler wait duration", unit: "milliseconds", boundaries: DURATION_BUCKETS }),
  metricDefinition("supervisorPollDuration", "smithers.supervisor.poll_duration_ms", "histogram", { label: "Supervisor poll duration", unit: "milliseconds", boundaries: FAST_BUCKETS }),
  metricDefinition("supervisorResumeLag", "smithers.supervisor.resume_lag_ms", "histogram", { label: "Supervisor resume lag", unit: "milliseconds", boundaries: DURATION_BUCKETS }),
  metricDefinition("runsAncestryDepth", "smithers.runs.ancestry_depth", "histogram", { label: "Run ancestry depth", unit: "depth", boundaries: [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1_024, 2_048] }),
  metricDefinition("runsCarriedStateBytes", "smithers.runs.carried_state_bytes", "histogram", { label: "Run carried state size", unit: "bytes", boundaries: SIZE_BUCKETS }),
  metricDefinition("sandboxDurationMs", "smithers.sandbox.duration_ms", "histogram", { label: "Sandbox duration", unit: "milliseconds", boundaries: DURATION_BUCKETS }),
  metricDefinition("sandboxBundleSizeBytes", "smithers.sandbox.bundle_size_bytes", "histogram", { label: "Sandbox bundle size", unit: "bytes", boundaries: SIZE_BUCKETS }),
  metricDefinition("sandboxTransportDurationMs", "smithers.sandbox.transport_duration_ms", "histogram", { label: "Sandbox transport duration", unit: "milliseconds", boundaries: DURATION_BUCKETS }),
  metricDefinition("sandboxPatchCount", "smithers.sandbox.patch_count", "histogram", { label: "Sandbox patch count", unit: "count", boundaries: TOKEN_BUCKETS }),
  metricDefinition("heartbeatDataSizeBytes", "smithers.heartbeats.data_size_bytes", "histogram", { label: "Heartbeat data size", unit: "bytes", boundaries: SIZE_BUCKETS }),
  metricDefinition("heartbeatIntervalMs", "smithers.heartbeats.interval_ms", "histogram", { label: "Heartbeat interval", unit: "milliseconds", boundaries: FAST_BUCKETS }),
] as const;

export const smithersMetricCatalogByKey = new Map(
  smithersMetricCatalog.map((metric) => [metric.key, metric] as const),
);

export const smithersMetricCatalogByPrometheusName = new Map(
  smithersMetricCatalog.map((metric) => [metric.prometheusName, metric] as const),
);

export const smithersMetricCatalogByName = new Map(
  smithersMetricCatalog.map((metric) => [metric.name, metric] as const),
);

export const smithersMetrics = Object.freeze(
  Object.fromEntries(smithersMetricCatalog.map((metric) => [metric.key, metric.name])),
) as Readonly<Record<string, string>>;

export type SmithersMetricEvent = {
  readonly type: string;
  readonly [key: string]: unknown;
};

type CounterEntry = {
  readonly type: "counter";
  value: number;
  readonly labels: MetricLabels;
};

type GaugeEntry = {
  readonly type: "gauge";
  value: number;
  readonly labels: MetricLabels;
};

type HistogramEntry = {
  readonly type: "histogram";
  sum: number;
  count: number;
  readonly labels: MetricLabels;
  readonly buckets: Map<number, number>;
};

type MetricEntry = CounterEntry | GaugeEntry | HistogramEntry;

export type MetricsSnapshot = ReadonlyMap<string, MetricEntry>;

export type MetricsServiceShape = {
  readonly increment: (
    name: MetricName,
    labels?: MetricLabels,
  ) => Effect.Effect<void>;
  readonly incrementBy: (
    name: MetricName,
    value: number,
    labels?: MetricLabels,
  ) => Effect.Effect<void>;
  readonly gauge: (
    name: MetricName,
    value: number,
    labels?: MetricLabels,
  ) => Effect.Effect<void>;
  readonly histogram: (
    name: MetricName,
    value: number,
    labels?: MetricLabels,
  ) => Effect.Effect<void>;
  readonly recordEvent: (event: SmithersMetricEvent) => Effect.Effect<void>;
  readonly updateProcessMetrics: () => Effect.Effect<void>;
  readonly updateAsyncExternalWaitPending: (
    kind: "approval" | "event",
    delta: number,
  ) => Effect.Effect<void>;
  readonly renderPrometheus: () => Effect.Effect<string>;
  readonly snapshot: () => Effect.Effect<MetricsSnapshot>;
};

export class MetricsService extends Context.Tag("MetricsService")<
  MetricsService,
  MetricsServiceShape
>() {}

const DEFAULT_HISTOGRAM_BUCKETS = [
  1,
  5,
  10,
  25,
  50,
  100,
  250,
  500,
  1_000,
  2_500,
  5_000,
  10_000,
  30_000,
] as const;

function labelsKey(labels: MetricLabels = {}): string {
  return JSON.stringify(
    Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function metricKey(name: string, labels?: MetricLabels): string {
  return `${name}|${labelsKey(labels)}`;
}

function cloneLabels(labels: MetricLabels = {}): MetricLabels {
  return Object.freeze({ ...labels });
}

export function makeInMemoryMetricsService(): Context.Tag.Service<MetricsService> {
  const registry = new Map<string, MetricEntry>();
  const processStartMs = Date.now();
  const asyncExternalWaitCounts: Record<"approval" | "event", number> = {
    approval: 0,
    event: 0,
  };

  function upsertCounter(name: string, labels?: MetricLabels): CounterEntry {
    const key = metricKey(name, labels);
    const existing = registry.get(key);
    if (existing?.type === "counter") return existing;
    const created: CounterEntry = {
      type: "counter",
      value: 0,
      labels: cloneLabels(labels),
    };
    registry.set(key, created);
    return created;
  }

  function upsertGauge(name: string, labels?: MetricLabels): GaugeEntry {
    const key = metricKey(name, labels);
    const existing = registry.get(key);
    if (existing?.type === "gauge") return existing;
    const created: GaugeEntry = {
      type: "gauge",
      value: 0,
      labels: cloneLabels(labels),
    };
    registry.set(key, created);
    return created;
  }

  function upsertHistogram(name: string, labels?: MetricLabels): HistogramEntry {
    const key = metricKey(name, labels);
    const existing = registry.get(key);
    if (existing?.type === "histogram") return existing;
    const created: HistogramEntry = {
      type: "histogram",
      sum: 0,
      count: 0,
      labels: cloneLabels(labels),
      buckets: new Map(DEFAULT_HISTOGRAM_BUCKETS.map((bucket) => [bucket, 0])),
    };
    registry.set(key, created);
    return created;
  }

  function samples(): PrometheusSample[] {
    return [...registry.entries()].map(([key, entry]) => {
      const name = key.slice(0, key.indexOf("|"));
      if (entry.type === "histogram") {
        return {
          name,
          type: entry.type,
          labels: entry.labels,
          buckets: new Map(entry.buckets),
          sum: entry.sum,
          count: entry.count,
        };
      }
      return {
        name,
        type: entry.type,
        labels: entry.labels,
        value: entry.value,
      };
    });
  }

  const service: MetricsServiceShape = {
    increment: (name, labels) => service.incrementBy(name, 1, labels),
    incrementBy: (name, value, labels) =>
      Effect.sync(() => {
        const key = metricKey(name, labels);
        const existing = registry.get(key);
        const definition = smithersMetricCatalogByName.get(name);
        if (existing?.type === "gauge" || definition?.type === "gauge") {
          upsertGauge(name, labels).value += value;
          return;
        }
        upsertCounter(name, labels).value += value;
      }),
    gauge: (name, value, labels) =>
      Effect.sync(() => {
        upsertGauge(name, labels).value = value;
      }),
    histogram: (name, value, labels) =>
      Effect.sync(() => {
        const entry = upsertHistogram(name, labels);
        entry.count += 1;
        entry.sum += value;
        for (const boundary of DEFAULT_HISTOGRAM_BUCKETS) {
          if (value <= boundary) {
            entry.buckets.set(boundary, (entry.buckets.get(boundary) ?? 0) + 1);
          }
        }
      }),
    recordEvent: (event) => {
      const eventType = String(event.type);
      const countEvent = service.increment("smithers.events.emitted_total", {
        type: eventType,
      });
      switch (event.type) {
        case "RunStarted":
          return Effect.all(
            [
              countEvent,
              service.increment("smithers.runs.total"),
              service.incrementBy("smithers.runs.active", 1),
            ],
            { discard: true },
          );
        case "RunFinished":
          return Effect.all(
            [
              countEvent,
              service.incrementBy("smithers.runs.active", -1),
              service.increment("smithers.runs.finished_total"),
            ],
            { discard: true },
          );
        case "RunFailed":
          return Effect.all(
            [
              countEvent,
              service.incrementBy("smithers.runs.active", -1),
              service.increment("smithers.runs.failed_total"),
              service.increment("smithers.errors.total"),
            ],
            { discard: true },
          );
        case "RunCancelled":
          return Effect.all(
            [
              countEvent,
              service.incrementBy("smithers.runs.active", -1),
              service.increment("smithers.runs.cancelled_total"),
            ],
            { discard: true },
          );
        case "RunContinuedAsNew":
          return Effect.all(
            [countEvent, service.increment("smithers.runs.continued_total")],
            { discard: true },
          );
        case "NodeStarted":
          return Effect.all(
            [
              countEvent,
              service.increment("smithers.nodes.started"),
              service.incrementBy("smithers.nodes.active", 1),
            ],
            { discard: true },
          );
        case "NodeFinished":
          return Effect.all(
            [
              countEvent,
              service.increment("smithers.nodes.finished"),
              service.incrementBy("smithers.nodes.active", -1),
              typeof event.durationMs === "number"
                ? service.histogram("smithers.node.duration_ms", event.durationMs)
                : Effect.void,
            ],
            { discard: true },
          );
        case "NodeFailed":
          return Effect.all(
            [
              countEvent,
              service.increment("smithers.nodes.failed"),
              service.increment("smithers.errors.total"),
              service.incrementBy("smithers.nodes.active", -1),
            ],
            { discard: true },
          );
        case "CacheHit":
          return Effect.all(
            [countEvent, service.increment("smithers.cache.hits")],
            { discard: true },
          );
        case "CacheMiss":
          return Effect.all(
            [countEvent, service.increment("smithers.cache.misses")],
            { discard: true },
          );
        case "ApprovalRequested":
          return Effect.all(
            [
              countEvent,
              service.increment("smithers.approvals.requested"),
              service.incrementBy("smithers.approval.pending", 1),
            ],
            { discard: true },
          );
        case "ApprovalResolved": {
          const approved = event.approved === true || event.status === "approved";
          return Effect.all(
            [
              countEvent,
              service.increment(
                approved
                  ? "smithers.approvals.granted"
                  : "smithers.approvals.denied",
              ),
              service.incrementBy("smithers.approval.pending", -1),
            ],
            { discard: true },
          );
        }
        case "TimerCreated":
          return Effect.all(
            [
              countEvent,
              service.increment("smithers.timers.created"),
              service.incrementBy("smithers.timers.pending", 1),
            ],
            { discard: true },
          );
        case "TimerFired":
          return Effect.all(
            [
              countEvent,
              service.increment("smithers.timers.fired"),
              service.incrementBy("smithers.timers.pending", -1),
            ],
            { discard: true },
          );
        case "TaskHeartbeat":
          return Effect.all(
            [countEvent, service.increment("smithers.heartbeats.total")],
            { discard: true },
          );
        case "TaskHeartbeatTimeout":
          return Effect.all(
            [
              countEvent,
              service.increment("smithers.heartbeats.timeout_total"),
              service.increment("smithers.errors.total"),
            ],
            { discard: true },
          );
        case "TokenUsageReported": {
          const effects: Effect.Effect<void>[] = [countEvent];
          const labels = {
            ...(typeof event.agent === "string" ? { agent: event.agent } : {}),
            ...(typeof event.model === "string" ? { model: event.model } : {}),
          };
          const push = (name: string, value: unknown) => {
            if (typeof value === "number" && Number.isFinite(value) && value > 0) {
              effects.push(service.incrementBy(name, value, labels));
            }
          };
          push("smithers.tokens.input_total", event.inputTokens);
          push("smithers.tokens.output_total", event.outputTokens);
          push("smithers.tokens.cache_read_total", event.cacheReadTokens);
          push("smithers.tokens.cache_write_total", event.cacheWriteTokens);
          push("smithers.tokens.reasoning_total", event.reasoningTokens);
          return Effect.all(effects, { discard: true });
        }
        default:
          return countEvent;
      }
    },
    updateProcessMetrics: () =>
      Effect.sync(() => {
        const uptimeS = (Date.now() - processStartMs) / 1000;
        const mem = process.memoryUsage();
        upsertGauge("smithers.process.uptime_seconds").value = uptimeS;
        upsertGauge("smithers.process.memory_rss_bytes").value = mem.rss;
        upsertGauge("smithers.process.heap_used_bytes").value = mem.heapUsed;
      }),
    updateAsyncExternalWaitPending: (kind, delta) =>
      Effect.sync(() => {
        asyncExternalWaitCounts[kind] = Math.max(
          0,
          asyncExternalWaitCounts[kind] + delta,
        );
        upsertGauge("smithers.external_wait.async_pending", { kind }).value =
          asyncExternalWaitCounts[kind];
      }),
    renderPrometheus: () => Effect.sync(() => renderPrometheusSamples(samples())),
    snapshot: () => Effect.sync(() => new Map(registry)),
  };

  return service;
}

export const MetricsServiceLive = Layer.sync(
  MetricsService,
  makeInMemoryMetricsService,
);

export const MetricsServiceNoop = Layer.succeed(MetricsService, {
  increment: () => Effect.void,
  incrementBy: () => Effect.void,
  gauge: () => Effect.void,
  histogram: () => Effect.void,
  recordEvent: () => Effect.void,
  updateProcessMetrics: () => Effect.void,
  updateAsyncExternalWaitPending: () => Effect.void,
  renderPrometheus: () => Effect.succeed(""),
  snapshot: () => Effect.succeed(new Map()),
} satisfies MetricsServiceShape);
