// Types
export type { SmithersMetricType } from "./SmithersMetricType";
export type { SmithersMetricUnit } from "./SmithersMetricUnit";
export type { SmithersMetricDefinition } from "./SmithersMetricDefinition";

// Functions
export { toPrometheusMetricName } from "./toPrometheusMetricName";
export { updateProcessMetrics } from "./updateProcessMetrics";
export { updateAsyncExternalWaitPending } from "./updateAsyncExternalWaitPending";
export { trackEvent } from "./trackEvent";

// Catalog
export { smithersMetricCatalog } from "./smithersMetricCatalog";
export { smithersMetricCatalogByKey } from "./smithersMetricCatalogByKey";
export { smithersMetricCatalogByName } from "./smithersMetricCatalogByName";
export { smithersMetricCatalogByPrometheusName } from "./smithersMetricCatalogByPrometheusName";

// Service adapter
export { metricsServiceAdapter } from "./metricsServiceAdapter";

// Counters
export { runsTotal } from "./runsTotal";
export { nodesStarted } from "./nodesStarted";
export { nodesFinished } from "./nodesFinished";
export { nodesFailed } from "./nodesFailed";
export { toolCallsTotal } from "./toolCallsTotal";
export { cacheHits } from "./cacheHits";
export { cacheMisses } from "./cacheMisses";
export { dbRetries } from "./dbRetries";
export { dbTransactionRollbacks } from "./dbTransactionRollbacks";
export { dbTransactionRetries } from "./dbTransactionRetries";
export { hotReloads } from "./hotReloads";
export { hotReloadFailures } from "./hotReloadFailures";
export { httpRequests } from "./httpRequests";
export { approvalsRequested } from "./approvalsRequested";
export { approvalsGranted } from "./approvalsGranted";
export { approvalsDenied } from "./approvalsDenied";
export { timersCreated } from "./timersCreated";
export { timersFired } from "./timersFired";
export { timersCancelled } from "./timersCancelled";
export { sandboxCreatedTotal } from "./sandboxCreatedTotal";
export { sandboxCompletedTotal } from "./sandboxCompletedTotal";
export { alertsFiredTotal } from "./alertsFiredTotal";
export { alertsAcknowledgedTotal } from "./alertsAcknowledgedTotal";
export { alertsResolvedTotal } from "./alertsResolvedTotal";
export { alertsSilencedTotal } from "./alertsSilencedTotal";
export { alertsReopenedTotal } from "./alertsReopenedTotal";
export { alertsEscalatedTotal } from "./alertsEscalatedTotal";
export { alertDeliveriesAttempted } from "./alertDeliveriesAttempted";
export { alertDeliveriesSuppressed } from "./alertDeliveriesSuppressed";
export { scorerEventsStarted } from "./scorerEventsStarted";
export { scorerEventsFinished } from "./scorerEventsFinished";
export { scorerEventsFailed } from "./scorerEventsFailed";
export { tokensInputTotal } from "./tokensInputTotal";
export { tokensOutputTotal } from "./tokensOutputTotal";
export { tokensCacheReadTotal } from "./tokensCacheReadTotal";
export { tokensCacheWriteTotal } from "./tokensCacheWriteTotal";
export { tokensReasoningTotal } from "./tokensReasoningTotal";
export { tokensContextWindowBucketTotal } from "./tokensContextWindowBucketTotal";
export { runsFinishedTotal } from "./runsFinishedTotal";
export { runsFailedTotal } from "./runsFailedTotal";
export { runsCancelledTotal } from "./runsCancelledTotal";
export { runsResumedTotal } from "./runsResumedTotal";
export { runsContinuedTotal } from "./runsContinuedTotal";
export { supervisorPollsTotal } from "./supervisorPollsTotal";
export { supervisorStaleDetected } from "./supervisorStaleDetected";
export { supervisorResumedTotal } from "./supervisorResumedTotal";
export { supervisorSkippedTotal } from "./supervisorSkippedTotal";
export { errorsTotal } from "./errorsTotal";
export { nodeRetriesTotal } from "./nodeRetriesTotal";
export { toolCallErrorsTotal } from "./toolCallErrorsTotal";
export { toolOutputTruncatedTotal } from "./toolOutputTruncatedTotal";
export { agentInvocationsTotal } from "./agentInvocationsTotal";
export { agentTokensTotal } from "./agentTokensTotal";
export { agentErrorsTotal } from "./agentErrorsTotal";
export { agentRetriesTotal } from "./agentRetriesTotal";
export { agentEventsTotal } from "./agentEventsTotal";
export { agentSessionsTotal } from "./agentSessionsTotal";
export { agentActionsTotal } from "./agentActionsTotal";

