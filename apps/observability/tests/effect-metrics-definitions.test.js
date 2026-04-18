import { describe, expect, test } from "bun:test";
import { Effect, Metric } from "effect";
import { runsTotal, nodesStarted, nodesFinished, nodesFailed, toolCallsTotal, cacheHits, cacheMisses, dbRetries, dbTransactionRetries, dbTransactionRollbacks, hotReloads, hotReloadFailures, httpRequests, approvalsRequested, approvalsGranted, approvalsDenied, scorerEventsStarted, scorerEventsFinished, scorerEventsFailed, tokensInputTotal, tokensOutputTotal, tokensCacheReadTotal, tokensCacheWriteTotal, tokensContextWindowBucketTotal, tokensReasoningTotal, runsFinishedTotal, runsFailedTotal, runsCancelledTotal, runsResumedTotal, supervisorPollsTotal, supervisorStaleDetected, supervisorResumedTotal, supervisorSkippedTotal, errorsTotal, nodeRetriesTotal, toolCallErrorsTotal, toolOutputTruncatedTotal, eventsEmittedTotal, taskHeartbeatsTotal, taskHeartbeatTimeoutTotal, activeRuns, activeNodes, schedulerQueueDepth, approvalPending, externalWaitAsyncPending, nodeDuration, attemptDuration, toolDuration, dbQueryDuration, dbTransactionDuration, httpRequestDuration, hotReloadDuration, vcsDuration, tokensInputPerCall, tokensOutputPerCall, tokensContextWindowPerCall, runDuration, promptSizeBytes, responseSizeBytes, approvalWaitDuration, schedulerWaitDuration, supervisorPollDuration, supervisorResumeLag, heartbeatDataSizeBytes, heartbeatIntervalMs, updateProcessMetrics, } from "@smithers-orchestrator/observability/metrics";
describe("effect/metrics definitions", () => {
    test("all counters can be incremented without error", async () => {
        const counters = [
            runsTotal,
            nodesStarted,
            nodesFinished,
            nodesFailed,
            toolCallsTotal,
            cacheHits,
            cacheMisses,
            dbRetries,
            dbTransactionRetries,
            dbTransactionRollbacks,
            hotReloads,
            hotReloadFailures,
            httpRequests,
            approvalsRequested,
            approvalsGranted,
            approvalsDenied,
            scorerEventsStarted,
            scorerEventsFinished,
            scorerEventsFailed,
            tokensInputTotal,
            tokensOutputTotal,
            tokensCacheReadTotal,
            tokensCacheWriteTotal,
            tokensContextWindowBucketTotal,
            tokensReasoningTotal,
            runsFinishedTotal,
            runsFailedTotal,
            runsCancelledTotal,
            runsResumedTotal,
            supervisorPollsTotal,
            supervisorStaleDetected,
            supervisorResumedTotal,
            supervisorSkippedTotal,
            errorsTotal,
            nodeRetriesTotal,
            toolCallErrorsTotal,
            toolOutputTruncatedTotal,
            eventsEmittedTotal,
            taskHeartbeatsTotal,
            taskHeartbeatTimeoutTotal,
        ];
        for (const counter of counters) {
            await Effect.runPromise(Metric.increment(counter));
        }
    });
    test("all gauges can be set without error", async () => {
        const gauges = [
            activeRuns,
            activeNodes,
            schedulerQueueDepth,
            approvalPending,
            externalWaitAsyncPending,
        ];
        for (const gauge of gauges) {
            await Effect.runPromise(Metric.set(gauge, 1));
            await Effect.runPromise(Metric.set(gauge, 0));
        }
    });
    test("all histograms can be updated without error", async () => {
        const histograms = [
            nodeDuration,
            attemptDuration,
            toolDuration,
            dbQueryDuration,
            dbTransactionDuration,
            httpRequestDuration,
            hotReloadDuration,
            vcsDuration,
            tokensInputPerCall,
            tokensOutputPerCall,
            tokensContextWindowPerCall,
            runDuration,
            promptSizeBytes,
            responseSizeBytes,
            approvalWaitDuration,
            schedulerWaitDuration,
            supervisorPollDuration,
            supervisorResumeLag,
            heartbeatDataSizeBytes,
            heartbeatIntervalMs,
        ];
        for (const histogram of histograms) {
            await Effect.runPromise(Metric.update(histogram, 42));
        }
    });
    test("updateProcessMetrics runs without error", async () => {
        await Effect.runPromise(updateProcessMetrics());
    });
});
