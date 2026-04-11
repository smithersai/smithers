import {
  renderPrometheusSamples,
  type MetricLabels,
  type MetricsServiceShape,
  type MetricsSnapshot,
  type PrometheusSample,
} from "@smithers/core/observability";
import { Effect, Metric, MetricBoundaries, MetricState } from "effect";
import type { SmithersEvent } from "@smithers/core/SmithersEvent";
import {
  ragEmbedDuration,
  ragIngestCount,
  ragRetrieveCount,
  ragRetrieveDuration,
} from "@smithers/rag/metrics";
import {
  memoryFactReads,
  memoryFactWrites,
  memoryRecallDuration,
  memoryRecallQueries,
  memoryMessageSaves,
} from "@smithers/memory/metrics";
import {
  openApiToolCallsTotal,
  openApiToolCallErrorsTotal,
  openApiToolDuration,
} from "@smithers/openapi/metrics";
import {
  scorerDuration,
  scorersFailed,
  scorersFinished,
  scorersStarted,
} from "@smithers/scorers/metrics";
import {
  replaysStarted,
  runForksCreated,
  snapshotDuration,
  snapshotsCaptured,
} from "@smithers/time-travel/metrics";

// ---------------------------------------------------------------------------
// Counters — existing
// ---------------------------------------------------------------------------

export const runsTotal = Metric.counter("smithers.runs.total");
export const nodesStarted = Metric.counter("smithers.nodes.started");
export const nodesFinished = Metric.counter("smithers.nodes.finished");
export const nodesFailed = Metric.counter("smithers.nodes.failed");
export const toolCallsTotal = Metric.counter("smithers.tool_calls.total");
export const cacheHits = Metric.counter("smithers.cache.hits");
export const cacheMisses = Metric.counter("smithers.cache.misses");
export const dbRetries = Metric.counter("smithers.db.retries");
export const dbTransactionRollbacks = Metric.counter("smithers.db.transaction_rollbacks");
export const dbTransactionRetries = Metric.counter("smithers.db.transaction_retries");
export const hotReloads = Metric.counter("smithers.hot.reloads");
export const hotReloadFailures = Metric.counter("smithers.hot.reload_failures");
export const httpRequests = Metric.counter("smithers.http.requests");
export const approvalsRequested = Metric.counter("smithers.approvals.requested");
export const approvalsGranted = Metric.counter("smithers.approvals.granted");
export const approvalsDenied = Metric.counter("smithers.approvals.denied");
export const timersCreated = Metric.counter("smithers.timers.created");
export const timersFired = Metric.counter("smithers.timers.fired");
export const timersCancelled = Metric.counter("smithers.timers.cancelled");
export const sandboxCreatedTotal = Metric.counter("smithers.sandbox.created_total");
export const sandboxCompletedTotal = Metric.counter("smithers.sandbox.completed_total");
export const alertsFiredTotal = Metric.counter("smithers.alerts.fired_total");
export const alertsAcknowledgedTotal = Metric.counter(
  "smithers.alerts.acknowledged_total",
);
export const alertsResolvedTotal = Metric.counter("smithers.alerts.resolved_total");
export const alertsSilencedTotal = Metric.counter("smithers.alerts.silenced_total");
export const alertsReopenedTotal = Metric.counter("smithers.alerts.reopened_total");
export const alertsEscalatedTotal = Metric.counter("smithers.alerts.escalated_total");
export const alertDeliveriesAttempted = Metric.counter("smithers.alerts.deliveries_attempted");
export const alertDeliveriesSuppressed = Metric.counter("smithers.alerts.deliveries_suppressed");

// ---------------------------------------------------------------------------
// Counters — scorers (event-driven tracking, distinct from src/scorers/metrics)
// ---------------------------------------------------------------------------

export const scorerEventsStarted = Metric.counter("smithers.scorer_events.started");
export const scorerEventsFinished = Metric.counter("smithers.scorer_events.finished");
export const scorerEventsFailed = Metric.counter("smithers.scorer_events.failed");

// ---------------------------------------------------------------------------
// Counters — token usage
// ---------------------------------------------------------------------------

export const tokensInputTotal = Metric.counter("smithers.tokens.input_total");
export const tokensOutputTotal = Metric.counter("smithers.tokens.output_total");
export const tokensCacheReadTotal = Metric.counter("smithers.tokens.cache_read_total");
export const tokensCacheWriteTotal = Metric.counter("smithers.tokens.cache_write_total");
export const tokensReasoningTotal = Metric.counter("smithers.tokens.reasoning_total");
export const tokensContextWindowBucketTotal = Metric.counter(
  "smithers.tokens.context_window_bucket_total",
);

// ---------------------------------------------------------------------------
// Counters — run lifecycle
// ---------------------------------------------------------------------------

export const runsFinishedTotal = Metric.counter("smithers.runs.finished_total");
export const runsFailedTotal = Metric.counter("smithers.runs.failed_total");
export const runsCancelledTotal = Metric.counter("smithers.runs.cancelled_total");
export const runsResumedTotal = Metric.counter("smithers.runs.resumed_total");
export const runsContinuedTotal = Metric.counter("smithers.runs.continued_total");
export const supervisorPollsTotal = Metric.counter("smithers.supervisor.polls_total");
export const supervisorStaleDetected = Metric.counter("smithers.supervisor.stale_detected");
export const supervisorResumedTotal = Metric.counter("smithers.supervisor.resumed_total");
export const supervisorSkippedTotal = Metric.counter("smithers.supervisor.skipped_total");

// ---------------------------------------------------------------------------
// Counters — errors & retries
// ---------------------------------------------------------------------------

export const errorsTotal = Metric.counter("smithers.errors.total");
export const nodeRetriesTotal = Metric.counter("smithers.node.retries_total");
export const toolCallErrorsTotal = Metric.counter("smithers.tool_calls.errors_total");
export const toolOutputTruncatedTotal = Metric.counter("smithers.tool.output_truncated_total");

// ---------------------------------------------------------------------------
// Counters — agents
// ---------------------------------------------------------------------------

export const agentInvocationsTotal = Metric.counter("smithers.agent_invocations_total");
export const agentTokensTotal = Metric.counter("smithers.agent_tokens_total");
export const agentErrorsTotal = Metric.counter("smithers.agent_errors_total");
export const agentRetriesTotal = Metric.counter("smithers.agent_retries_total");
export const agentEventsTotal = Metric.counter("smithers.agent_events_total");
export const agentSessionsTotal = Metric.counter("smithers.agent_sessions_total");
export const agentActionsTotal = Metric.counter("smithers.agent_actions_total");

// ---------------------------------------------------------------------------
// Counters — voice
// ---------------------------------------------------------------------------

export const voiceOperationsTotal = Metric.counter("smithers.voice.operations_total");
export const voiceErrorsTotal = Metric.counter("smithers.voice.errors_total");

// ---------------------------------------------------------------------------
// Counters — gateway
// ---------------------------------------------------------------------------

export const gatewayConnectionsTotal = Metric.counter(
  "smithers.gateway.connections_total",
);
export const gatewayConnectionsClosedTotal = Metric.counter(
  "smithers.gateway.connections_closed_total",
);
export const gatewayMessagesReceivedTotal = Metric.counter(
  "smithers.gateway.messages_received_total",
);
export const gatewayMessagesSentTotal = Metric.counter(
  "smithers.gateway.messages_sent_total",
);
export const gatewayRpcCallsTotal = Metric.counter(
  "smithers.gateway.rpc_calls_total",
);
export const gatewayErrorsTotal = Metric.counter("smithers.gateway.errors_total");
export const gatewayRunsStartedTotal = Metric.counter(
  "smithers.gateway.runs_started_total",
);
export const gatewayRunsCompletedTotal = Metric.counter(
  "smithers.gateway.runs_completed_total",
);
export const gatewayApprovalDecisionsTotal = Metric.counter(
  "smithers.gateway.approval_decisions_total",
);
export const gatewaySignalsTotal = Metric.counter("smithers.gateway.signals_total");
export const gatewayAuthEventsTotal = Metric.counter(
  "smithers.gateway.auth_events_total",
);
export const gatewayHeartbeatTicksTotal = Metric.counter(
  "smithers.gateway.heartbeat_ticks_total",
);
export const gatewayCronTriggersTotal = Metric.counter(
  "smithers.gateway.cron_triggers_total",
);
export const gatewayWebhooksReceivedTotal = Metric.counter(
  "smithers.gateway.webhooks_received_total",
);
export const gatewayWebhooksVerifiedTotal = Metric.counter(
  "smithers.gateway.webhooks_verified_total",
);
export const gatewayWebhooksRejectedTotal = Metric.counter(
  "smithers.gateway.webhooks_rejected_total",
);

// ---------------------------------------------------------------------------
// Counters — events
// ---------------------------------------------------------------------------

