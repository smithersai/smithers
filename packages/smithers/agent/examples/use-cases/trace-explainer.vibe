/**
 * Read run traces and explain where time, tokens or failures accumulated.
 *
 * Port of the 0.x `trace-explainer.jsx`. An analyzer agent ingests the traces
 * at `traceFile`, else `traceDir`, else `.`, and normalizes their spans; the
 * same agent finds the bottleneck, hot path and token hogs in those spans; a
 * report step turns that analysis into an optimization report. The steps run
 * in sequence, and any failure fails the run.
 *
 * 0.x declared the report step with a prompt but no agent, so it could not produce its row; here an agent writes it, as that prompt asks.
 * 0.x's prompts were placeholders that dumped their props; these are minimal prompts over the same props.
 * 0.x gave the analyzer `read`, `grep` and `bash` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`). A host can hand it a run's spans from `smthrs runs logs --format json` or the OTLP export of `10-telemetry-export.ts`.
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const analyzer = [
  `You are a trace analysis expert. Given ingested spans, identify the
primary bottleneck, the hot path through the trace, and any spans that consumed
disproportionate tokens or time. Be precise and data-driven.`
]

/** One normalized span. */
export const Span = Schema.Struct({
  name: Schema.String,
  durationMs: Schema.Number,
  tokenCount: Schema.optional(Schema.Number),
  failed: Schema.Boolean,
  error: Schema.optional(Schema.String),
  children: Schema.optional(Schema.Array(Schema.String))
})

/** Every span the traces hold, with their totals. */
export const Ingested = Schema.Struct({
  spans: Schema.Array(Span),
  totalDurationMs: Schema.Number,
  totalTokens: Schema.Number,
  failedSpanCount: Schema.Number
})

/** Where the trace spent its time and tokens. */
export const Analysis = Schema.Struct({
  bottleneck: Schema.Struct({
    spanName: Schema.String,
    reason: Schema.Literals(["latency", "tokens", "failure", "retry-storm"]),
    impact: Schema.String
  }),
  hotPath: Schema.Array(Schema.String),
  failureSummary: Schema.NullOr(Schema.String),
  tokenHogs: Schema.Array(Schema.Struct({
    spanName: Schema.String,
    tokenCount: Schema.Number,
    percentOfTotal: Schema.Number
  }))
})

/** The optimization report the flow settles with. */
export const Report = Schema.Struct({
  title: Schema.String,
  bottleneckExplanation: Schema.String,
  optimizations: Schema.Array(Schema.Struct({
    target: Schema.String,
    suggestion: Schema.String,
    estimatedSaving: Schema.String
  })),
  summary: Schema.String
})

/** Reads the trace store and normalizes its spans. */
export const Ingest = AgentAction.make("examples/TraceExplainer/Ingest", {
  payload: { source: Schema.String },
  output: Ingested,
  seat,
  system: analyzer,
  prompt: ({ source }) => `Ingest the traces at ${source} and normalize their spans.`
})

/** Finds the bottleneck, hot path and token hogs. */
export const Analyze = AgentAction.make("examples/TraceExplainer/Analyze", {
  payload: {
    spans: Schema.Array(Span),
    totalDurationMs: Schema.Number,
    totalTokens: Schema.Number,
    failedSpanCount: Schema.Number
  },
  output: Analysis,
  seat,
  system: analyzer,
  prompt: ({ failedSpanCount, spans, totalDurationMs, totalTokens }) =>
    `Analyze these spans.\n\nTotal duration (ms): ${totalDurationMs}\nTotal tokens: ${totalTokens}\nFailed spans: ${failedSpanCount}\nSpans: ${
      JSON.stringify(spans)
    }`
})

/** Turns the analysis into an optimization report. */
export const Explain = AgentAction.make("examples/TraceExplainer/Report", {
  payload: {
    bottleneck: Analysis.fields.bottleneck,
    hotPath: Analysis.fields.hotPath,
    failureSummary: Analysis.fields.failureSummary,
    tokenHogs: Analysis.fields.tokenHogs,
    totalDurationMs: Schema.Number,
    totalTokens: Schema.Number
  },
  output: Report,
  seat,
  prompt: ({ bottleneck, failureSummary, hotPath, tokenHogs, totalDurationMs, totalTokens }) =>
    `Write the optimization report for this trace analysis.\n\nBottleneck: ${JSON.stringify(bottleneck)}\nHot path: ${
      JSON.stringify(hotPath)
    }\nFailure summary: ${failureSummary ?? "none"}\nToken hogs: ${
      JSON.stringify(tokenHogs)
    }\nTotal duration (ms): ${totalDurationMs}\nTotal tokens: ${totalTokens}`
})

/** The flow: ingest, analyze, report. */
export const TraceExplainer = Flow.make("examples/TraceExplainer", {
  payload: { traceFile: Schema.optional(Schema.String), traceDir: Schema.optional(Schema.String) },
  success: Report,
  error: AgentAction.AgentFailure,
  body: ({ traceDir, traceFile }) =>
    Node.bindPlanned(
      Ingest.call({ source: traceFile ?? traceDir ?? "." }),
      (ingested: Planned.Planned<typeof Ingested.Type>) =>
        Node.bindPlanned(
          Analyze.call({
            spans: ingested.spans,
            totalDurationMs: ingested.totalDurationMs,
            totalTokens: ingested.totalTokens,
            failedSpanCount: ingested.failedSpanCount
          }),
          (analysis: Planned.Planned<typeof Analysis.Type>) =>
            Explain.call({
              bottleneck: analysis.bottleneck,
              hotPath: analysis.hotPath,
              failureSummary: analysis.failureSummary,
              tokenHogs: analysis.tokenHogs,
              totalDurationMs: ingested.totalDurationMs,
              totalTokens: ingested.totalTokens
            })
        )
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(Ingest.layer, Analyze.layer, Explain.layer)