export { gatewayConnectionsTotal } from "./gatewayConnectionsTotal";
export { gatewayConnectionsClosedTotal } from "./gatewayConnectionsClosedTotal";
export { gatewayMessagesReceivedTotal } from "./gatewayMessagesReceivedTotal";
export { gatewayMessagesSentTotal } from "./gatewayMessagesSentTotal";
export { gatewayRpcCallsTotal } from "./gatewayRpcCallsTotal";
export { gatewayErrorsTotal } from "./gatewayErrorsTotal";
export { gatewayRunsStartedTotal } from "./gatewayRunsStartedTotal";
export { gatewayRunsCompletedTotal } from "./gatewayRunsCompletedTotal";
export { gatewayApprovalDecisionsTotal } from "./gatewayApprovalDecisionsTotal";
export { gatewaySignalsTotal } from "./gatewaySignalsTotal";
export { gatewayAuthEventsTotal } from "./gatewayAuthEventsTotal";
export { gatewayHeartbeatTicksTotal } from "./gatewayHeartbeatTicksTotal";
export { gatewayCronTriggersTotal } from "./gatewayCronTriggersTotal";
export { gatewayWebhooksReceivedTotal } from "./gatewayWebhooksReceivedTotal";
export { gatewayWebhooksVerifiedTotal } from "./gatewayWebhooksVerifiedTotal";
export { gatewayWebhooksRejectedTotal } from "./gatewayWebhooksRejectedTotal";
export { eventsEmittedTotal } from "./eventsEmittedTotal";
export { taskHeartbeatsTotal } from "./taskHeartbeatsTotal";
export { taskHeartbeatTimeoutTotal } from "./taskHeartbeatTimeoutTotal";

// Gauges
export { activeRuns } from "./activeRuns";
export { activeNodes } from "./activeNodes";
export { schedulerQueueDepth } from "./schedulerQueueDepth";
export { sandboxActive } from "./sandboxActive";
export { alertsActive } from "./alertsActive";
export { attentionBacklog } from "./attentionBacklog";
export { gatewayConnectionsActive } from "./gatewayConnectionsActive";
export { approvalPending } from "./approvalPending";
export { externalWaitAsyncPending } from "./externalWaitAsyncPending";
export { timersPending } from "./timersPending";
export { schedulerConcurrencyUtilization } from "./schedulerConcurrencyUtilization";
export { processUptimeSeconds } from "./processUptimeSeconds";
export { processMemoryRssBytes } from "./processMemoryRssBytes";
export { processHeapUsedBytes } from "./processHeapUsedBytes";

// Histograms
export { nodeDuration } from "./nodeDuration";
export { attemptDuration } from "./attemptDuration";
export { toolDuration } from "./toolDuration";
export { dbQueryDuration } from "./dbQueryDuration";
export { dbTransactionDuration } from "./dbTransactionDuration";
export { httpRequestDuration } from "./httpRequestDuration";
export { hotReloadDuration } from "./hotReloadDuration";
export { vcsDuration } from "./vcsDuration";
export { agentDurationMs } from "./agentDurationMs";
export { tokensInputPerCall } from "./tokensInputPerCall";
export { tokensOutputPerCall } from "./tokensOutputPerCall";
export { tokensContextWindowPerCall } from "./tokensContextWindowPerCall";
export { runDuration } from "./runDuration";
export { promptSizeBytes } from "./promptSizeBytes";
export { responseSizeBytes } from "./responseSizeBytes";
export { approvalWaitDuration } from "./approvalWaitDuration";
export { timerDelayDuration } from "./timerDelayDuration";

export { gatewayRpcDuration } from "./gatewayRpcDuration";
export { schedulerWaitDuration } from "./schedulerWaitDuration";
export { supervisorPollDuration } from "./supervisorPollDuration";
export { supervisorResumeLag } from "./supervisorResumeLag";
export { runsAncestryDepth } from "./runsAncestryDepth";
export { runsCarriedStateBytes } from "./runsCarriedStateBytes";
export { sandboxDurationMs } from "./sandboxDurationMs";
export { sandboxBundleSizeBytes } from "./sandboxBundleSizeBytes";
export { sandboxTransportDurationMs } from "./sandboxTransportDurationMs";
export { sandboxPatchCount } from "./sandboxPatchCount";
export { heartbeatDataSizeBytes } from "./heartbeatDataSizeBytes";
export { heartbeatIntervalMs } from "./heartbeatIntervalMs";