export const eventsEmittedTotal = Metric.counter("smithers.events.emitted_total");
export const taskHeartbeatsTotal = Metric.counter("smithers.heartbeats.total");
export const taskHeartbeatTimeoutTotal = Metric.counter("smithers.heartbeats.timeout_total");

// ---------------------------------------------------------------------------
// Gauges — existing
// ---------------------------------------------------------------------------

export const activeRuns = Metric.gauge("smithers.runs.active");
export const activeNodes = Metric.gauge("smithers.nodes.active");
export const schedulerQueueDepth = Metric.gauge("smithers.scheduler.queue_depth");
export const sandboxActive = Metric.gauge("smithers.sandbox.active");
export const alertsActive = Metric.gauge("smithers.alerts.active");
export const attentionBacklog = Metric.gauge("smithers.attention.backlog");

// ---------------------------------------------------------------------------
// Gauges — gateway
// ---------------------------------------------------------------------------

export const gatewayConnectionsActive = Metric.gauge(
  "smithers.gateway.connections_active",
);

// ---------------------------------------------------------------------------
// Gauges — MCP
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Gauges — new
// ---------------------------------------------------------------------------

export const approvalPending = Metric.gauge("smithers.approval.pending");
export const externalWaitAsyncPending = Metric.gauge(
  "smithers.external_wait.async_pending",
);
export const timersPending = Metric.gauge("smithers.timers.pending");
export const schedulerConcurrencyUtilization = Metric.gauge("smithers.scheduler.concurrency_utilization");
export const processUptimeSeconds = Metric.gauge("smithers.process.uptime_seconds");
export const processMemoryRssBytes = Metric.gauge("smithers.process.memory_rss_bytes");
export const processHeapUsedBytes = Metric.gauge("smithers.process.heap_used_bytes");

const asyncExternalWaitCounts: Record<"approval" | "event", number> = {
  approval: 0,
  event: 0,
};

// ---------------------------------------------------------------------------
// Histograms — buckets
// ---------------------------------------------------------------------------

const durationBuckets = MetricBoundaries.exponential({
  start: 100,
  factor: 2,
  count: 12,
}); // ~100ms to ~200s

const fastBuckets = MetricBoundaries.exponential({
  start: 1,
  factor: 2,
  count: 12,
}); // ~1ms to ~2s

const toolBuckets = MetricBoundaries.exponential({
  start: 10,
  factor: 2,
  count: 14,
}); // ~10ms to ~80s

const tokenBuckets = MetricBoundaries.exponential({
  start: 10,
  factor: 2,
  count: 18,
}); // ~10 to ~1.3M tokens

const contextWindowBuckets = MetricBoundaries.fromIterable([
  50_000,
  100_000,
  200_000,
  500_000,
  1_000_000,
]);

const sizeBuckets = MetricBoundaries.exponential({
  start: 100,
  factor: 2,
  count: 16,
}); // ~100 bytes to ~3.2MB

const carriedStateSizeBuckets = MetricBoundaries.exponential({
  start: 256,
  factor: 2,
  count: 17,
}); // ~256 bytes to ~16MB

const ancestryDepthBuckets = MetricBoundaries.exponential({
  start: 1,
  factor: 2,
  count: 12,
}); // depth 1 to 2048

// ---------------------------------------------------------------------------
// Histograms — existing
// ---------------------------------------------------------------------------

export const nodeDuration = Metric.histogram(
  "smithers.node.duration_ms",
  durationBuckets,
);

export const attemptDuration = Metric.histogram(
  "smithers.attempt.duration_ms",
  durationBuckets,
);

export const toolDuration = Metric.histogram(
  "smithers.tool.duration_ms",
  toolBuckets,
);

export const dbQueryDuration = Metric.histogram(
  "smithers.db.query_ms",
  fastBuckets,
);

export const dbTransactionDuration = Metric.histogram(
  "smithers.db.transaction_ms",
  fastBuckets,
);

export const httpRequestDuration = Metric.histogram(
  "smithers.http.request_duration_ms",
  fastBuckets,
);

export const hotReloadDuration = Metric.histogram(
  "smithers.hot.reload_duration_ms",
  durationBuckets,
);

export const vcsDuration = Metric.histogram(
  "smithers.vcs.duration_ms",
  fastBuckets,
);

export const agentDurationMs = Metric.histogram(
  "smithers.agent_duration_ms",
  durationBuckets,
);

// ---------------------------------------------------------------------------
// Histograms — new
// ---------------------------------------------------------------------------

export const tokensInputPerCall = Metric.histogram(
  "smithers.tokens.input_per_call",
  tokenBuckets,
);

export const tokensOutputPerCall = Metric.histogram(
  "smithers.tokens.output_per_call",
  tokenBuckets,
);

export const tokensContextWindowPerCall = Metric.histogram(
  "smithers.tokens.context_window_per_call",
  contextWindowBuckets,
);

export const runDuration = Metric.histogram(
  "smithers.run.duration_ms",
  durationBuckets,
);

export const promptSizeBytes = Metric.histogram(
  "smithers.prompt.size_bytes",
  sizeBuckets,
);

export const responseSizeBytes = Metric.histogram(
  "smithers.response.size_bytes",
  sizeBuckets,
);

export const approvalWaitDuration = Metric.histogram(
  "smithers.approval.wait_duration_ms",
  durationBuckets,
);

export const timerDelayDuration = Metric.histogram(
  "smithers.timers.delay_ms",
  durationBuckets,
);

export const voiceDuration = Metric.histogram(
  "smithers.voice.duration_ms",
  durationBuckets,
);

export const gatewayRpcDuration = Metric.histogram(
  "smithers.gateway.rpc_duration_ms",
  durationBuckets,
);


// TODO: instrument once TaskDescriptor carries `pendingSinceMs` from the node
// row's `updatedAtMs` — currently the timestamp is not available at dispatch
// time without an extra DB read per task.
export const schedulerWaitDuration = Metric.histogram(
  "smithers.scheduler.wait_duration_ms",
  durationBuckets,
);

export const supervisorPollDuration = Metric.histogram(
  "smithers.supervisor.poll_duration_ms",
  fastBuckets,
);

export const supervisorResumeLag = Metric.histogram(
  "smithers.supervisor.resume_lag_ms",
  durationBuckets,
);

export const runsAncestryDepth = Metric.histogram(
  "smithers.runs.ancestry_depth",
  ancestryDepthBuckets,
);

export const runsCarriedStateBytes = Metric.histogram(
  "smithers.runs.carried_state_bytes",
  carriedStateSizeBuckets,
);

export const sandboxDurationMs = Metric.histogram(
  "smithers.sandbox.duration_ms",
  durationBuckets,
);

export const sandboxBundleSizeBytes = Metric.histogram(
  "smithers.sandbox.bundle_size_bytes",
  sizeBuckets,
);

export const sandboxTransportDurationMs = Metric.histogram(
  "smithers.sandbox.transport_duration_ms",
  durationBuckets,
);

export const sandboxPatchCount = Metric.histogram(
  "smithers.sandbox.patch_count",
  tokenBuckets,
);

export const heartbeatDataSizeBytes = Metric.histogram(
  "smithers.heartbeats.data_size_bytes",
  sizeBuckets,
);

export const heartbeatIntervalMs = Metric.histogram(
  "smithers.heartbeats.interval_ms",
  fastBuckets,
);

export type SmithersMetricType = "counter" | "gauge" | "histogram";
export type SmithersMetricUnit =
  | "count"
  | "milliseconds"
  | "seconds"
  | "bytes"
  | "tokens"
  | "ratio"
  | "depth";

export type SmithersMetricDefinition = {
  readonly key: string;
  readonly metric: Metric.Metric<any, any, any>;
  readonly name: string;
  readonly prometheusName: string;
  readonly type: SmithersMetricType;
  readonly label: string;
  readonly unit?: SmithersMetricUnit;
  readonly description?: string;
  readonly labels?: readonly string[];
  readonly boundaries?: readonly number[];
  readonly defaultLabels?: readonly Readonly<Record<string, string>>[];
};

export function toPrometheusMetricName(name: string): string {
  const next = name.replace(/[^a-zA-Z0-9_:]/g, "_");
  return /^[a-zA-Z_:]/.test(next) ? next : `_${next}`;
}

function metricBoundaryValues(boundaries: any): readonly number[] {
  return Array.from((boundaries?.values ?? []) as Iterable<number>).sort(
    (left, right) => left - right,
  );
}

function metricHistogramBoundaries(
  metric: Metric.Metric<any, any, any>,
): readonly number[] {
  return Array.from(
    ((metric as any)?.keyType?.boundaries?.values ?? []) as Iterable<number>,
  )
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
}

function metricDefinition(
  key: string,
  metric: Metric.Metric<any, any, any>,
  name: string,
  type: SmithersMetricType,
  options: Omit<
    SmithersMetricDefinition,
    "key" | "metric" | "name" | "prometheusName" | "type"
  >,
): SmithersMetricDefinition {
  return {
    key,
    metric,
    name,
    prometheusName: toPrometheusMetricName(name),
    type,
    ...options,
  };
}

