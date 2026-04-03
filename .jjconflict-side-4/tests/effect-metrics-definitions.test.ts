import { describe, expect, test } from "bun:test";
import { Effect, Metric } from "effect";
import {
  runsTotal,
  nodesStarted,
  nodesFinished,
  nodesFailed,
  toolCallsTotal,
  cacheHits,
  cacheMisses,
  dbRetries,
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
  tokensReasoningTotal,
  runsFinishedTotal,
  runsFailedTotal,
  runsCancelledTotal,
  runsResumedTotal,
  errorsTotal,
  nodeRetriesTotal,
  toolCallErrorsTotal,
  toolOutputTruncatedTotal,
  voiceOperationsTotal,
  voiceErrorsTotal,
  eventsEmittedTotal,
  activeRuns,
  activeNodes,
  schedulerQueueDepth,
  approvalPending,
  nodeDuration,
  attemptDuration,
  toolDuration,
  dbQueryDuration,
  httpRequestDuration,
  hotReloadDuration,
  vcsDuration,
  tokensInputPerCall,
  tokensOutputPerCall,
  runDuration,
  promptSizeBytes,
  responseSizeBytes,
  approvalWaitDuration,
  voiceDuration,
  schedulerWaitDuration,
  updateProcessMetrics,
} from "../src/effect/metrics";

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
      tokensReasoningTotal,
      runsFinishedTotal,
      runsFailedTotal,
      runsCancelledTotal,
      runsResumedTotal,
      errorsTotal,
      nodeRetriesTotal,
      toolCallErrorsTotal,
      toolOutputTruncatedTotal,
      voiceOperationsTotal,
      voiceErrorsTotal,
      eventsEmittedTotal,
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
      httpRequestDuration,
      hotReloadDuration,
      vcsDuration,
      tokensInputPerCall,
      tokensOutputPerCall,
      runDuration,
      promptSizeBytes,
      responseSizeBytes,
      approvalWaitDuration,
      voiceDuration,
          schedulerWaitDuration,
    ];

    for (const histogram of histograms) {
      await Effect.runPromise(Metric.update(histogram, 42));
    }
  });

  test("updateProcessMetrics runs without error", async () => {
    await Effect.runPromise(updateProcessMetrics());
  });
});
