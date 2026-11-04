/**
 * Compare stable and canary telemetry and issue a promote, hold or rollback verdict with its deploy command.
 *
 * Port of the 0.x `canary-judge.jsx`. One collector agent gathers the stable
 * and the canary stream's telemetry at once, over a window of `windowMinutes`
 * (default 15). A comparator agent computes the deltas and risk signals
 * against the given thresholds, and a judge agent decides promote, hold or
 * rollback. The last step turns the decision into the one `deployctl` command
 * and the channels to notify; it runs nothing.
 *
 * 0.x's `<Parallel maxConcurrency={2}>` over the two collections is `Node.all`.
 * 0.x's agentless `deploy` step is a pure `Node.map`: it only names the command, as 0.x did.
 * 0.x's prompts were placeholders that printed their props; these prompts carry the same props.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const Stream = Schema.Literals(["stable", "canary"])
const Decision = Schema.Literals(["promote", "hold", "rollback"])

/** One stream's telemetry. */
export const Telemetry = Schema.Struct({
  stream: Stream,
  latencyP50Ms: Schema.Number.annotate({ description: "Median latency in milliseconds" }),
  latencyP99Ms: Schema.Number.annotate({ description: "99th percentile latency in milliseconds" }),
  errorRate: Schema.Number.annotate({ description: "Error rate as a percentage" }),
  throughputRps: Schema.Number.annotate({ description: "Requests per second" }),
  logAnomalies: Schema.Array(Schema.String).annotate({ description: "Notable log patterns or anomalies" }),
  traceWarnings: Schema.Array(Schema.String).annotate({
    description: "Trace-level warnings (slow spans, retries, etc.)"
  })
})

/** How the canary differs from stable. */
export const Comparison = Schema.Struct({
  latencyDelta: Schema.Struct({
    p50Pct: Schema.Number.annotate({ description: "Percentage change in p50 latency (positive = regression)" }),
    p99Pct: Schema.Number.annotate({ description: "Percentage change in p99 latency" })
  }),
  errorRateDelta: Schema.Number.annotate({ description: "Absolute change in error rate (canary - stable)" }),
  throughputDelta: Schema.Number.annotate({ description: "Percentage change in throughput" }),
  newAnomalies: Schema.Array(Schema.String).annotate({ description: "Anomalies present in canary but not stable" }),
  riskSignals: Schema.Array(Schema.Struct({
    signal: Schema.String,
    severity: Schema.Literals(["critical", "high", "medium", "low"])
  })),
  summary: Schema.String
})

/** The judge's verdict. */
export const Verdict = Schema.Struct({
  decision: Decision,
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  reasons: Schema.Array(Schema.String),
  conditions: Schema.Array(Schema.String).annotate({
    description: "Conditions that must remain true for decision to hold"
  }),
  summary: Schema.String
})

/** The deploy action the flow settles with. */
export const DeployAction = Schema.Struct({
  action: Decision,
  commands: Schema.Array(Schema.String).annotate({ description: "Deploy control plane commands to execute" }),
  notifyChannels: Schema.Array(Schema.String),
  summary: Schema.String
})

/** Gathers one stream's telemetry. Both streams use this one collector. */
export const Collect = AgentAction.make("examples/CanaryJudge/Collect", {
  payload: {
    stream: Stream,
    metricsEndpoint: Schema.String,
    logSource: Schema.String,
    traceStore: Schema.String,
    windowMinutes: Schema.Number
  },
  output: Telemetry,
  seat,
  system: [
    `You are a telemetry collector for deployment streams. Query the provided
metrics endpoints, log sources, and trace stores to gather latency percentiles, error rates,
throughput, log anomalies, and trace warnings. Normalize all values for consistent comparison.`
  ],
  prompt: ({ logSource, metricsEndpoint, stream, traceStore, windowMinutes }) =>
    `Collect the ${stream} stream's telemetry over the last ${windowMinutes} minutes.\n\nMetrics endpoint: ${metricsEndpoint}\nLog source: ${logSource}\nTrace store: ${traceStore}`
})

