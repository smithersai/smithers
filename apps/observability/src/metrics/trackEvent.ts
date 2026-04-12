import { Effect, Metric } from "effect";
import type { SmithersEvent } from "@smithers/observability/SmithersEvent";
import {
  memoryFactWrites,
  memoryRecallQueries,
  memoryMessageSaves,
} from "@smithers/memory/metrics";
import {
  openApiToolCallsTotal,
  openApiToolCallErrorsTotal,
  openApiToolDuration,
} from "@smithers/openapi/metrics";

import { runsTotal } from "./runsTotal";
import { nodesStarted } from "./nodesStarted";
import { nodesFinished } from "./nodesFinished";
import { nodesFailed } from "./nodesFailed";
import { toolCallsTotal } from "./toolCallsTotal";
import { toolCallErrorsTotal } from "./toolCallErrorsTotal";
import { errorsTotal } from "./errorsTotal";
import { nodeRetriesTotal } from "./nodeRetriesTotal";
import { eventsEmittedTotal } from "./eventsEmittedTotal";
import { activeRuns } from "./activeRuns";
import { activeNodes } from "./activeNodes";
import { runsFinishedTotal } from "./runsFinishedTotal";
import { runsFailedTotal } from "./runsFailedTotal";
import { runsCancelledTotal } from "./runsCancelledTotal";
import { runsContinuedTotal } from "./runsContinuedTotal";
import { runsAncestryDepth } from "./runsAncestryDepth";
import { runsCarriedStateBytes } from "./runsCarriedStateBytes";
import { approvalsRequested } from "./approvalsRequested";
import { approvalsGranted } from "./approvalsGranted";
import { approvalsDenied } from "./approvalsDenied";
import { approvalPending } from "./approvalPending";
import { timersCreated } from "./timersCreated";
import { timersFired } from "./timersFired";
import { timersCancelled } from "./timersCancelled";
import { timersPending } from "./timersPending";
import { timerDelayDuration } from "./timerDelayDuration";
import { tokensInputTotal } from "./tokensInputTotal";
import { tokensOutputTotal } from "./tokensOutputTotal";
import { tokensCacheReadTotal } from "./tokensCacheReadTotal";
import { tokensCacheWriteTotal } from "./tokensCacheWriteTotal";
import { tokensReasoningTotal } from "./tokensReasoningTotal";
import { tokensContextWindowBucketTotal } from "./tokensContextWindowBucketTotal";
import { tokensInputPerCall } from "./tokensInputPerCall";
import { tokensOutputPerCall } from "./tokensOutputPerCall";
import { tokensContextWindowPerCall } from "./tokensContextWindowPerCall";
import { scorerEventsStarted } from "./scorerEventsStarted";
import { scorerEventsFinished } from "./scorerEventsFinished";
import { scorerEventsFailed } from "./scorerEventsFailed";
import { supervisorPollsTotal } from "./supervisorPollsTotal";
import { supervisorStaleDetected } from "./supervisorStaleDetected";
import { supervisorResumedTotal } from "./supervisorResumedTotal";
import { supervisorSkippedTotal } from "./supervisorSkippedTotal";
import { supervisorPollDuration } from "./supervisorPollDuration";
import { supervisorResumeLag } from "./supervisorResumeLag";
import { sandboxCreatedTotal } from "./sandboxCreatedTotal";
import { sandboxCompletedTotal } from "./sandboxCompletedTotal";
import { sandboxActive } from "./sandboxActive";
import { sandboxBundleSizeBytes } from "./sandboxBundleSizeBytes";
import { sandboxDurationMs } from "./sandboxDurationMs";
import { sandboxPatchCount } from "./sandboxPatchCount";

import { taskHeartbeatsTotal } from "./taskHeartbeatsTotal";
import { taskHeartbeatTimeoutTotal } from "./taskHeartbeatTimeoutTotal";
import { heartbeatDataSizeBytes } from "./heartbeatDataSizeBytes";
import { heartbeatIntervalMs } from "./heartbeatIntervalMs";
import { agentEventsTotal } from "./agentEventsTotal";
import { agentSessionsTotal } from "./agentSessionsTotal";
import { agentActionsTotal } from "./agentActionsTotal";
import { agentErrorsTotal } from "./agentErrorsTotal";
import { agentRetriesTotal } from "./agentRetriesTotal";
import { agentTokensTotal } from "./agentTokensTotal";

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