const durationBucketValues = metricBoundaryValues(durationBuckets);
const fastBucketValues = metricBoundaryValues(fastBuckets);
const toolBucketValues = metricBoundaryValues(toolBuckets);
const tokenBucketValues = metricBoundaryValues(tokenBuckets);
const contextWindowBucketValues = metricBoundaryValues(contextWindowBuckets);
const sizeBucketValues = metricBoundaryValues(sizeBuckets);
const carriedStateSizeBucketValues = metricBoundaryValues(carriedStateSizeBuckets);
const ancestryDepthBucketValues = metricBoundaryValues(ancestryDepthBuckets);

export const smithersMetricCatalog: ReadonlyArray<SmithersMetricDefinition> = [
  metricDefinition("runsTotal", runsTotal, "smithers.runs.total", "counter", { label: "Runs started", unit: "count" }),
  metricDefinition("nodesStarted", nodesStarted, "smithers.nodes.started", "counter", { label: "Nodes started", unit: "count" }),
  metricDefinition("nodesFinished", nodesFinished, "smithers.nodes.finished", "counter", { label: "Nodes finished", unit: "count" }),
  metricDefinition("nodesFailed", nodesFailed, "smithers.nodes.failed", "counter", { label: "Nodes failed", unit: "count" }),
  metricDefinition("toolCallsTotal", toolCallsTotal, "smithers.tool_calls.total", "counter", { label: "Tool calls", unit: "count" }),
  metricDefinition("cacheHits", cacheHits, "smithers.cache.hits", "counter", { label: "Cache hits", unit: "count" }),
  metricDefinition("cacheMisses", cacheMisses, "smithers.cache.misses", "counter", { label: "Cache misses", unit: "count" }),
  metricDefinition("dbRetries", dbRetries, "smithers.db.retries", "counter", { label: "DB retries", unit: "count" }),
  metricDefinition("dbTransactionRollbacks", dbTransactionRollbacks, "smithers.db.transaction_rollbacks", "counter", { label: "DB transaction rollbacks", unit: "count" }),
  metricDefinition("dbTransactionRetries", dbTransactionRetries, "smithers.db.transaction_retries", "counter", { label: "DB transaction retries", unit: "count" }),
  metricDefinition("hotReloads", hotReloads, "smithers.hot.reloads", "counter", { label: "Hot reloads", unit: "count" }),
  metricDefinition("hotReloadFailures", hotReloadFailures, "smithers.hot.reload_failures", "counter", { label: "Hot reload failures", unit: "count" }),
  metricDefinition("httpRequests", httpRequests, "smithers.http.requests", "counter", {
    label: "HTTP requests",
    unit: "count",
    labels: ["method", "route", "status_code", "status_class"],
  }),
  metricDefinition("approvalsRequested", approvalsRequested, "smithers.approvals.requested", "counter", { label: "Approvals requested", unit: "count" }),
  metricDefinition("approvalsGranted", approvalsGranted, "smithers.approvals.granted", "counter", { label: "Approvals granted", unit: "count" }),
  metricDefinition("approvalsDenied", approvalsDenied, "smithers.approvals.denied", "counter", { label: "Approvals denied", unit: "count" }),
  metricDefinition("timersCreated", timersCreated, "smithers.timers.created", "counter", { label: "Timers created", unit: "count" }),
  metricDefinition("timersFired", timersFired, "smithers.timers.fired", "counter", { label: "Timers fired", unit: "count" }),
  metricDefinition("timersCancelled", timersCancelled, "smithers.timers.cancelled", "counter", { label: "Timers cancelled", unit: "count" }),
  metricDefinition("sandboxCreatedTotal", sandboxCreatedTotal, "smithers.sandbox.created_total", "counter", {
    label: "Sandboxes created",
    unit: "count",
    labels: ["runtime"],
  }),
  metricDefinition("sandboxCompletedTotal", sandboxCompletedTotal, "smithers.sandbox.completed_total", "counter", {
    label: "Sandboxes completed",
    unit: "count",
    labels: ["runtime", "status"],
  }),
  metricDefinition("alertsFiredTotal", alertsFiredTotal, "smithers.alerts.fired_total", "counter", {
    label: "Alerts fired",
    unit: "count",
    labels: ["policy"],
  }),
  metricDefinition("alertsAcknowledgedTotal", alertsAcknowledgedTotal, "smithers.alerts.acknowledged_total", "counter", {
    label: "Alerts acknowledged",
    unit: "count",
    labels: ["policy"],
  }),
  metricDefinition("scorerEventsStarted", scorerEventsStarted, "smithers.scorer_events.started", "counter", { label: "Scorer events started", unit: "count" }),
  metricDefinition("scorerEventsFinished", scorerEventsFinished, "smithers.scorer_events.finished", "counter", { label: "Scorer events finished", unit: "count" }),
  metricDefinition("scorerEventsFailed", scorerEventsFailed, "smithers.scorer_events.failed", "counter", { label: "Scorer events failed", unit: "count" }),
  metricDefinition("tokensInputTotal", tokensInputTotal, "smithers.tokens.input_total", "counter", {
    label: "Input tokens",
    unit: "tokens",
    labels: ["agent", "model"],
  }),
  metricDefinition("tokensOutputTotal", tokensOutputTotal, "smithers.tokens.output_total", "counter", {
    label: "Output tokens",
    unit: "tokens",
    labels: ["agent", "model"],
  }),
  metricDefinition("tokensCacheReadTotal", tokensCacheReadTotal, "smithers.tokens.cache_read_total", "counter", {
    label: "Cache read tokens",
    unit: "tokens",
    labels: ["agent", "model"],
  }),
  metricDefinition("tokensCacheWriteTotal", tokensCacheWriteTotal, "smithers.tokens.cache_write_total", "counter", {
    label: "Cache write tokens",
    unit: "tokens",
    labels: ["agent", "model"],
  }),
  metricDefinition("tokensReasoningTotal", tokensReasoningTotal, "smithers.tokens.reasoning_total", "counter", {
    label: "Reasoning tokens",
    unit: "tokens",
    labels: ["agent", "model"],
  }),
  metricDefinition("tokensContextWindowBucketTotal", tokensContextWindowBucketTotal, "smithers.tokens.context_window_bucket_total", "counter", {
    label: "Context window bucket hits",
    unit: "count",
    labels: ["agent", "bucket", "model"],
  }),
  metricDefinition("runsFinishedTotal", runsFinishedTotal, "smithers.runs.finished_total", "counter", { label: "Runs finished", unit: "count" }),
  metricDefinition("runsFailedTotal", runsFailedTotal, "smithers.runs.failed_total", "counter", { label: "Runs failed", unit: "count" }),
  metricDefinition("runsCancelledTotal", runsCancelledTotal, "smithers.runs.cancelled_total", "counter", { label: "Runs cancelled", unit: "count" }),
  metricDefinition("runsResumedTotal", runsResumedTotal, "smithers.runs.resumed_total", "counter", { label: "Runs resumed", unit: "count" }),
  metricDefinition("runsContinuedTotal", runsContinuedTotal, "smithers.runs.continued_total", "counter", { label: "Runs continued", unit: "count" }),
  metricDefinition("supervisorPollsTotal", supervisorPollsTotal, "smithers.supervisor.polls_total", "counter", { label: "Supervisor polls", unit: "count" }),
  metricDefinition("supervisorStaleDetected", supervisorStaleDetected, "smithers.supervisor.stale_detected", "counter", { label: "Supervisor stale runs detected", unit: "count" }),
  metricDefinition("supervisorResumedTotal", supervisorResumedTotal, "smithers.supervisor.resumed_total", "counter", { label: "Supervisor auto-resumes", unit: "count" }),
  metricDefinition("supervisorSkippedTotal", supervisorSkippedTotal, "smithers.supervisor.skipped_total", "counter", {
    label: "Supervisor skipped auto-resumes",
    unit: "count",
    labels: ["reason"],
  }),
  metricDefinition("errorsTotal", errorsTotal, "smithers.errors.total", "counter", { label: "Errors", unit: "count" }),
  metricDefinition("nodeRetriesTotal", nodeRetriesTotal, "smithers.node.retries_total", "counter", { label: "Node retries", unit: "count" }),
  metricDefinition("toolCallErrorsTotal", toolCallErrorsTotal, "smithers.tool_calls.errors_total", "counter", { label: "Tool call errors", unit: "count" }),
  metricDefinition("toolOutputTruncatedTotal", toolOutputTruncatedTotal, "smithers.tool.output_truncated_total", "counter", { label: "Tool outputs truncated", unit: "count" }),
  metricDefinition("agentInvocationsTotal", agentInvocationsTotal, "smithers.agent_invocations_total", "counter", {
    label: "Agent invocations",
    unit: "count",
    labels: ["engine", "model"],
  }),
  metricDefinition("agentTokensTotal", agentTokensTotal, "smithers.agent_tokens_total", "counter", {
    label: "Agent tokens",
    unit: "tokens",
    labels: ["engine", "model", "kind", "source"],
  }),
  metricDefinition("agentErrorsTotal", agentErrorsTotal, "smithers.agent_errors_total", "counter", {
    label: "Agent errors",
    unit: "count",
    labels: ["engine", "model", "reason", "source"],
  }),
  metricDefinition("agentRetriesTotal", agentRetriesTotal, "smithers.agent_retries_total", "counter", {
    label: "Agent retries",
    unit: "count",
    labels: ["engine", "model", "reason", "source"],
  }),
  metricDefinition("agentEventsTotal", agentEventsTotal, "smithers.agent_events_total", "counter", {
    label: "Agent events",
    unit: "count",
    labels: ["engine", "event_type", "source"],
  }),
  metricDefinition("agentSessionsTotal", agentSessionsTotal, "smithers.agent_sessions_total", "counter", {
    label: "Agent sessions",
    unit: "count",
    labels: ["engine", "model", "resume", "source", "status"],
  }),
  metricDefinition("agentActionsTotal", agentActionsTotal, "smithers.agent_actions_total", "counter", {
    label: "Agent actions",
    unit: "count",
    labels: ["action_name", "action_type", "engine", "source"],
  }),
  metricDefinition("voiceOperationsTotal", voiceOperationsTotal, "smithers.voice.operations_total", "counter", { label: "Voice operations", unit: "count" }),
  metricDefinition("voiceErrorsTotal", voiceErrorsTotal, "smithers.voice.errors_total", "counter", { label: "Voice errors", unit: "count" }),
  metricDefinition("gatewayConnectionsTotal", gatewayConnectionsTotal, "smithers.gateway.connections_total", "counter", {
    label: "Gateway connections opened",
    unit: "count",
    labels: ["transport"],
  }),
  metricDefinition("gatewayConnectionsClosedTotal", gatewayConnectionsClosedTotal, "smithers.gateway.connections_closed_total", "counter", {
    label: "Gateway connections closed",
    unit: "count",
    labels: ["code", "reason", "transport"],
  }),
  metricDefinition("gatewayMessagesReceivedTotal", gatewayMessagesReceivedTotal, "smithers.gateway.messages_received_total", "counter", {
    label: "Gateway messages received",
    unit: "count",
    labels: ["kind", "transport"],
  }),
  metricDefinition("gatewayMessagesSentTotal", gatewayMessagesSentTotal, "smithers.gateway.messages_sent_total", "counter", {
    label: "Gateway messages sent",
    unit: "count",
    labels: ["kind", "transport"],
  }),
  metricDefinition("gatewayRpcCallsTotal", gatewayRpcCallsTotal, "smithers.gateway.rpc_calls_total", "counter", {
    label: "Gateway RPC calls",
    unit: "count",
    labels: ["method", "transport"],
  }),
  metricDefinition("gatewayErrorsTotal", gatewayErrorsTotal, "smithers.gateway.errors_total", "counter", {
    label: "Gateway errors",
    unit: "count",
    labels: ["code", "stage", "transport"],
  }),
  metricDefinition("gatewayRunsStartedTotal", gatewayRunsStartedTotal, "smithers.gateway.runs_started_total", "counter", {
    label: "Gateway runs started",
    unit: "count",
    labels: ["transport"],
  }),
  metricDefinition("gatewayRunsCompletedTotal", gatewayRunsCompletedTotal, "smithers.gateway.runs_completed_total", "counter", {
    label: "Gateway runs completed",
    unit: "count",
    labels: ["status", "transport"],
  }),
  metricDefinition("gatewayApprovalDecisionsTotal", gatewayApprovalDecisionsTotal, "smithers.gateway.approval_decisions_total", "counter", {
    label: "Gateway approval decisions",
    unit: "count",
    labels: ["decision", "transport"],
  }),
  metricDefinition("gatewaySignalsTotal", gatewaySignalsTotal, "smithers.gateway.signals_total", "counter", {
    label: "Gateway signals",
    unit: "count",
    labels: ["outcome", "transport"],
  }),
  metricDefinition("gatewayAuthEventsTotal", gatewayAuthEventsTotal, "smithers.gateway.auth_events_total", "counter", {
    label: "Gateway auth events",
    unit: "count",
    labels: ["outcome", "transport"],
  }),
  metricDefinition("gatewayHeartbeatTicksTotal", gatewayHeartbeatTicksTotal, "smithers.gateway.heartbeat_ticks_total", "counter", { label: "Gateway heartbeats", unit: "count" }),
  metricDefinition("gatewayCronTriggersTotal", gatewayCronTriggersTotal, "smithers.gateway.cron_triggers_total", "counter", {
    label: "Gateway cron triggers",
    unit: "count",
    labels: ["source"],
  }),
  metricDefinition("gatewayWebhooksReceivedTotal", gatewayWebhooksReceivedTotal, "smithers.gateway.webhooks_received_total", "counter", {
    label: "Gateway webhooks received",
    unit: "count",
    labels: ["provider"],
  }),
  metricDefinition("gatewayWebhooksVerifiedTotal", gatewayWebhooksVerifiedTotal, "smithers.gateway.webhooks_verified_total", "counter", {
    label: "Gateway webhooks verified",
    unit: "count",
    labels: ["provider"],
  }),
  metricDefinition("gatewayWebhooksRejectedTotal", gatewayWebhooksRejectedTotal, "smithers.gateway.webhooks_rejected_total", "counter", {
    label: "Gateway webhooks rejected",
    unit: "count",
    labels: ["provider", "reason"],
  }),
  metricDefinition("eventsEmittedTotal", eventsEmittedTotal, "smithers.events.emitted_total", "counter", { label: "Events emitted", unit: "count" }),
  metricDefinition("taskHeartbeatsTotal", taskHeartbeatsTotal, "smithers.heartbeats.total", "counter", { label: "Task heartbeats", unit: "count" }),
  metricDefinition("taskHeartbeatTimeoutTotal", taskHeartbeatTimeoutTotal, "smithers.heartbeats.timeout_total", "counter", { label: "Task heartbeat timeouts", unit: "count" }),
  metricDefinition("ragIngestCount", ragIngestCount, "smithers.rag.ingest_total", "counter", { label: "RAG documents ingested", unit: "count" }),
  metricDefinition("ragRetrieveCount", ragRetrieveCount, "smithers.rag.retrieve_total", "counter", { label: "RAG retrievals", unit: "count" }),
  metricDefinition("memoryFactReads", memoryFactReads, "smithers.memory.fact_reads", "counter", { label: "Memory fact reads", unit: "count" }),
  metricDefinition("memoryFactWrites", memoryFactWrites, "smithers.memory.fact_writes", "counter", { label: "Memory fact writes", unit: "count" }),
  metricDefinition("memoryRecallQueries", memoryRecallQueries, "smithers.memory.recall_queries", "counter", { label: "Memory recall queries", unit: "count" }),
  metricDefinition("memoryMessageSaves", memoryMessageSaves, "smithers.memory.message_saves", "counter", { label: "Memory messages saved", unit: "count" }),
  metricDefinition("openApiToolCallsTotal", openApiToolCallsTotal, "smithers.openapi.tool_calls", "counter", { label: "OpenAPI tool calls", unit: "count" }),
  metricDefinition("openApiToolCallErrorsTotal", openApiToolCallErrorsTotal, "smithers.openapi.tool_call_errors", "counter", { label: "OpenAPI tool call errors", unit: "count" }),
  metricDefinition("scorersStarted", scorersStarted, "smithers.scorers.started", "counter", { label: "Scorers started", unit: "count" }),
  metricDefinition("scorersFinished", scorersFinished, "smithers.scorers.finished", "counter", { label: "Scorers finished", unit: "count" }),
  metricDefinition("scorersFailed", scorersFailed, "smithers.scorers.failed", "counter", { label: "Scorers failed", unit: "count" }),
  metricDefinition("snapshotsCaptured", snapshotsCaptured, "smithers.snapshots.captured", "counter", { label: "Snapshots captured", unit: "count" }),
  metricDefinition("runForksCreated", runForksCreated, "smithers.forks.created", "counter", { label: "Run forks created", unit: "count" }),
  metricDefinition("replaysStarted", replaysStarted, "smithers.replays.started", "counter", { label: "Replays started", unit: "count" }),

  metricDefinition("activeRuns", activeRuns, "smithers.runs.active", "gauge", { label: "Active runs", unit: "count" }),
  metricDefinition("activeNodes", activeNodes, "smithers.nodes.active", "gauge", { label: "Active nodes", unit: "count" }),
  metricDefinition("schedulerQueueDepth", schedulerQueueDepth, "smithers.scheduler.queue_depth", "gauge", { label: "Scheduler queue depth", unit: "count" }),
  metricDefinition("sandboxActive", sandboxActive, "smithers.sandbox.active", "gauge", {
    label: "Active sandboxes",
    unit: "count",
    labels: ["runtime"],
  }),
  metricDefinition("alertsActive", alertsActive, "smithers.alerts.active", "gauge", {
    label: "Active alerts",
    unit: "count",
    labels: ["policy"],
  }),
  metricDefinition("gatewayConnectionsActive", gatewayConnectionsActive, "smithers.gateway.connections_active", "gauge", {
    label: "Active gateway connections",
    unit: "count",
    labels: ["transport"],
  }),
  metricDefinition("approvalPending", approvalPending, "smithers.approval.pending", "gauge", { label: "Pending approvals", unit: "count" }),
  metricDefinition("externalWaitAsyncPending", externalWaitAsyncPending, "smithers.external_wait.async_pending", "gauge", {
    label: "Pending external waits",
    unit: "count",
    labels: ["kind"],
    defaultLabels: [{ kind: "approval" }, { kind: "event" }],
  }),
  metricDefinition("timersPending", timersPending, "smithers.timers.pending", "gauge", { label: "Pending timers", unit: "count" }),
  metricDefinition("schedulerConcurrencyUtilization", schedulerConcurrencyUtilization, "smithers.scheduler.concurrency_utilization", "gauge", {
    label: "Scheduler concurrency utilization",
    unit: "ratio",
  }),
  metricDefinition("processUptimeSeconds", processUptimeSeconds, "smithers.process.uptime_seconds", "gauge", { label: "Process uptime", unit: "seconds" }),
  metricDefinition("processMemoryRssBytes", processMemoryRssBytes, "smithers.process.memory_rss_bytes", "gauge", { label: "Process RSS memory", unit: "bytes" }),
  metricDefinition("processHeapUsedBytes", processHeapUsedBytes, "smithers.process.heap_used_bytes", "gauge", { label: "Process heap used", unit: "bytes" }),

  metricDefinition("nodeDuration", nodeDuration, "smithers.node.duration_ms", "histogram", { label: "Node duration", unit: "milliseconds", boundaries: durationBucketValues }),
  metricDefinition("attemptDuration", attemptDuration, "smithers.attempt.duration_ms", "histogram", { label: "Attempt duration", unit: "milliseconds", boundaries: durationBucketValues }),
  metricDefinition("toolDuration", toolDuration, "smithers.tool.duration_ms", "histogram", { label: "Tool duration", unit: "milliseconds", boundaries: toolBucketValues }),
  metricDefinition("dbQueryDuration", dbQueryDuration, "smithers.db.query_ms", "histogram", { label: "DB query duration", unit: "milliseconds", boundaries: fastBucketValues }),
  metricDefinition("dbTransactionDuration", dbTransactionDuration, "smithers.db.transaction_ms", "histogram", { label: "DB transaction duration", unit: "milliseconds", boundaries: fastBucketValues }),
  metricDefinition("httpRequestDuration", httpRequestDuration, "smithers.http.request_duration_ms", "histogram", {
    label: "HTTP request duration",
    unit: "milliseconds",
    labels: ["method", "route", "status_code", "status_class"],
    boundaries: fastBucketValues,
  }),
  metricDefinition("hotReloadDuration", hotReloadDuration, "smithers.hot.reload_duration_ms", "histogram", { label: "Hot reload duration", unit: "milliseconds", boundaries: durationBucketValues }),
  metricDefinition("vcsDuration", vcsDuration, "smithers.vcs.duration_ms", "histogram", { label: "VCS duration", unit: "milliseconds", boundaries: fastBucketValues }),
  metricDefinition("agentDurationMs", agentDurationMs, "smithers.agent_duration_ms", "histogram", {
    label: "Agent duration",
    unit: "milliseconds",
    labels: ["engine", "model"],
    boundaries: durationBucketValues,
  }),
  metricDefinition("tokensInputPerCall", tokensInputPerCall, "smithers.tokens.input_per_call", "histogram", {
    label: "Input tokens per call",
    unit: "tokens",
    labels: ["agent", "model"],
    boundaries: tokenBucketValues,
  }),
  metricDefinition("tokensOutputPerCall", tokensOutputPerCall, "smithers.tokens.output_per_call", "histogram", {
    label: "Output tokens per call",
    unit: "tokens",
    labels: ["agent", "model"],
    boundaries: tokenBucketValues,
  }),
  metricDefinition("tokensContextWindowPerCall", tokensContextWindowPerCall, "smithers.tokens.context_window_per_call", "histogram", {
    label: "Context window per call",
    unit: "tokens",
    labels: ["agent", "model"],
    boundaries: contextWindowBucketValues,
  }),
  metricDefinition("runDuration", runDuration, "smithers.run.duration_ms", "histogram", { label: "Run duration", unit: "milliseconds", boundaries: durationBucketValues }),
  metricDefinition("promptSizeBytes", promptSizeBytes, "smithers.prompt.size_bytes", "histogram", { label: "Prompt size", unit: "bytes", boundaries: sizeBucketValues }),
  metricDefinition("responseSizeBytes", responseSizeBytes, "smithers.response.size_bytes", "histogram", { label: "Response size", unit: "bytes", boundaries: sizeBucketValues }),
  metricDefinition("approvalWaitDuration", approvalWaitDuration, "smithers.approval.wait_duration_ms", "histogram", { label: "Approval wait duration", unit: "milliseconds", boundaries: durationBucketValues }),
  metricDefinition("timerDelayDuration", timerDelayDuration, "smithers.timers.delay_ms", "histogram", { label: "Timer delay", unit: "milliseconds", boundaries: durationBucketValues }),
  metricDefinition("voiceDuration", voiceDuration, "smithers.voice.duration_ms", "histogram", { label: "Voice duration", unit: "milliseconds", boundaries: durationBucketValues }),
  metricDefinition("gatewayRpcDuration", gatewayRpcDuration, "smithers.gateway.rpc_duration_ms", "histogram", {
    label: "Gateway RPC duration",
    unit: "milliseconds",
    labels: ["method", "transport"],
    boundaries: durationBucketValues,
  }),
  metricDefinition("schedulerWaitDuration", schedulerWaitDuration, "smithers.scheduler.wait_duration_ms", "histogram", { label: "Scheduler wait duration", unit: "milliseconds", boundaries: durationBucketValues }),
  metricDefinition("supervisorPollDuration", supervisorPollDuration, "smithers.supervisor.poll_duration_ms", "histogram", { label: "Supervisor poll duration", unit: "milliseconds", boundaries: fastBucketValues }),
  metricDefinition("supervisorResumeLag", supervisorResumeLag, "smithers.supervisor.resume_lag_ms", "histogram", { label: "Supervisor resume lag", unit: "milliseconds", boundaries: durationBucketValues }),
  metricDefinition("runsAncestryDepth", runsAncestryDepth, "smithers.runs.ancestry_depth", "histogram", { label: "Run ancestry depth", unit: "depth", boundaries: ancestryDepthBucketValues }),
  metricDefinition("runsCarriedStateBytes", runsCarriedStateBytes, "smithers.runs.carried_state_bytes", "histogram", { label: "Run carried state size", unit: "bytes", boundaries: carriedStateSizeBucketValues }),
  metricDefinition("sandboxDurationMs", sandboxDurationMs, "smithers.sandbox.duration_ms", "histogram", { label: "Sandbox duration", unit: "milliseconds", boundaries: durationBucketValues }),
  metricDefinition("sandboxBundleSizeBytes", sandboxBundleSizeBytes, "smithers.sandbox.bundle_size_bytes", "histogram", { label: "Sandbox bundle size", unit: "bytes", boundaries: sizeBucketValues }),
  metricDefinition("sandboxTransportDurationMs", sandboxTransportDurationMs, "smithers.sandbox.transport_duration_ms", "histogram", { label: "Sandbox transport duration", unit: "milliseconds", boundaries: durationBucketValues }),
  metricDefinition("sandboxPatchCount", sandboxPatchCount, "smithers.sandbox.patch_count", "histogram", { label: "Sandbox patch count", unit: "count", boundaries: tokenBucketValues }),
  metricDefinition("heartbeatDataSizeBytes", heartbeatDataSizeBytes, "smithers.heartbeats.data_size_bytes", "histogram", { label: "Heartbeat data size", unit: "bytes", boundaries: sizeBucketValues }),
  metricDefinition("heartbeatIntervalMs", heartbeatIntervalMs, "smithers.heartbeats.interval_ms", "histogram", { label: "Heartbeat interval", unit: "milliseconds", boundaries: fastBucketValues }),
  metricDefinition("ragRetrieveDuration", ragRetrieveDuration, "smithers.rag.retrieve_duration_ms", "histogram", { label: "RAG retrieval duration", unit: "milliseconds", boundaries: metricHistogramBoundaries(ragRetrieveDuration) }),
  metricDefinition("ragEmbedDuration", ragEmbedDuration, "smithers.rag.embed_duration_ms", "histogram", { label: "RAG embedding duration", unit: "milliseconds", boundaries: metricHistogramBoundaries(ragEmbedDuration) }),
  metricDefinition("memoryRecallDuration", memoryRecallDuration, "smithers.memory.recall_duration_ms", "histogram", { label: "Memory recall duration", unit: "milliseconds", boundaries: metricHistogramBoundaries(memoryRecallDuration) }),
  metricDefinition("openApiToolDuration", openApiToolDuration, "smithers.openapi.tool_duration_ms", "histogram", { label: "OpenAPI tool duration", unit: "milliseconds", boundaries: metricHistogramBoundaries(openApiToolDuration) }),
  metricDefinition("scorerDuration", scorerDuration, "smithers.scorer.duration_ms", "histogram", { label: "Scorer duration", unit: "milliseconds", boundaries: metricHistogramBoundaries(scorerDuration) }),
  metricDefinition("snapshotDuration", snapshotDuration, "smithers.snapshot.duration_ms", "histogram", { label: "Snapshot duration", unit: "milliseconds", boundaries: metricHistogramBoundaries(snapshotDuration) }),
];

