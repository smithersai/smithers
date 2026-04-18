import { Effect, Metric } from "effect";
import { memoryFactWrites, memoryRecallQueries, memoryMessageSaves, } from "@smithers-orchestrator/memory/metrics";
import { openApiToolCallsTotal, openApiToolCallErrorsTotal, openApiToolDuration, } from "@smithers-orchestrator/openapi/metrics";
import { runsTotal } from "./runsTotal.js";
import { nodesStarted } from "./nodesStarted.js";
import { nodesFinished } from "./nodesFinished.js";
import { nodesFailed } from "./nodesFailed.js";
import { toolCallsTotal } from "./toolCallsTotal.js";
import { toolCallErrorsTotal } from "./toolCallErrorsTotal.js";
import { errorsTotal } from "./errorsTotal.js";
import { nodeRetriesTotal } from "./nodeRetriesTotal.js";
import { eventsEmittedTotal } from "./eventsEmittedTotal.js";
import { activeRuns } from "./activeRuns.js";
import { activeNodes } from "./activeNodes.js";
import { runsFinishedTotal } from "./runsFinishedTotal.js";
import { runsFailedTotal } from "./runsFailedTotal.js";
import { runsCancelledTotal } from "./runsCancelledTotal.js";
import { runsContinuedTotal } from "./runsContinuedTotal.js";
import { runsAncestryDepth } from "./runsAncestryDepth.js";
import { runsCarriedStateBytes } from "./runsCarriedStateBytes.js";
import { approvalsRequested } from "./approvalsRequested.js";
import { approvalsGranted } from "./approvalsGranted.js";
import { approvalsDenied } from "./approvalsDenied.js";
import { approvalPending } from "./approvalPending.js";
import { timersCreated } from "./timersCreated.js";
import { timersFired } from "./timersFired.js";
import { timersCancelled } from "./timersCancelled.js";
import { timersPending } from "./timersPending.js";
import { timerDelayDuration } from "./timerDelayDuration.js";
import { tokensInputTotal } from "./tokensInputTotal.js";
import { tokensOutputTotal } from "./tokensOutputTotal.js";
import { tokensCacheReadTotal } from "./tokensCacheReadTotal.js";
import { tokensCacheWriteTotal } from "./tokensCacheWriteTotal.js";
import { tokensReasoningTotal } from "./tokensReasoningTotal.js";
import { tokensContextWindowBucketTotal } from "./tokensContextWindowBucketTotal.js";
import { tokensInputPerCall } from "./tokensInputPerCall.js";
import { tokensOutputPerCall } from "./tokensOutputPerCall.js";
import { tokensContextWindowPerCall } from "./tokensContextWindowPerCall.js";
import { scorerEventsStarted } from "./scorerEventsStarted.js";
import { scorerEventsFinished } from "./scorerEventsFinished.js";
import { scorerEventsFailed } from "./scorerEventsFailed.js";
import { supervisorPollsTotal } from "./supervisorPollsTotal.js";
import { supervisorStaleDetected } from "./supervisorStaleDetected.js";
import { supervisorResumedTotal } from "./supervisorResumedTotal.js";
import { supervisorSkippedTotal } from "./supervisorSkippedTotal.js";
import { supervisorPollDuration } from "./supervisorPollDuration.js";
import { supervisorResumeLag } from "./supervisorResumeLag.js";
import { sandboxCreatedTotal } from "./sandboxCreatedTotal.js";
import { sandboxCompletedTotal } from "./sandboxCompletedTotal.js";
import { sandboxActive } from "./sandboxActive.js";
import { sandboxBundleSizeBytes } from "./sandboxBundleSizeBytes.js";
import { sandboxDurationMs } from "./sandboxDurationMs.js";
import { sandboxPatchCount } from "./sandboxPatchCount.js";
import { taskHeartbeatsTotal } from "./taskHeartbeatsTotal.js";
import { taskHeartbeatTimeoutTotal } from "./taskHeartbeatTimeoutTotal.js";
import { heartbeatDataSizeBytes } from "./heartbeatDataSizeBytes.js";
import { heartbeatIntervalMs } from "./heartbeatIntervalMs.js";
import { agentEventsTotal } from "./agentEventsTotal.js";
import { agentSessionsTotal } from "./agentSessionsTotal.js";
import { agentActionsTotal } from "./agentActionsTotal.js";
import { agentErrorsTotal } from "./agentErrorsTotal.js";
import { agentRetriesTotal } from "./agentRetriesTotal.js";
import { agentTokensTotal } from "./agentTokensTotal.js";
/** @typedef {import("@smithers-orchestrator/observability/SmithersEvent").SmithersEvent} SmithersEvent */

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function normalizeMetricTag(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
/**
 * @template A
 * @param {A} metric
 * @param {Record<string, string | undefined>} tags
 * @returns {A}
 */
function tagMetricWithTags(metric, tags) {
    let tagged = metric;
    for (const [key, value] of Object.entries(tags)) {
        if (!value)
            continue;
        tagged = Metric.tagged(tagged, key, value);
    }
    return tagged;
}
/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function asFiniteMetricCount(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : undefined;
}
/**
 * @param {Extract<SmithersEvent, { type: "TokenUsageReported" }>} event
 * @returns {number | undefined}
 */
function resolveContextWindowTokens(event) {
    const inputTokens = asFiniteMetricCount(event.inputTokens);
    if (inputTokens) {
        return inputTokens;
    }
    const cachedInputTokens = (asFiniteMetricCount(event.cacheReadTokens) ?? 0)
        + (asFiniteMetricCount(event.cacheWriteTokens) ?? 0);
    return cachedInputTokens > 0 ? cachedInputTokens : undefined;
}
/**
 * @param {number} tokens
 * @returns {string}
 */
function classifyContextWindowBucket(tokens) {
    if (tokens < 50_000)
        return "lt_50k";
    if (tokens < 100_000)
        return "gte_50k_lt_100k";
    if (tokens < 200_000)
        return "gte_100k_lt_200k";
    if (tokens < 500_000)
        return "gte_200k_lt_500k";
    if (tokens < 1_000_000)
        return "gte_500k_lt_1m";
    return "gte_1m";
}
/**
 * @param {Record<string, unknown> | undefined} usage
 * @returns {AgentUsageTotals}
 */
function extractAgentUsageTotals(usage) {
    if (!usage)
        return {};
    const value = usage;
    const inputTokens = asFiniteMetricCount(value.inputTokens)
        ?? asFiniteMetricCount(value.input_tokens)
        ?? asFiniteMetricCount(value.prompt_tokens);
    const outputTokens = asFiniteMetricCount(value.outputTokens)
        ?? asFiniteMetricCount(value.output_tokens)
        ?? asFiniteMetricCount(value.completion_tokens);
    const cacheReadTokens = asFiniteMetricCount(value.cacheReadTokens)
        ?? asFiniteMetricCount(value.cache_read_input_tokens)
        ?? asFiniteMetricCount(value.cached_input_tokens)
        ?? asFiniteMetricCount(value.inputTokenDetails?.cacheReadTokens);
    const cacheWriteTokens = asFiniteMetricCount(value.cacheWriteTokens)
        ?? asFiniteMetricCount(value.cache_creation_input_tokens)
        ?? asFiniteMetricCount(value.inputTokenDetails?.cacheWriteTokens);
    const reasoningTokens = asFiniteMetricCount(value.reasoningTokens)
        ?? asFiniteMetricCount(value.reasoning_tokens)
        ?? asFiniteMetricCount(value.outputTokenDetails?.reasoningTokens);
    const totalTokens = asFiniteMetricCount(value.totalTokens)
        ?? asFiniteMetricCount((inputTokens ?? 0)
            + (outputTokens ?? 0)
            + (cacheReadTokens ?? 0)
            + (cacheWriteTokens ?? 0)
            + (reasoningTokens ?? 0));
    return {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens,
        totalTokens,
    };
}
/**
 * @param {Record<string, string | undefined>} tags
 * @param {Record<string, unknown> | undefined} usage
 * @returns {Effect.Effect<void>}
 */
function recordAgentUsageMetrics(tags, usage) {
    const totals = extractAgentUsageTotals(usage);
    const effects = [];
    /**
   * @param {string} kind
   * @param {number | undefined} value
   */
    const pushMetric = (kind, value) => {
        if (!value || value <= 0)
            return;
        effects.push(Metric.incrementBy(tagMetricWithTags(agentTokensTotal, {
            ...tags,
            kind,
        }), value));
    };
    pushMetric("input", totals.inputTokens);
    pushMetric("output", totals.outputTokens);
    pushMetric("cache_read", totals.cacheReadTokens);
    pushMetric("cache_write", totals.cacheWriteTokens);
    pushMetric("reasoning", totals.reasoningTokens);
    pushMetric("total", totals.totalTokens);
    return effects.length > 0 ? Effect.all(effects, { discard: true }) : Effect.void;
}
/**
 * @param {AgentEventPayload} event
 * @returns {boolean}
 */
function hasAgentRetrySignal(event) {
    const retryPattern = /\bretry(?:ing|able| after)?\b|\bbackoff\b|\brate limit\b/i;
    switch (event.type) {
        case "started":
            return false;
        case "action": {
            const detail = event.action.detail;
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
/**
 * @param {SmithersEvent} event
 * @returns {Effect.Effect<void>}
 */
export function trackEvent(event) {
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
            const byRuntime = event.runtime && event.runtime.length > 0
                ? Metric.tagged(sandboxCreatedTotal, "runtime", event.runtime)
                : sandboxCreatedTotal;
            return Effect.all([
                countEvent,
                Metric.increment(byRuntime),
                Metric.incrementBy(event.runtime ? Metric.tagged(sandboxActive, "runtime", event.runtime) : sandboxActive, 1),
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
            const byRuntime = event.runtime && event.runtime.length > 0
                ? Metric.tagged(Metric.tagged(sandboxCompletedTotal, "runtime", event.runtime), "status", event.status)
                : sandboxCompletedTotal;
            return Effect.all([
                countEvent,
                Metric.increment(byRuntime),
                Metric.incrementBy(event.runtime ? Metric.tagged(sandboxActive, "runtime", event.runtime) : sandboxActive, -1),
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
            const effects = [countEvent];
            const tags = {};
            if (event.model && event.model !== "unknown")
                tags.model = event.model;
            if (event.agent && event.agent !== "unknown")
                tags.agent = event.agent;
            /**
       * @template A
       * @param {A} m
       * @returns {A}
       */
            const tagMetric = (m) => {
                let res = m;
                for (const [k, v] of Object.entries(tags)) {
                    res = Metric.tagged(res, k, v);
                }
                return res;
            };
            if (event.inputTokens > 0) {
                effects.push(Metric.incrementBy(tagMetric(tokensInputTotal), event.inputTokens), Metric.update(tagMetric(tokensInputPerCall), event.inputTokens));
            }
            if (event.outputTokens > 0) {
                effects.push(Metric.incrementBy(tagMetric(tokensOutputTotal), event.outputTokens), Metric.update(tagMetric(tokensOutputPerCall), event.outputTokens));
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
                effects.push(Metric.update(tagMetric(tokensContextWindowPerCall), contextWindowTokens), Metric.increment(tagMetric(Metric.tagged(tokensContextWindowBucketTotal, "bucket", classifyContextWindowBucket(contextWindowTokens)))));
            }
            return Effect.all(effects, { discard: true });
        }
        case "AgentEvent": {
            const agentEvent = event.event;
            const engine = normalizeMetricTag(agentEvent.engine)
                ?? normalizeMetricTag(event.engine)
                ?? "unknown";
            const baseTags = {
                engine,
                source: "event",
            };
            const effects = [
                countEvent,
                Metric.increment(tagMetricWithTags(agentEventsTotal, {
                    ...baseTags,
                    event_type: agentEvent.type,
                })),
            ];
            switch (agentEvent.type) {
                case "started":
                    effects.push(Metric.increment(tagMetricWithTags(agentSessionsTotal, {
                        ...baseTags,
                        status: "started",
                        resume: agentEvent.resume ? "true" : "false",
                    })));
                    break;
                case "action":
                    effects.push(Metric.increment(tagMetricWithTags(agentActionsTotal, {
                        ...baseTags,
                        action_kind: agentEvent.action.kind,
                        phase: agentEvent.phase,
                        level: agentEvent.level,
                        entry_type: agentEvent.entryType,
                        ok: typeof agentEvent.ok === "boolean" ? String(agentEvent.ok) : undefined,
                    })));
                    if (agentEvent.level === "error" || agentEvent.ok === false) {
                        effects.push(Metric.increment(tagMetricWithTags(agentErrorsTotal, {
                            ...baseTags,
                            event_type: agentEvent.type,
                            action_kind: agentEvent.action.kind,
                        })));
                    }
                    if (hasAgentRetrySignal(agentEvent)) {
                        effects.push(Metric.increment(tagMetricWithTags(agentRetriesTotal, {
                            ...baseTags,
                            reason: "event_signal",
                        })));
                    }
                    break;
                case "completed":
                    effects.push(Metric.increment(tagMetricWithTags(agentSessionsTotal, {
                        ...baseTags,
                        status: agentEvent.ok ? "completed" : "failed",
                        resume: agentEvent.resume ? "true" : "false",
                    })));
                    effects.push(recordAgentUsageMetrics(baseTags, agentEvent.usage));
                    if (!agentEvent.ok) {
                        effects.push(Metric.increment(tagMetricWithTags(agentErrorsTotal, {
                            ...baseTags,
                            event_type: agentEvent.type,
                        })));
                    }
                    if (hasAgentRetrySignal(agentEvent)) {
                        effects.push(Metric.increment(tagMetricWithTags(agentRetriesTotal, {
                            ...baseTags,
                            reason: "event_signal",
                        })));
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
