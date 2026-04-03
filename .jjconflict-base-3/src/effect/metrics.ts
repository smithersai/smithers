import { Effect, Metric, MetricBoundaries } from "effect";
import type { SmithersEvent } from "../SmithersEvent";
import { ragIngestCount, ragRetrieveCount } from "../rag/metrics";
import {
  memoryFactWrites,
  memoryRecallQueries,
  memoryMessageSaves,
} from "../memory/metrics";
import {
  openApiToolCallsTotal,
  openApiToolCallErrorsTotal,
  openApiToolDuration,
} from "../openapi/metrics";

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
export const hotReloads = Metric.counter("smithers.hot.reloads");
export const hotReloadFailures = Metric.counter("smithers.hot.reload_failures");
export const httpRequests = Metric.counter("smithers.http.requests");
export const approvalsRequested = Metric.counter("smithers.approvals.requested");
export const approvalsGranted = Metric.counter("smithers.approvals.granted");
export const approvalsDenied = Metric.counter("smithers.approvals.denied");

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

// ---------------------------------------------------------------------------
// Counters — run lifecycle
// ---------------------------------------------------------------------------

export const runsFinishedTotal = Metric.counter("smithers.runs.finished_total");
export const runsFailedTotal = Metric.counter("smithers.runs.failed_total");
export const runsCancelledTotal = Metric.counter("smithers.runs.cancelled_total");
export const runsResumedTotal = Metric.counter("smithers.runs.resumed_total");

// ---------------------------------------------------------------------------
// Counters — errors & retries
// ---------------------------------------------------------------------------

export const errorsTotal = Metric.counter("smithers.errors.total");
export const nodeRetriesTotal = Metric.counter("smithers.node.retries_total");
export const toolCallErrorsTotal = Metric.counter("smithers.tool_calls.errors_total");
export const toolOutputTruncatedTotal = Metric.counter("smithers.tool.output_truncated_total");

// ---------------------------------------------------------------------------
// Counters — voice
// ---------------------------------------------------------------------------

export const voiceOperationsTotal = Metric.counter("smithers.voice.operations_total");
export const voiceErrorsTotal = Metric.counter("smithers.voice.errors_total");

// ---------------------------------------------------------------------------
// Counters — events
// ---------------------------------------------------------------------------

export const eventsEmittedTotal = Metric.counter("smithers.events.emitted_total");

// ---------------------------------------------------------------------------
// Gauges — existing
// ---------------------------------------------------------------------------

export const activeRuns = Metric.gauge("smithers.runs.active");
export const activeNodes = Metric.gauge("smithers.nodes.active");
export const schedulerQueueDepth = Metric.gauge("smithers.scheduler.queue_depth");

// ---------------------------------------------------------------------------
// Gauges — MCP
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Gauges — new
// ---------------------------------------------------------------------------

export const approvalPending = Metric.gauge("smithers.approval.pending");
export const schedulerConcurrencyUtilization = Metric.gauge("smithers.scheduler.concurrency_utilization");
export const processUptimeSeconds = Metric.gauge("smithers.process.uptime_seconds");
export const processMemoryRssBytes = Metric.gauge("smithers.process.memory_rss_bytes");
export const processHeapUsedBytes = Metric.gauge("smithers.process.heap_used_bytes");

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

const sizeBuckets = MetricBoundaries.exponential({
  start: 100,
  factor: 2,
  count: 16,
}); // ~100 bytes to ~3.2MB

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

export const voiceDuration = Metric.histogram(
  "smithers.voice.duration_ms",
  durationBuckets,
);


// TODO: instrument once TaskDescriptor carries `pendingSinceMs` from the node
// row's `updatedAtMs` — currently the timestamp is not available at dispatch
// time without an extra DB read per task.
export const schedulerWaitDuration = Metric.histogram(
  "smithers.scheduler.wait_duration_ms",
  durationBuckets,
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

// ---------------------------------------------------------------------------
// Event-driven metric tracking
// ---------------------------------------------------------------------------

export function trackEvent(event: SmithersEvent): Effect.Effect<void> {
  // Always count the event by type
  const countEvent = Metric.increment(eventsEmittedTotal);

  switch (event.type) {
    case "RunStarted":
      return Effect.all([
        countEvent,
        Metric.increment(runsTotal),
        Metric.update(activeRuns, 1),
      ], { discard: true });

    case "RunFinished":
      return Effect.all([
        countEvent,
        Metric.update(activeRuns, -1),
        Metric.increment(runsFinishedTotal),
      ], { discard: true });

    case "RunFailed":
      return Effect.all([
        countEvent,
        Metric.update(activeRuns, -1),
        Metric.increment(runsFailedTotal),
        Metric.increment(errorsTotal),
      ], { discard: true });

    case "RunCancelled":
      return Effect.all([
        countEvent,
        Metric.update(activeRuns, -1),
        Metric.increment(runsCancelledTotal),
      ], { discard: true });

    case "NodeStarted":
      return Effect.all([
        countEvent,
        Metric.increment(nodesStarted),
        Metric.update(activeNodes, 1),
      ], { discard: true });

    case "NodeFinished":
      return Effect.all([
        countEvent,
        Metric.increment(nodesFinished),
        Metric.update(activeNodes, -1),
      ], { discard: true });

    case "NodeFailed":
      return Effect.all([
        countEvent,
        Metric.increment(nodesFailed),
        Metric.update(activeNodes, -1),
        Metric.increment(errorsTotal),
      ], { discard: true });

    case "NodeCancelled":
      return Effect.all([
        countEvent,
        Metric.update(activeNodes, -1),
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
        Metric.update(approvalPending, 1),
      ], { discard: true });

    case "ApprovalGranted":
      return Effect.all([
        countEvent,
        Metric.increment(approvalsGranted),
        Metric.update(approvalPending, -1),
      ], { discard: true });

    case "ApprovalDenied":
      return Effect.all([
        countEvent,
        Metric.increment(approvalsDenied),
        Metric.update(approvalPending, -1),
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
