// @ts-nocheck
/**
 * <TraceExplainer> — Read agent/workflow traces and produce a concise explanation
 * of where time, tokens, or failures accumulated.
 *
 * Shape: trace store → analyzer agent → optimization report.
 */
import { Sequence } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import IngestPrompt from "./prompts/trace-explainer/ingest.mdx";
import AnalyzePrompt from "./prompts/trace-explainer/analyze.mdx";
import ReportPrompt from "./prompts/trace-explainer/report.mdx";

const spanSchema = z.object({
  name: z.string(),
  durationMs: z.number(),
  tokenCount: z.number().optional(),
  failed: z.boolean(),
  error: z.string().optional(),
  children: z.array(z.string()).optional(),
});

const ingestSchema = z.object({
  spans: z.array(spanSchema),
  totalDurationMs: z.number(),
  totalTokens: z.number(),
  failedSpanCount: z.number(),
});

const analysisSchema = z.object({
  bottleneck: z.object({
    spanName: z.string(),
    reason: z.enum(["latency", "tokens", "failure", "retry-storm"]),
    impact: z.string(),
  }),
  hotPath: z.array(z.string()),
  failureSummary: z.string().nullable(),
  tokenHogs: z.array(z.object({
    spanName: z.string(),
    tokenCount: z.number(),
    percentOfTotal: z.number(),
  })),
});

const reportSchema = z.object({
  title: z.string(),
  bottleneckExplanation: z.string(),
  optimizations: z.array(z.object({
    target: z.string(),
    suggestion: z.string(),
    estimatedSaving: z.string(),
  })),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  ingest: ingestSchema,
  analysis: analysisSchema,
  report: reportSchema,
});

const analyzer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep, bash },
  instructions: `You are a trace analysis expert. Given ingested spans, identify the
primary bottleneck, the hot path through the trace, and any spans that consumed
disproportionate tokens or time. Be precise and data-driven.`,
});

export default smithers((ctx) => {
  const ingest = ctx.outputMaybe("ingest", { nodeId: "ingest" });
  const analysis = ctx.outputMaybe("analysis", { nodeId: "analyze" });

  const traceSource = ctx.input.traceFile ?? ctx.input.traceDir ?? ".";

  return (
    <Workflow name="trace-explainer">
      <Sequence>
        {/* 1. Ingest: read trace store and normalise spans */}
        <Task id="ingest" output={outputs.ingest} agent={analyzer}>
          <IngestPrompt source={traceSource} />
        </Task>

        {/* 2. Analyze: find bottlenecks, hot paths, token hogs */}
        {ingest && (
          <Task id="analyze" output={outputs.analysis} agent={analyzer}>
            <AnalyzePrompt
              spans={ingest.spans}
              totalDurationMs={ingest.totalDurationMs}
              totalTokens={ingest.totalTokens}
              failedSpanCount={ingest.failedSpanCount}
            />
          </Task>
        )}

        {/* 3. Report: produce actionable optimization report */}
        {analysis && ingest && (
          <Task id="report" output={outputs.report}>
            <ReportPrompt
              bottleneck={analysis.bottleneck}
              hotPath={analysis.hotPath}
              failureSummary={analysis.failureSummary}
              tokenHogs={analysis.tokenHogs}
              totalDurationMs={ingest.totalDurationMs}
              totalTokens={ingest.totalTokens}
            />
          </Task>
        )}
      </Sequence>
    </Workflow>
  );
});
