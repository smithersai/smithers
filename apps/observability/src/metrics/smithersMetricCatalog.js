import { toPrometheusMetricName } from "./toPrometheusMetricName.js";
import { durationBuckets, fastBuckets, toolBuckets, tokenBuckets, contextWindowBuckets, sizeBuckets, carriedStateSizeBuckets, ancestryDepthBuckets, } from "./_buckets.js";
// External package metrics
import { memoryFactReads, memoryFactWrites, memoryRecallDuration, memoryRecallQueries, memoryMessageSaves, } from "@smithers-orchestrator/memory/metrics";
import { openApiToolCallsTotal, openApiToolCallErrorsTotal, openApiToolDuration, } from "@smithers-orchestrator/openapi/metrics";
import { scorerDuration, scorersFailed, scorersFinished, scorersStarted, } from "@smithers-orchestrator/scorers/metrics";
import { replaysStarted, runForksCreated, snapshotDuration, snapshotsCaptured, } from "@smithers-orchestrator/time-travel/metrics";
// Local metric instances
import { runsTotal } from "./runsTotal.js";
import { nodesStarted } from "./nodesStarted.js";
import { nodesFinished } from "./nodesFinished.js";
import { nodesFailed } from "./nodesFailed.js";
import { toolCallsTotal } from "./toolCallsTotal.js";
import { cacheHits } from "./cacheHits.js";
import { cacheMisses } from "./cacheMisses.js";
import { dbRetries } from "./dbRetries.js";
import { dbTransactionRollbacks } from "./dbTransactionRollbacks.js";
import { dbTransactionRetries } from "./dbTransactionRetries.js";
import { hotReloads } from "./hotReloads.js";
import { hotReloadFailures } from "./hotReloadFailures.js";
import { httpRequests } from "./httpRequests.js";
import { approvalsRequested } from "./approvalsRequested.js";
import { approvalsGranted } from "./approvalsGranted.js";
import { approvalsDenied } from "./approvalsDenied.js";
import { timersCreated } from "./timersCreated.js";
import { timersFired } from "./timersFired.js";
import { timersCancelled } from "./timersCancelled.js";
import { sandboxCreatedTotal } from "./sandboxCreatedTotal.js";
import { sandboxCompletedTotal } from "./sandboxCompletedTotal.js";
import { alertsFiredTotal } from "./alertsFiredTotal.js";
import { alertsAcknowledgedTotal } from "./alertsAcknowledgedTotal.js";
import { scorerEventsStarted } from "./scorerEventsStarted.js";
import { scorerEventsFinished } from "./scorerEventsFinished.js";
import { scorerEventsFailed } from "./scorerEventsFailed.js";
import { tokensInputTotal } from "./tokensInputTotal.js";
import { tokensOutputTotal } from "./tokensOutputTotal.js";
import { tokensCacheReadTotal } from "./tokensCacheReadTotal.js";
import { tokensCacheWriteTotal } from "./tokensCacheWriteTotal.js";
import { tokensReasoningTotal } from "./tokensReasoningTotal.js";
import { tokensContextWindowBucketTotal } from "./tokensContextWindowBucketTotal.js";
import { runsFinishedTotal } from "./runsFinishedTotal.js";
import { runsFailedTotal } from "./runsFailedTotal.js";
import { runsCancelledTotal } from "./runsCancelledTotal.js";
import { runsResumedTotal } from "./runsResumedTotal.js";
import { runsContinuedTotal } from "./runsContinuedTotal.js";
import { supervisorPollsTotal } from "./supervisorPollsTotal.js";
import { supervisorStaleDetected } from "./supervisorStaleDetected.js";
import { supervisorResumedTotal } from "./supervisorResumedTotal.js";
import { supervisorSkippedTotal } from "./supervisorSkippedTotal.js";
import { errorsTotal } from "./errorsTotal.js";
import { nodeRetriesTotal } from "./nodeRetriesTotal.js";
import { toolCallErrorsTotal } from "./toolCallErrorsTotal.js";
import { toolOutputTruncatedTotal } from "./toolOutputTruncatedTotal.js";
import { agentInvocationsTotal } from "./agentInvocationsTotal.js";
import { agentTokensTotal } from "./agentTokensTotal.js";
import { agentErrorsTotal } from "./agentErrorsTotal.js";
import { agentRetriesTotal } from "./agentRetriesTotal.js";
import { agentEventsTotal } from "./agentEventsTotal.js";
import { agentSessionsTotal } from "./agentSessionsTotal.js";
import { agentActionsTotal } from "./agentActionsTotal.js";
import { gatewayConnectionsTotal } from "./gatewayConnectionsTotal.js";
import { gatewayConnectionsClosedTotal } from "./gatewayConnectionsClosedTotal.js";
import { gatewayMessagesReceivedTotal } from "./gatewayMessagesReceivedTotal.js";
import { gatewayMessagesSentTotal } from "./gatewayMessagesSentTotal.js";
import { gatewayRpcCallsTotal } from "./gatewayRpcCallsTotal.js";
import { gatewayErrorsTotal } from "./gatewayErrorsTotal.js";
import { gatewayRunsStartedTotal } from "./gatewayRunsStartedTotal.js";
import { gatewayRunsCompletedTotal } from "./gatewayRunsCompletedTotal.js";
import { gatewayApprovalDecisionsTotal } from "./gatewayApprovalDecisionsTotal.js";
import { gatewaySignalsTotal } from "./gatewaySignalsTotal.js";
import { gatewayAuthEventsTotal } from "./gatewayAuthEventsTotal.js";
import { gatewayHeartbeatTicksTotal } from "./gatewayHeartbeatTicksTotal.js";
import { gatewayCronTriggersTotal } from "./gatewayCronTriggersTotal.js";
import { gatewayWebhooksReceivedTotal } from "./gatewayWebhooksReceivedTotal.js";
import { gatewayWebhooksVerifiedTotal } from "./gatewayWebhooksVerifiedTotal.js";
import { gatewayWebhooksRejectedTotal } from "./gatewayWebhooksRejectedTotal.js";
import { eventsEmittedTotal } from "./eventsEmittedTotal.js";
import { taskHeartbeatsTotal } from "./taskHeartbeatsTotal.js";
import { taskHeartbeatTimeoutTotal } from "./taskHeartbeatTimeoutTotal.js";
import { activeRuns } from "./activeRuns.js";
import { activeNodes } from "./activeNodes.js";
import { schedulerQueueDepth } from "./schedulerQueueDepth.js";
import { sandboxActive } from "./sandboxActive.js";
import { alertsActive } from "./alertsActive.js";
import { gatewayConnectionsActive } from "./gatewayConnectionsActive.js";
import { approvalPending } from "./approvalPending.js";
import { externalWaitAsyncPending } from "./externalWaitAsyncPending.js";
import { timersPending } from "./timersPending.js";
import { schedulerConcurrencyUtilization } from "./schedulerConcurrencyUtilization.js";
import { processUptimeSeconds } from "./processUptimeSeconds.js";
import { processMemoryRssBytes } from "./processMemoryRssBytes.js";
import { processHeapUsedBytes } from "./processHeapUsedBytes.js";
import { nodeDuration } from "./nodeDuration.js";
import { attemptDuration } from "./attemptDuration.js";
import { toolDuration } from "./toolDuration.js";
import { dbQueryDuration } from "./dbQueryDuration.js";
import { dbTransactionDuration } from "./dbTransactionDuration.js";
import { httpRequestDuration } from "./httpRequestDuration.js";
import { hotReloadDuration } from "./hotReloadDuration.js";
import { vcsDuration } from "./vcsDuration.js";
import { agentDurationMs } from "./agentDurationMs.js";
import { tokensInputPerCall } from "./tokensInputPerCall.js";
import { tokensOutputPerCall } from "./tokensOutputPerCall.js";
import { tokensContextWindowPerCall } from "./tokensContextWindowPerCall.js";
import { runDuration } from "./runDuration.js";
import { promptSizeBytes } from "./promptSizeBytes.js";
import { responseSizeBytes } from "./responseSizeBytes.js";
import { approvalWaitDuration } from "./approvalWaitDuration.js";
import { timerDelayDuration } from "./timerDelayDuration.js";
import { gatewayRpcDuration } from "./gatewayRpcDuration.js";
import { schedulerWaitDuration } from "./schedulerWaitDuration.js";
import { supervisorPollDuration } from "./supervisorPollDuration.js";
import { supervisorResumeLag } from "./supervisorResumeLag.js";
import { runsAncestryDepth } from "./runsAncestryDepth.js";
import { runsCarriedStateBytes } from "./runsCarriedStateBytes.js";
import { sandboxDurationMs } from "./sandboxDurationMs.js";
import { sandboxBundleSizeBytes } from "./sandboxBundleSizeBytes.js";
import { sandboxTransportDurationMs } from "./sandboxTransportDurationMs.js";
import { sandboxPatchCount } from "./sandboxPatchCount.js";
import { heartbeatDataSizeBytes } from "./heartbeatDataSizeBytes.js";
import { heartbeatIntervalMs } from "./heartbeatIntervalMs.js";
/** @typedef {import("./SmithersMetricType.ts").SmithersMetricType} SmithersMetricType */

