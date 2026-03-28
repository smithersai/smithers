// @ts-nocheck
/**
 * <CanaryJudge> — Compare logs/metrics/traces between stable and canary deployments
 * and recommend promote, hold, or rollback.
 *
 * Pattern: telemetry collectors → comparator → judge agent → deploy control plane.
 * Use cases: canary deployments, progressive delivery, deployment safety gates.
 */
import { createSmithers, Sequence, Parallel } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import CollectStablePrompt from "./prompts/canary-judge/collect-stable.mdx";
import CollectCanaryPrompt from "./prompts/canary-judge/collect-canary.mdx";
import ComparePrompt from "./prompts/canary-judge/compare.mdx";
import JudgePrompt from "./prompts/canary-judge/judge.mdx";
import DeployPrompt from "./prompts/canary-judge/deploy.mdx";

const telemetrySchema = z.object({
  stream: z.enum(["stable", "canary"]),
  latencyP50Ms: z.number().describe("Median latency in milliseconds"),
  latencyP99Ms: z.number().describe("99th percentile latency in milliseconds"),
  errorRate: z.number().describe("Error rate as a percentage"),
  throughputRps: z.number().describe("Requests per second"),
  logAnomalies: z.array(z.string()).describe("Notable log patterns or anomalies"),
  traceWarnings: z.array(z.string()).describe("Trace-level warnings (slow spans, retries, etc.)"),
});

const comparisonSchema = z.object({
  latencyDelta: z.object({
    p50Pct: z.number().describe("Percentage change in p50 latency (positive = regression)"),
    p99Pct: z.number().describe("Percentage change in p99 latency"),
  }),
  errorRateDelta: z.number().describe("Absolute change in error rate (canary - stable)"),
  throughputDelta: z.number().describe("Percentage change in throughput"),
  newAnomalies: z.array(z.string()).describe("Anomalies present in canary but not stable"),
  riskSignals: z.array(z.object({
    signal: z.string(),
    severity: z.enum(["critical", "high", "medium", "low"]),
  })),
  summary: z.string(),
});

const verdictSchema = z.object({
  decision: z.enum(["promote", "hold", "rollback"]),
  confidence: z.number().min(0).max(100),
  reasons: z.array(z.string()),
  conditions: z.array(z.string()).describe("Conditions that must remain true for decision to hold"),
  summary: z.string(),
});

const deployActionSchema = z.object({
  action: z.enum(["promote", "hold", "rollback"]),
  commands: z.array(z.string()).describe("Deploy control plane commands to execute"),
  notifyChannels: z.array(z.string()),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  telemetry: telemetrySchema,
  comparison: comparisonSchema,
  verdict: verdictSchema,
  deployAction: deployActionSchema,
});

const telemetryCollector = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a telemetry collector for deployment streams. Query the provided
metrics endpoints, log sources, and trace stores to gather latency percentiles, error rates,
throughput, log anomalies, and trace warnings. Normalize all values for consistent comparison.`,
});

const comparator = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash },
  instructions: `You are a deployment telemetry comparator. Given stable and canary telemetry
snapshots, compute deltas across all dimensions: latency, error rate, throughput. Identify
anomalies unique to the canary. Flag risk signals with severity levels. Be precise about
percentage changes and use statistical significance where sample sizes allow.`,
});

const judge = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are a canary deployment judge. Based on the telemetry comparison, render a
promote/hold/rollback decision. Promote if all metrics are within acceptable thresholds. Hold if
there are moderate regressions that need observation. Rollback if there are critical regressions
or new error patterns. Provide a confidence score and list the conditions that must remain true.`,
});

export default smithers((ctx) => {
  const stableTelemetry = ctx.outputMaybe("telemetry", { nodeId: "collect-stable" });
  const canaryTelemetry = ctx.outputMaybe("telemetry", { nodeId: "collect-canary" });
  const comparison = ctx.outputMaybe("comparison", { nodeId: "compare" });
  const verdict = ctx.outputMaybe("verdict", { nodeId: "judge" });

  return (
    <Workflow name="canary-judge">
      <Sequence>
        {/* Phase 1: Collect telemetry from both deployment streams in parallel */}
        <Parallel maxConcurrency={2}>
          <Task id="collect-stable" output={outputs.telemetry} agent={telemetryCollector}>
            <CollectStablePrompt
              stream="stable"
              metricsEndpoint={ctx.input.stableMetricsEndpoint}
              logSource={ctx.input.stableLogSource}
              traceStore={ctx.input.stableTraceStore}
              windowMinutes={ctx.input.windowMinutes ?? 15}
            />
          </Task>
          <Task id="collect-canary" output={outputs.telemetry} agent={telemetryCollector}>
            <CollectCanaryPrompt
              stream="canary"
              metricsEndpoint={ctx.input.canaryMetricsEndpoint}
              logSource={ctx.input.canaryLogSource}
              traceStore={ctx.input.canaryTraceStore}
              windowMinutes={ctx.input.windowMinutes ?? 15}
            />
          </Task>
        </Parallel>

        {/* Phase 2: Compare telemetry across dimensions */}
        <Task id="compare" output={outputs.comparison} agent={comparator}>
          <ComparePrompt
            stable={stableTelemetry}
            canary={canaryTelemetry}
            thresholds={ctx.input.thresholds ?? {}}
          />
        </Task>

        {/* Phase 3: Judge agent renders promote/hold/rollback decision */}
        <Task id="judge" output={outputs.verdict} agent={judge}>
          <JudgePrompt
            comparison={comparison}
            riskSignals={comparison?.riskSignals ?? []}
            deploymentId={ctx.input.deploymentId ?? "unknown"}
            serviceName={ctx.input.serviceName ?? "unknown"}
          />
        </Task>

        {/* Phase 4: Emit deploy control plane action */}
        <Task id="deploy" output={outputs.deployAction}>
          <DeployPrompt
            decision={verdict?.decision ?? "hold"}
            confidence={verdict?.confidence ?? 0}
            reasons={verdict?.reasons ?? []}
            conditions={verdict?.conditions ?? []}
            deploymentId={ctx.input.deploymentId ?? "unknown"}
            serviceName={ctx.input.serviceName ?? "unknown"}
            notifyChannels={ctx.input.notifyChannels ?? ["#deploys"]}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