export const smithersMetricCatalogByKey = new Map(
  smithersMetricCatalog.map((metric) => [metric.key, metric] as const),
);

export const smithersMetricCatalogByPrometheusName = new Map(
  smithersMetricCatalog.map((metric) => [metric.prometheusName, metric] as const),
);

export const smithersMetricCatalogByName = new Map(
  smithersMetricCatalog.map((metric) => [metric.name, metric] as const),
);

function resolveMetricDefinition(name: string): SmithersMetricDefinition | undefined {
  return (
    smithersMetricCatalogByName.get(name) ??
    smithersMetricCatalogByPrometheusName.get(toPrometheusMetricName(name))
  );
}

function tagMetricWithLabels<A extends Metric.Metric<any, any, any>>(
  metric: A,
  labels?: MetricLabels,
): A {
  let tagged: any = metric;
  for (const [key, value] of Object.entries(labels ?? {})) {
    tagged = Metric.tagged(tagged, key, String(value));
  }
  return tagged as A;
}

function counterOrGaugeMetric(
  name: string,
  labels?: MetricLabels,
): Metric.Metric<any, number, any> {
  const definition = resolveMetricDefinition(name);
  const metric =
    definition?.type === "counter" || definition?.type === "gauge"
      ? definition.metric
      : Metric.counter(name);
  return tagMetricWithLabels(metric as Metric.Metric<any, number, any>, labels);
}