/** @typedef {import("./SmithersMetricDefinition.ts").SmithersMetricDefinition} SmithersMetricDefinition */

/**
 * @param {any} boundaries
 * @returns {readonly number[]}
 */
function metricBoundaryValues(boundaries) {
    return Array.from((boundaries?.values ?? [])).sort((left, right) => left - right);
}
/**
 * @param {Metric.Metric<any, any, any>} metric
 * @returns {readonly number[]}
 */
function metricHistogramBoundaries(metric) {
    return Array.from((metric?.keyType?.boundaries?.values ?? []))
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => left - right);
}
/**
 * @param {string} key
 * @param {Metric.Metric<any, any, any>} metric
 * @param {string} name
 * @param {SmithersMetricType} type
 * @param {Omit< SmithersMetricDefinition, "key" | "metric" | "name" | "prometheusName" | "type" >} options
 * @returns {SmithersMetricDefinition}
 */
function metricDefinition(key, metric, name, type, options) {
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
export const smithersMetricCatalog = [
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
    metricDefinition("memoryRecallDuration", memoryRecallDuration, "smithers.memory.recall_duration_ms", "histogram", { label: "Memory recall duration", unit: "milliseconds", boundaries: metricHistogramBoundaries(memoryRecallDuration) }),
    metricDefinition("openApiToolDuration", openApiToolDuration, "smithers.openapi.tool_duration_ms", "histogram", { label: "OpenAPI tool duration", unit: "milliseconds", boundaries: metricHistogramBoundaries(openApiToolDuration) }),
    metricDefinition("scorerDuration", scorerDuration, "smithers.scorer.duration_ms", "histogram", { label: "Scorer duration", unit: "milliseconds", boundaries: metricHistogramBoundaries(scorerDuration) }),
    metricDefinition("snapshotDuration", snapshotDuration, "smithers.snapshot.duration_ms", "histogram", { label: "Snapshot duration", unit: "milliseconds", boundaries: metricHistogramBoundaries(snapshotDuration) }),
];
