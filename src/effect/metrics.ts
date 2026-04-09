import { Effect, Metric, MetricBoundaries } from "effect";
import type { SmithersEvent } from "../SmithersEvent";
import {
  ragEmbedDuration,
  ragIngestCount,
  ragRetrieveCount,
  ragRetrieveDuration,
} from "../rag/metrics";
import {
  memoryFactReads,
  memoryFactWrites,
  memoryRecallDuration,
  memoryRecallQueries,
  memoryMessageSaves,
} from "../memory/metrics";
import {
  openApiToolCallsTotal,
  openApiToolCallErrorsTotal,
  openApiToolDuration,
} from "../openapi/metrics";
import {
  scorerDuration,
  scorersFailed,
  scorersFinished,
  scorersStarted,
} from "../scorers/metrics";
import {
  replaysStarted,
  runForksCreated,
  snapshotDuration,
  snapshotsCaptured,
} from "../time-travel/metrics";

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