function gaugeMetric(
  name: string,
  labels?: MetricLabels,
): Metric.Metric<any, number, any> {
  const definition = resolveMetricDefinition(name);
  const metric = definition?.type === "gauge" ? definition.metric : Metric.gauge(name);
  return tagMetricWithLabels(metric as Metric.Metric<any, number, any>, labels);
}

function histogramMetric(
  name: string,
  labels?: MetricLabels,
): Metric.Metric<any, number, any> {
  const definition = resolveMetricDefinition(name);
  const metric =
    definition?.type === "histogram"
      ? definition.metric
      : Metric.histogram(name, durationBuckets);
  return tagMetricWithLabels(metric as Metric.Metric<any, number, any>, labels);
}

function metricValueAsNumber(value: number | bigint | undefined): number {
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function metricsServiceLabels(metricKey: any): MetricLabels {
  const tags: any[] = Array.isArray(metricKey?.tags) ? metricKey.tags : [];
  return Object.freeze(
    Object.fromEntries(
      tags
        .map((tag: any) => [String(tag.key), String(tag.value)] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function metricsServiceLabelsKey(labels: MetricLabels): string {
  return JSON.stringify(
    Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function metricsServiceSnapshotKey(name: string, labels: MetricLabels): string {
  return `${name}|${metricsServiceLabelsKey(labels)}`;
}

function metricsServicePrometheusSamples(): PrometheusSample[] {
  const samples: PrometheusSample[] = [];
  for (const snapshot of Metric.unsafeSnapshot()) {
    const metricKey = snapshot.metricKey as any;
    const metricState = snapshot.metricState as any;
    const name = String(metricKey.name ?? "");
    if (!name) continue;

    const labels = metricsServiceLabels(metricKey);
    if (MetricState.isCounterState(metricState)) {
      samples.push({
        name,
        type: "counter",
        labels,
        value: metricValueAsNumber(metricState.count),
      });
      continue;
    }

    if (MetricState.isGaugeState(metricState)) {
      samples.push({
        name,
        type: "gauge",
        labels,
        value: metricValueAsNumber(metricState.value),
      });
      continue;
    }

    if (MetricState.isHistogramState(metricState)) {
      samples.push({
        name,
        type: "histogram",
        labels,
        buckets: new Map(
          [...metricState.buckets].map(([boundary, count]) => [
            boundary,
            metricValueAsNumber(count),
          ]),
        ),
        sum: metricValueAsNumber(metricState.sum),
        count: metricValueAsNumber(metricState.count),
      });
    }
  }
  return samples;
}

function metricsServiceSnapshot(): MetricsSnapshot {
  const result = new Map<string, any>();
  for (const sample of metricsServicePrometheusSamples()) {
    const key = metricsServiceSnapshotKey(sample.name, sample.labels);
    if (sample.type === "histogram") {
      result.set(key, {
        type: "histogram",
        sum: sample.sum ?? 0,
        count: sample.count ?? 0,
        labels: sample.labels,
        buckets: new Map(sample.buckets ?? []),
      });
      continue;
    }
    result.set(key, {
      type: sample.type,
      value: sample.value ?? 0,
      labels: sample.labels,
    });
  }
  return result as MetricsSnapshot;
}

export const metricsServiceAdapter: MetricsServiceShape = {
  increment: (name, labels) =>
    Metric.incrementBy(counterOrGaugeMetric(name, labels) as any, 1),
  incrementBy: (name, value, labels) =>
    Metric.incrementBy(counterOrGaugeMetric(name, labels) as any, value),
  gauge: (name, value, labels) => Metric.set(gaugeMetric(name, labels) as any, value),
  histogram: (name, value, labels) =>
    Metric.update(histogramMetric(name, labels), value),
  recordEvent: (event) => trackEvent(event as SmithersEvent),
  updateProcessMetrics: () => updateProcessMetrics(),
  updateAsyncExternalWaitPending: (kind, delta) =>
    updateAsyncExternalWaitPending(kind, delta),
  renderPrometheus: () =>
    Effect.sync(() => renderPrometheusSamples(metricsServicePrometheusSamples())),
  snapshot: () => Effect.sync(metricsServiceSnapshot),
} satisfies MetricsServiceShape;

// ---------------------------------------------------------------------------
// Process-level metric snapshot (call periodically)
// ---------------------------------------------------------------------------

const processStartMs = Date.now();

export function updateProcessMetrics(): Effect.Effect<void> {
  const uptimeS = (Date.now() - processStartMs) / 1000;
  const mem = process.memoryUsage();
  return Effect.all([
    Metric.set(processUptimeSeconds, uptimeS),
    Metric.set(processMemoryRssBytes, mem.rss),
    Metric.set(processHeapUsedBytes, mem.heapUsed),
  ], { discard: true });
}

export function updateAsyncExternalWaitPending(
  kind: "approval" | "event",
  delta: number,
): Effect.Effect<void> {
  return Effect.sync(() => {
    asyncExternalWaitCounts[kind] = Math.max(
      0,
      asyncExternalWaitCounts[kind] + delta,
    );
    return asyncExternalWaitCounts[kind];
  }).pipe(
    Effect.flatMap((value) =>
      Metric.set(Metric.tagged(externalWaitAsyncPending, "kind", kind), value),
    ),
  );
}

type AgentEventPayload = Extract<SmithersEvent, { type: "AgentEvent" }>["event"];

type AgentUsageTotals = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
};

function normalizeMetricTag(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function tagMetricWithTags<A extends Metric.Metric<any, any, any>>(
  metric: A,
  tags: Record<string, string | undefined>,
): A {
  let tagged: any = metric;
  for (const [key, value] of Object.entries(tags)) {
    if (!value) continue;
    tagged = Metric.tagged(tagged, key, value);
  }
  return tagged as A;
}

function asFiniteMetricCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function resolveContextWindowTokens(
  event: Extract<SmithersEvent, { type: "TokenUsageReported" }>,
): number | undefined {
  const inputTokens = asFiniteMetricCount(event.inputTokens);
  if (inputTokens) {
    return inputTokens;
  }

  const cachedInputTokens =
    (asFiniteMetricCount(event.cacheReadTokens) ?? 0)
    + (asFiniteMetricCount(event.cacheWriteTokens) ?? 0);
  return cachedInputTokens > 0 ? cachedInputTokens : undefined;
}

function classifyContextWindowBucket(tokens: number): string {
  if (tokens < 50_000) return "lt_50k";
  if (tokens < 100_000) return "gte_50k_lt_100k";
  if (tokens < 200_000) return "gte_100k_lt_200k";
  if (tokens < 500_000) return "gte_200k_lt_500k";
  if (tokens < 1_000_000) return "gte_500k_lt_1m";
  return "gte_1m";
}

function extractAgentUsageTotals(usage: Record<string, unknown> | undefined): AgentUsageTotals {
  if (!usage) return {};
  const value = usage as any;
  const inputTokens =
    asFiniteMetricCount(value.inputTokens)
    ?? asFiniteMetricCount(value.input_tokens)
    ?? asFiniteMetricCount(value.prompt_tokens);
  const outputTokens =
    asFiniteMetricCount(value.outputTokens)
    ?? asFiniteMetricCount(value.output_tokens)
    ?? asFiniteMetricCount(value.completion_tokens);
  const cacheReadTokens =
    asFiniteMetricCount(value.cacheReadTokens)
    ?? asFiniteMetricCount(value.cache_read_input_tokens)
    ?? asFiniteMetricCount(value.cached_input_tokens)
    ?? asFiniteMetricCount(value.inputTokenDetails?.cacheReadTokens);
  const cacheWriteTokens =
    asFiniteMetricCount(value.cacheWriteTokens)
    ?? asFiniteMetricCount(value.cache_creation_input_tokens)
    ?? asFiniteMetricCount(value.inputTokenDetails?.cacheWriteTokens);
  const reasoningTokens =
    asFiniteMetricCount(value.reasoningTokens)
    ?? asFiniteMetricCount(value.reasoning_tokens)
    ?? asFiniteMetricCount(value.outputTokenDetails?.reasoningTokens);
  const totalTokens =
    asFiniteMetricCount(value.totalTokens)
    ?? asFiniteMetricCount(
      (inputTokens ?? 0)
      + (outputTokens ?? 0)
      + (cacheReadTokens ?? 0)
      + (cacheWriteTokens ?? 0)
      + (reasoningTokens ?? 0),
    );

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
  };
}

function recordAgentUsageMetrics(
  tags: Record<string, string | undefined>,
  usage: Record<string, unknown> | undefined,
): Effect.Effect<void> {
  const totals = extractAgentUsageTotals(usage);
  const effects: Effect.Effect<void>[] = [];

  const pushMetric = (kind: string, value: number | undefined) => {
    if (!value || value <= 0) return;
    effects.push(
      Metric.incrementBy(
        tagMetricWithTags(agentTokensTotal, {
          ...tags,
          kind,
        }),
        value,
      ),
    );
  };

  pushMetric("input", totals.inputTokens);
  pushMetric("output", totals.outputTokens);
  pushMetric("cache_read", totals.cacheReadTokens);
  pushMetric("cache_write", totals.cacheWriteTokens);
  pushMetric("reasoning", totals.reasoningTokens);
  pushMetric("total", totals.totalTokens);

  return effects.length > 0 ? Effect.all(effects, { discard: true }) : Effect.void;
}

function hasAgentRetrySignal(event: AgentEventPayload): boolean {
  const retryPattern = /\bretry(?:ing|able| after)?\b|\bbackoff\b|\brate limit\b/i;

  switch (event.type) {
    case "started":
      return false;

    case "action": {
      const detail = event.action.detail as Record<string, unknown> | undefined;
      if (detail) {
        const retryKeys = [
          "retryAfter",
          "retryAttempt",
          "retryDelayMs",
          "retryable",
          "backoffMs",
        ];
        if (retryKeys.some((key) => key in detail)) {
          return true;
        }
      }
      return retryPattern.test(`${event.action.title} ${event.message ?? ""}`);
    }

    case "completed":
      return retryPattern.test(event.error ?? "");
  }
}

// ---------------------------------------------------------------------------
// Event-driven metric tracking
// ---------------------------------------------------------------------------

export function trackEvent(event: SmithersEvent): Effect.Effect<void> {
  // Always count the event by type
  const countEvent = Metric.increment(eventsEmittedTotal);

  switch (event.type) {
    case "SupervisorStarted":
      return countEvent;

    case "SupervisorPollCompleted":
      return Effect.all([
        countEvent,
        Metric.increment(supervisorPollsTotal),
        Metric.incrementBy(supervisorStaleDetected, event.staleCount),
        Metric.update(supervisorPollDuration, event.durationMs),
      ], { discard: true });

    case "RunAutoResumed":
      return Effect.all([
        countEvent,
        Metric.increment(supervisorResumedTotal),
        Metric.update(supervisorResumeLag, event.staleDurationMs),
      ], { discard: true });

    case "RunAutoResumeSkipped":
      return Effect.all([
        countEvent,
        Metric.increment(Metric.tagged(supervisorSkippedTotal, "reason", event.reason)),
      ], { discard: true });

    case "RunStarted":
      return Effect.all([
        countEvent,
        Metric.increment(runsTotal),
        Metric.incrementBy(activeRuns, 1),
      ], { discard: true });

    case "SandboxCreated": {
      const byRuntime =
        event.runtime && event.runtime.length > 0
          ? Metric.tagged(sandboxCreatedTotal, "runtime", event.runtime)
          : sandboxCreatedTotal;
      return Effect.all([
        countEvent,
        Metric.increment(byRuntime),
        Metric.incrementBy(
          event.runtime ? Metric.tagged(sandboxActive, "runtime", event.runtime) : sandboxActive,
          1,
        ),
      ], { discard: true });
    }

    case "SandboxShipped":
      return Effect.all([
        countEvent,
        Metric.update(sandboxBundleSizeBytes, event.bundleSizeBytes),
      ], { discard: true });

    case "SandboxBundleReceived":
      return Effect.all([
        countEvent,
        Metric.update(sandboxBundleSizeBytes, event.bundleSizeBytes),
        Metric.update(sandboxPatchCount, event.patchCount),
      ], { discard: true });

    case "SandboxCompleted": {
      const byRuntime =
        event.runtime && event.runtime.length > 0
          ? Metric.tagged(
              Metric.tagged(sandboxCompletedTotal, "runtime", event.runtime),
              "status",
              event.status,
            )
          : sandboxCompletedTotal;
      return Effect.all([
        countEvent,
        Metric.increment(byRuntime),
        Metric.incrementBy(
          event.runtime ? Metric.tagged(sandboxActive, "runtime", event.runtime) : sandboxActive,
          -1,
        ),
        Metric.update(sandboxDurationMs, event.durationMs),
      ], { discard: true });
    }

    case "SandboxFailed":
      return Effect.all([
        countEvent,
        Metric.increment(errorsTotal),
      ], { discard: true });

    case "SandboxDiffReviewRequested":
      return Effect.all([
        countEvent,
        Metric.update(sandboxPatchCount, event.patchCount),
      ], { discard: true });

    case "SandboxDiffAccepted":
      return Effect.all([
        countEvent,
        Metric.update(sandboxPatchCount, event.patchCount),
      ], { discard: true });

    case "SandboxDiffRejected":
      return Effect.all([
        countEvent,
        Metric.increment(errorsTotal),
      ], { discard: true });

    case "RunFinished":
      return Effect.all([
        countEvent,
        Metric.incrementBy(activeRuns, -1),
        Metric.increment(runsFinishedTotal),
      ], { discard: true });

    case "RunFailed":
      return Effect.all([
        countEvent,
        Metric.incrementBy(activeRuns, -1),
        Metric.increment(runsFailedTotal),
        Metric.increment(errorsTotal),
      ], { discard: true });

    case "RunCancelled":
      return Effect.all([
        countEvent,
        Metric.incrementBy(activeRuns, -1),
        Metric.increment(runsCancelledTotal),
      ], { discard: true });

    case "RunContinuedAsNew":
      return Effect.all([
        countEvent,
        Metric.incrementBy(activeRuns, -1),
        Metric.increment(runsContinuedTotal),
        Metric.update(runsCarriedStateBytes, event.carriedStateSize),
        ...(typeof event.ancestryDepth === "number"
          ? [Metric.update(runsAncestryDepth, event.ancestryDepth)]
          : []),
      ], { discard: true });

    case "NodeStarted":
      return Effect.all([
        countEvent,
        Metric.increment(nodesStarted),
        Metric.incrementBy(activeNodes, 1),
      ], { discard: true });

    case "TaskHeartbeat":
      return Effect.all([
        countEvent,
        Metric.increment(taskHeartbeatsTotal),
        Metric.update(heartbeatDataSizeBytes, event.dataSizeBytes),
        ...(typeof event.intervalMs === "number"
          ? [Metric.update(heartbeatIntervalMs, event.intervalMs)]
          : []),
      ], { discard: true });

    case "TaskHeartbeatTimeout":
      return Effect.all([
        countEvent,
        Metric.increment(taskHeartbeatTimeoutTotal),
      ], { discard: true });

    case "NodeFinished":
      return Effect.all([
        countEvent,
        Metric.increment(nodesFinished),
        Metric.incrementBy(activeNodes, -1),
      ], { discard: true });

    case "NodeFailed":
      return Effect.all([
        countEvent,
        Metric.increment(nodesFailed),
        Metric.incrementBy(activeNodes, -1),
        Metric.increment(errorsTotal),
      ], { discard: true });

    case "NodeCancelled":
      return Effect.all([
        countEvent,
        Metric.incrementBy(activeNodes, -1),
      ], { discard: true });

    case "NodeRetrying":
      return Effect.all([
        countEvent,
        Metric.increment(nodeRetriesTotal),
      ], { discard: true });

    case "ToolCallStarted":
      return Effect.all([
        countEvent,
        Metric.increment(toolCallsTotal),
      ], { discard: true });

    case "ToolCallFinished":
      return event.status === "error"
        ? Effect.all([
            countEvent,
            Metric.increment(toolCallErrorsTotal),
          ], { discard: true })
        : countEvent;

    case "ApprovalRequested":
      return Effect.all([
        countEvent,
        Metric.increment(approvalsRequested),
        Metric.incrementBy(approvalPending, 1),
      ], { discard: true });

    case "ApprovalGranted":
      return Effect.all([
        countEvent,
        Metric.increment(approvalsGranted),
        Metric.incrementBy(approvalPending, -1),
      ], { discard: true });

    case "ApprovalAutoApproved":
      return Effect.all([
        countEvent,
        Metric.increment(approvalsGranted),
      ], { discard: true });

    case "ApprovalDenied":
      return Effect.all([
        countEvent,
        Metric.increment(approvalsDenied),
        Metric.incrementBy(approvalPending, -1),
      ], { discard: true });

    case "TimerCreated":
      return Effect.all([
        countEvent,
        Metric.increment(timersCreated),
        Metric.incrementBy(timersPending, 1),
      ], { discard: true });

    case "TimerFired":
      return Effect.all([
        countEvent,
        Metric.increment(timersFired),
        Metric.incrementBy(timersPending, -1),
        Metric.update(timerDelayDuration, event.delayMs),
      ], { discard: true });

    case "TimerCancelled":
      return Effect.all([
        countEvent,
        Metric.increment(timersCancelled),
        Metric.incrementBy(timersPending, -1),
      ], { discard: true });

    case "TokenUsageReported": {
      const effects: Effect.Effect<void>[] = [countEvent];

      const tags: Record<string, string> = {};
      if (event.model && event.model !== "unknown") tags.model = event.model;
      if (event.agent && event.agent !== "unknown") tags.agent = event.agent;

      const tagMetric = <A extends Metric.Metric<any, any, any>>(m: A): A => {
        let res: any = m;
        for (const [k, v] of Object.entries(tags)) {
          res = Metric.tagged(res, k, v);
        }
        return res as A;
      };

      if (event.inputTokens > 0) {
        effects.push(
          Metric.incrementBy(tagMetric(tokensInputTotal), event.inputTokens),
          Metric.update(tagMetric(tokensInputPerCall), event.inputTokens),
        );
      }
      if (event.outputTokens > 0) {
        effects.push(
          Metric.incrementBy(tagMetric(tokensOutputTotal), event.outputTokens),
          Metric.update(tagMetric(tokensOutputPerCall), event.outputTokens),
        );
      }
      if (event.cacheReadTokens && event.cacheReadTokens > 0) {
        effects.push(Metric.incrementBy(tagMetric(tokensCacheReadTotal), event.cacheReadTokens));
      }
      if (event.cacheWriteTokens && event.cacheWriteTokens > 0) {
        effects.push(Metric.incrementBy(tagMetric(tokensCacheWriteTotal), event.cacheWriteTokens));
      }
      if (event.reasoningTokens && event.reasoningTokens > 0) {
        effects.push(Metric.incrementBy(tagMetric(tokensReasoningTotal), event.reasoningTokens));
      }
      const contextWindowTokens = resolveContextWindowTokens(event);
      if (contextWindowTokens) {
        effects.push(
          Metric.update(tagMetric(tokensContextWindowPerCall), contextWindowTokens),
          Metric.increment(
            tagMetric(
              Metric.tagged(
                tokensContextWindowBucketTotal,
                "bucket",
                classifyContextWindowBucket(contextWindowTokens),
              ),
            ),
          ),
        );
      }
      return Effect.all(effects, { discard: true });
    }

    case "AgentEvent": {
      const agentEvent = event.event;
      const engine =
        normalizeMetricTag(agentEvent.engine)
        ?? normalizeMetricTag(event.engine)
        ?? "unknown";
      const baseTags = {
        engine,
        source: "event",
      };
      const effects: Effect.Effect<void>[] = [
        countEvent,
        Metric.increment(tagMetricWithTags(agentEventsTotal, {
          ...baseTags,
          event_type: agentEvent.type,
        })),
      ];

      switch (agentEvent.type) {
        case "started":
          effects.push(
            Metric.increment(tagMetricWithTags(agentSessionsTotal, {
              ...baseTags,
              status: "started",
              resume: agentEvent.resume ? "true" : "false",
            })),
          );
          break;

        case "action":
          effects.push(
            Metric.increment(tagMetricWithTags(agentActionsTotal, {
              ...baseTags,
              action_kind: agentEvent.action.kind,
              phase: agentEvent.phase,
              level: agentEvent.level,
              entry_type: agentEvent.entryType,
              ok: typeof agentEvent.ok === "boolean" ? String(agentEvent.ok) : undefined,
            })),
          );
          if (agentEvent.level === "error" || agentEvent.ok === false) {
            effects.push(
              Metric.increment(tagMetricWithTags(agentErrorsTotal, {
                ...baseTags,
                event_type: agentEvent.type,
                action_kind: agentEvent.action.kind,
              })),
            );
          }
          if (hasAgentRetrySignal(agentEvent)) {
            effects.push(
              Metric.increment(tagMetricWithTags(agentRetriesTotal, {
                ...baseTags,
                reason: "event_signal",
              })),
            );
          }
          break;

        case "completed":
          effects.push(
            Metric.increment(tagMetricWithTags(agentSessionsTotal, {
              ...baseTags,
              status: agentEvent.ok ? "completed" : "failed",
              resume: agentEvent.resume ? "true" : "false",
            })),
          );
          effects.push(
            recordAgentUsageMetrics(baseTags, agentEvent.usage),
          );
          if (!agentEvent.ok) {
            effects.push(
              Metric.increment(tagMetricWithTags(agentErrorsTotal, {
                ...baseTags,
                event_type: agentEvent.type,
              })),
            );
          }
          if (hasAgentRetrySignal(agentEvent)) {
            effects.push(
              Metric.increment(tagMetricWithTags(agentRetriesTotal, {
                ...baseTags,
                reason: "event_signal",
              })),
            );
          }
          break;
      }

      return Effect.all(effects, { discard: true });
    }

    case "ScorerStarted":
      return Effect.all([
        countEvent,
        Metric.increment(scorerEventsStarted),
      ], { discard: true });

    case "ScorerFinished":
      return Effect.all([
        countEvent,
        Metric.increment(scorerEventsFinished),
      ], { discard: true });

    case "ScorerFailed":
      return Effect.all([
        countEvent,
        Metric.increment(scorerEventsFailed),
        Metric.increment(errorsTotal),
      ], { discard: true });

    case "SnapshotCaptured":
      return countEvent;

    case "RunForked":
      return countEvent;

    case "ReplayStarted":
      return countEvent;

    case "VoiceStarted":
      return Effect.all([
        countEvent,
        Metric.increment(voiceOperationsTotal),
      ], { discard: true });

    case "VoiceFinished":
      return Effect.all([
        countEvent,
        Metric.update(voiceDuration, event.durationMs),
      ], { discard: true });

    case "VoiceError":
      return Effect.all([
        countEvent,
        Metric.increment(voiceErrorsTotal),
        Metric.increment(errorsTotal),
      ], { discard: true });

    case "RagIngested":
      return Effect.all([
        countEvent,
        Metric.incrementBy(ragIngestCount, event.documentCount),
      ], { discard: true });

    case "RagRetrieved":
      return Effect.all([
        countEvent,
        Metric.increment(ragRetrieveCount),
      ], { discard: true });

    case "MemoryFactSet":
      return Effect.all([
        countEvent,
        Metric.increment(memoryFactWrites),
      ], { discard: true });

    case "MemoryRecalled":
      return Effect.all([
        countEvent,
        Metric.increment(memoryRecallQueries),
      ], { discard: true });

    case "MemoryMessageSaved":
      return Effect.all([
        countEvent,
        Metric.increment(memoryMessageSaves),
      ], { discard: true });

    case "OpenApiToolCalled":
      return event.status === "error"
        ? Effect.all([
            countEvent,
            Metric.increment(openApiToolCallsTotal),
            Metric.increment(openApiToolCallErrorsTotal),
            Metric.update(openApiToolDuration, event.durationMs),
          ], { discard: true })
        : Effect.all([
            countEvent,
            Metric.increment(openApiToolCallsTotal),
            Metric.update(openApiToolDuration, event.durationMs),
          ], { discard: true });

    default:
      return countEvent;
  }
}
