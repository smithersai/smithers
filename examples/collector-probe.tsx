/**
 * <CollectorProbe> — Wrap agent calls with timing/usage collection and alert
 * only when quality, cost, or timing drifts beyond acceptable thresholds.
 *
 * Shape: invocation -> collector -> anomaly detector / report.
 * Pattern: Loop monitors successive invocations, flags drift, emits report.
 */
import { createSmithers, Sequence, Loop } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import InvocationPrompt from "./prompts/collector-probe/invocation.mdx";
import CollectorPrompt from "./prompts/collector-probe/collector.mdx";
import AnomalyPrompt from "./prompts/collector-probe/anomaly.mdx";
import ReportPrompt from "./prompts/collector-probe/report.mdx";

const invocationSchema = z.object({
  callId: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  latencyMs: z.number(),
  costUsd: z.number(),
  qualityScore: z.number().min(0).max(1),
  timestamp: z.string(),
  metadata: z.record(z.string(), z.string()).optional(),
});

const collectorSchema = z.object({
  samples: z.array(
    z.object({
      callId: z.string(),
      latencyMs: z.number(),
      costUsd: z.number(),
      qualityScore: z.number(),
    })
  ),
  aggregates: z.object({
    meanLatencyMs: z.number(),
    p95LatencyMs: z.number(),
    meanCostUsd: z.number(),
    meanQuality: z.number(),
    totalInvocations: z.number(),
  }),
  summary: z.string(),
});

const anomalySchema = z.object({
  driftDetected: z.boolean(),
  anomalies: z.array(
    z.object({
      metric: z.enum(["quality", "cost", "latency"]),
      direction: z.enum(["up", "down"]),
      deltaPercent: z.number(),
      baselineValue: z.number(),
      currentValue: z.number(),
      severity: z.enum(["info", "warning", "critical"]),
    })
  ),
  shouldAlert: z.boolean(),
  summary: z.string(),
});

const reportSchema = z.object({
  overallStatus: z.enum(["healthy", "degraded", "critical"]),
  totalInvocations: z.number(),
  iterationsRun: z.number(),
  anomaliesDetected: z.number(),
  alerts: z.array(
    z.object({
      metric: z.string(),
      message: z.string(),
      severity: z.enum(["info", "warning", "critical"]),
    })
  ),
  recommendations: z.array(z.string()),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  invocation: invocationSchema,
  collector: collectorSchema,
  anomaly: anomalySchema,
  report: reportSchema,
});

const collectorAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a telemetry collector. Given raw invocation data, aggregate
timing, cost, and quality metrics. Compute running statistics (mean, p95) across
the sample window. Be precise with numbers and preserve all sample data.`,
});

const anomalyAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash },
  instructions: `You are an anomaly detector for AI agent telemetry. Compare current
aggregates against the provided baselines. Flag drift when quality drops more than 5%,
cost rises more than 15%, or latency rises more than 25%. Set shouldAlert to true only
when at least one anomaly reaches warning or critical severity.`,
});

export default smithers((ctx) => {
  const baselines = ctx.input.baselines ?? {
    quality: 0.92,
    costUsd: 0.02,
    latencyMs: 500,
  };
  const maxIterations = ctx.input.maxIterations ?? 5;

  const anomalies = ctx.outputs.anomaly ?? [];
  const latestAnomaly = anomalies[anomalies.length - 1];
  const noMoreDrift = anomalies.length > 0 && !(latestAnomaly?.driftDetected);

  const collectors = ctx.outputs.collector ?? [];
  const latestCollector = collectors[collectors.length - 1];

  return (
    <Workflow name="collector-probe">
      <Sequence>
        <Loop until={noMoreDrift} maxIterations={maxIterations} onMaxReached="return-last">
          <Sequence>
            {/* Stage 1: Invoke and capture raw telemetry */}
            <Task id="invocation" output={outputs.invocation}>
              <InvocationPrompt
                endpoint={ctx.input.endpoint}
                payload={ctx.input.payload}
                baselines={baselines}
                iteration={collectors.length + 1}
              />
            </Task>

            {/* Stage 2: Collect and aggregate metrics */}
            <Task id="collector" output={outputs.collector} agent={collectorAgent}>
              <CollectorPrompt
                invocations={ctx.outputs.invocation ?? []}
                previousAggregates={latestCollector?.aggregates ?? null}
              />
            </Task>

            {/* Stage 3: Detect anomalies and decide whether to alert */}
            <Task id="anomaly" output={outputs.anomaly} agent={anomalyAgent}>
              <AnomalyPrompt
                aggregates={latestCollector?.aggregates ?? {}}
                baselines={baselines}
                previousAnomalies={anomalies}
              />
            </Task>
          </Sequence>
        </Loop>

        {/* Final report summarizing all iterations */}
        <Task id="report" output={outputs.report}>
          {{
            overallStatus: anomalies.some((a) => a.anomalies.some((x) => x.severity === "critical"))
              ? "critical"
              : anomalies.some((a) => a.driftDetected)
                ? "degraded"
                : "healthy",
            totalInvocations: (ctx.outputs.invocation ?? []).length,
            iterationsRun: collectors.length,
            anomaliesDetected: anomalies.filter((a) => a.driftDetected).length,
            alerts: anomalies
              .filter((a) => a.shouldAlert)
              .flatMap((a) =>
                a.anomalies.map((x) => ({
                  metric: x.metric,
                  message: `${x.metric} drifted ${x.direction} by ${x.deltaPercent}% (${x.baselineValue} -> ${x.currentValue})`,
                  severity: x.severity,
                }))
              ),
            recommendations: anomalies.some((a) => a.driftDetected)
              ? [
                  "Review model configuration for quality regression",
                  "Check upstream latency contributors",
                  "Consider adjusting cost thresholds if usage patterns changed",
                ]
              : ["All metrics within acceptable thresholds"],
            summary: `Collector probe ran ${collectors.length} iterations over ${(ctx.outputs.invocation ?? []).length} invocations. ${anomalies.filter((a) => a.driftDetected).length} drift events detected.`,
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
