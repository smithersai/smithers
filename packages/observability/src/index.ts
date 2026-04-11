export {
  MetricsService,
  TracingService,
  TracingServiceLive,
} from "@smithers/core/observability";
export type {
  MetricLabels,
  MetricsServiceShape,
  MetricsSnapshot,
} from "@smithers/core/observability";

export type { SmithersLogFormat } from "./SmithersLogFormat";
export type { SmithersObservabilityOptions } from "./SmithersObservabilityOptions";
export type { ResolvedSmithersObservabilityOptions } from "./ResolvedSmithersObservabilityOptions";
export type { SmithersObservabilityService } from "./SmithersObservabilityService";
export { SmithersObservability } from "./SmithersObservability";
export { prometheusContentType } from "./prometheusContentType";
export { smithersSpanNames } from "./smithersSpanNames";
export { getCurrentSmithersTraceSpan } from "./getCurrentSmithersTraceSpan";
export { getCurrentSmithersTraceAnnotations } from "./getCurrentSmithersTraceAnnotations";
export { makeSmithersSpanAttributes } from "./makeSmithersSpanAttributes";
export { annotateSmithersTrace } from "./annotateSmithersTrace";
export { withSmithersSpan } from "./withSmithersSpan";
export { renderPrometheusMetrics } from "./renderPrometheusMetrics";
export { resolveSmithersObservabilityOptions } from "./resolveSmithersObservabilityOptions";
export { smithersMetrics } from "./smithersMetrics";
export { MetricsServiceLive } from "./MetricsServiceLive";
export { createSmithersOtelLayer } from "./createSmithersOtelLayer";
export { createSmithersObservabilityLayer } from "./createSmithersObservabilityLayer";
export { createSmithersRuntimeLayer } from "./createSmithersRuntimeLayer";

export {
  activeNodes,
  activeRuns,
  approvalPending,
  externalWaitAsyncPending,
  approvalsDenied,
  approvalsGranted,
  approvalsRequested,
  approvalWaitDuration,
  timerDelayDuration,
  timersCancelled,
  timersCreated,
  timersFired,
  timersPending,
  attemptDuration,
  cacheHits,
  cacheMisses,
  dbQueryDuration,
  dbRetries,
  dbTransactionDuration,
  dbTransactionRetries,
  dbTransactionRollbacks,
  errorsTotal,
  eventsEmittedTotal,
  hotReloadDuration,
  hotReloadFailures,
  hotReloads,
  httpRequestDuration,
  httpRequests,
  nodeDuration,
  nodeRetriesTotal,
  nodesFailed,
  nodesFinished,
  nodesStarted,
  processHeapUsedBytes,
  processMemoryRssBytes,
  processUptimeSeconds,
  promptSizeBytes,
  responseSizeBytes,
  runDuration,
  runsCancelledTotal,
  runsContinuedTotal,
  runsFailedTotal,
  runsFinishedTotal,
  runsResumedTotal,
  runsAncestryDepth,
  runsCarriedStateBytes,
  sandboxActive,
  sandboxBundleSizeBytes,
  sandboxCompletedTotal,
  sandboxCreatedTotal,
  sandboxDurationMs,
  sandboxPatchCount,
  sandboxTransportDurationMs,
  runsTotal,
  schedulerConcurrencyUtilization,
  schedulerQueueDepth,
  schedulerWaitDuration,
  tokensCacheReadTotal,
  tokensCacheWriteTotal,
  tokensContextWindowBucketTotal,
  tokensContextWindowPerCall,
  tokensInputPerCall,
  tokensInputTotal,
  tokensOutputPerCall,
  tokensOutputTotal,
  tokensReasoningTotal,
  toolCallErrorsTotal,
  toolCallsTotal,
  toolDuration,
  toolOutputTruncatedTotal,
  scorerEventsStarted,
  scorerEventsFinished,
  scorerEventsFailed,
  trackEvent as trackSmithersEvent,
  updateProcessMetrics,
  vcsDuration,
  type SmithersMetricDefinition,
  toPrometheusMetricName,
  smithersMetricCatalog,
  metricsServiceAdapter,
} from "./metrics";

export {
  correlationContextFiberRef,
  correlationContextToLogAnnotations,
  CorrelationContextLive,
  CorrelationContextService,
  getCurrentCorrelationContext,
  getCurrentCorrelationContextEffect,
  mergeCorrelationContext,
  runWithCorrelationContext,
  withCorrelationContext,
  withCurrentCorrelationContext,
} from "./correlation";
export type {
  CorrelationContext,
  CorrelationPatch,
  CorrelationContextPatch,
} from "./correlation";
export { updateCurrentCorrelationContext } from "./correlation";

export {
  logDebug,
  logInfo,
  logWarning,
  logError,
} from "./logging";