/** Computes the deltas between the two streams. */
export const Compare = AgentAction.make("examples/CanaryJudge/Compare", {
  payload: {
    stable: Telemetry,
    canary: Telemetry,
    thresholds: Schema.Record(Schema.String, Schema.Json)
  },
  output: Comparison,
  seat,
  system: [
    `You are a deployment telemetry comparator. Given stable and canary telemetry
snapshots, compute deltas across all dimensions: latency, error rate, throughput. Identify
anomalies unique to the canary. Flag risk signals with severity levels. Be precise about
percentage changes and use statistical significance where sample sizes allow.`
  ],
  prompt: ({ canary, stable, thresholds }) =>
    `Compare the canary with stable.\n\nStable: ${JSON.stringify(stable)}\nCanary: ${
      JSON.stringify(canary)
    }\nThresholds: ${JSON.stringify(thresholds)}`
})

/** Decides promote, hold or rollback. */
export const Judge = AgentAction.make("examples/CanaryJudge/Judge", {
  payload: {
    comparison: Comparison,
    riskSignals: Comparison.fields.riskSignals,
    deploymentId: Schema.String,
    serviceName: Schema.String
  },
  output: Verdict,
  seat,
  system: [
    `You are a canary deployment judge. Based on the telemetry comparison, render a
promote/hold/rollback decision. Promote if all metrics are within acceptable thresholds. Hold if
there are moderate regressions that need observation. Rollback if there are critical regressions
or new error patterns. Provide a confidence score and list the conditions that must remain true.`
  ],
  prompt: ({ comparison, deploymentId, riskSignals, serviceName }) =>
    `Judge deployment ${deploymentId} of ${serviceName}.\n\nComparison: ${JSON.stringify(comparison)}\nRisk signals: ${
      JSON.stringify(riskSignals)
    }`
})

/** The command for a decision. Pure, so it is a `Node.map`, not a step. */
const deploy = (
  { deploymentId, notifyChannels, verdict }: {
    readonly verdict: typeof Verdict.Type
    readonly deploymentId: string
    readonly notifyChannels: ReadonlyArray<string>
  }
): typeof DeployAction.Type => ({
  action: verdict.decision,
  commands: [`deployctl ${verdict.decision} ${deploymentId}`],
  notifyChannels,
  summary: verdict.summary
})

type Streams = { readonly stable: typeof Telemetry.Type; readonly canary: typeof Telemetry.Type }

/** The flow: collect both streams at once, compare, judge, name the command. */
export const CanaryJudge = Flow.make("examples/CanaryJudge", {
  payload: {
    stableMetricsEndpoint: Schema.String,
    stableLogSource: Schema.String,
    stableTraceStore: Schema.String,
    canaryMetricsEndpoint: Schema.String,
    canaryLogSource: Schema.String,
    canaryTraceStore: Schema.String,
    windowMinutes: Schema.optional(Schema.Number),
    thresholds: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
    deploymentId: Schema.optional(Schema.String),
    serviceName: Schema.optional(Schema.String),
    notifyChannels: Schema.optional(Schema.Array(Schema.String))
  },
  success: DeployAction,
  error: AgentAction.AgentFailure,
  body: (
    {
      deploymentId = "unknown",
      notifyChannels = ["#deploys"],
      serviceName = "unknown",
      thresholds = {},
      windowMinutes = 15,
      ...input
    }
  ) =>
    Node.bindPlanned(
      Node.all({
        stable: Collect.call({
          stream: "stable",
          metricsEndpoint: input.stableMetricsEndpoint,
          logSource: input.stableLogSource,
          traceStore: input.stableTraceStore,
          windowMinutes
        }),
        canary: Collect.call({
          stream: "canary",
          metricsEndpoint: input.canaryMetricsEndpoint,
          logSource: input.canaryLogSource,
          traceStore: input.canaryTraceStore,
          windowMinutes
        })
      }),
      (streams: Planned.Planned<Streams>) =>
        Node.bindPlanned(
          Compare.call({ stable: streams.stable, canary: streams.canary, thresholds }),
          (comparison: Planned.Planned<typeof Comparison.Type>) =>
            Node.bindPlanned(
              Judge.call({ comparison, riskSignals: comparison.riskSignals, deploymentId, serviceName }),
              (verdict: Planned.Planned<typeof Verdict.Type>) =>
                Node.map(Node.succeed({ verdict, deploymentId, notifyChannels }), deploy)
            )
        )
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(Collect.layer, Compare.layer, Judge.layer)
