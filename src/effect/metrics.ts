import { Effect, Metric, MetricBoundaries } from "effect";
import type { SmithersEvent } from "../SmithersEvent";

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

export const runsTotal = Metric.counter("smithers.runs.total");
export const nodesStarted = Metric.counter("smithers.nodes.started");
export const nodesFinished = Metric.counter("smithers.nodes.finished");
export const nodesFailed = Metric.counter("smithers.nodes.failed");
export const toolCallsTotal = Metric.counter("smithers.tool_calls.total");
export const cacheHits = Metric.counter("smithers.cache.hits");
export const cacheMisses = Metric.counter("smithers.cache.misses");
export const dbRetries = Metric.counter("smithers.db.retries");
export const hotReloads = Metric.counter("smithers.hot.reloads");
export const hotReloadFailures = Metric.counter("smithers.hot.reload_failures");
export const httpRequests = Metric.counter("smithers.http.requests");
export const approvalsRequested = Metric.counter("smithers.approvals.requested");
export const approvalsGranted = Metric.counter("smithers.approvals.granted");
export const approvalsDenied = Metric.counter("smithers.approvals.denied");

// ---------------------------------------------------------------------------
// Gauges
// ---------------------------------------------------------------------------

export const activeRuns = Metric.gauge("smithers.runs.active");
export const activeNodes = Metric.gauge("smithers.nodes.active");
export const schedulerQueueDepth = Metric.gauge("smithers.scheduler.queue_depth");

// ---------------------------------------------------------------------------
// Histograms
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

// ---------------------------------------------------------------------------
// Event-driven metric tracking
// ---------------------------------------------------------------------------

export function trackEvent(event: SmithersEvent): Effect.Effect<void> {
  switch (event.type) {
    case "RunStarted":
      return Effect.all([
        Metric.increment(runsTotal),
        Metric.update(activeRuns, 1),
      ], { discard: true });

    case "RunFinished":
      return Metric.update(activeRuns, -1);

    case "RunFailed":
      return Metric.update(activeRuns, -1);

    case "RunCancelled":
      return Metric.update(activeRuns, -1);

    case "NodeStarted":
      return Effect.all([
        Metric.increment(nodesStarted),
        Metric.update(activeNodes, 1),
      ], { discard: true });

    case "NodeFinished":
      return Effect.all([
        Metric.increment(nodesFinished),
        Metric.update(activeNodes, -1),
      ], { discard: true });

    case "NodeFailed":
      return Effect.all([
        Metric.increment(nodesFailed),
        Metric.update(activeNodes, -1),
      ], { discard: true });

    case "NodeCancelled":
      return Metric.update(activeNodes, -1);

    case "ToolCallStarted":
      return Metric.increment(toolCallsTotal);

    case "ApprovalRequested":
      return Metric.increment(approvalsRequested);

    case "ApprovalGranted":
      return Metric.increment(approvalsGranted);

    case "ApprovalDenied":
      return Metric.increment(approvalsDenied);

    default:
      return Effect.void;
  }
}
