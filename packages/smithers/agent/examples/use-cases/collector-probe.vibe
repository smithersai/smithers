/**
 * Probe an agent endpoint, aggregate its timing, cost and quality, and report while those drift.
 *
 * Port of the 0.x `collector-probe.jsx`. Each round an agent invokes the
 * endpoint and records the call's telemetry, a collector agent aggregates
 * every call so far, and an anomaly agent compares the aggregates with the
 * baselines. The loop goes on while drift persists and stops at the first
 * round without it or after `maxIterations` (default 5); a static report then
 * counts drift events and lists the alerts.
 *
 * 0.x declared the invocation step with a prompt but no agent, so it could not produce its row; here an agent makes the call and reports its telemetry, as that prompt asks.
 * 0.x's `<Loop until={noMoreDrift} maxIterations>` is unrolled from the payload bound, as in `flake-hunter`. `Sidecar` and `DriftDetector` do not fit: 0.x runs no shadow call, and each round compares running aggregates rather than one capture.
 * 0.x's prompts were placeholders that dumped their props; these are minimal prompts over the same props.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const Severity = Schema.Literals(["info", "warning", "critical"])

/** The values drift is measured against. */
export const Baselines = Schema.Struct({
  quality: Schema.Number,
  costUsd: Schema.Number,
  latencyMs: Schema.Number
})

/** The telemetry of one probed call. */
export const Invocation = Schema.Struct({
  callId: Schema.String,
  model: Schema.String,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  latencyMs: Schema.Number,
  costUsd: Schema.Number,
  qualityScore: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  timestamp: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String))
})

/** Running statistics over every call so far. */
export const Aggregates = Schema.Struct({
  meanLatencyMs: Schema.Number,
  p95LatencyMs: Schema.Number,
  meanCostUsd: Schema.Number,
  meanQuality: Schema.Number,
  totalInvocations: Schema.Number
})

/** The collector's aggregation. */
export const Collection = Schema.Struct({
  samples: Schema.Array(Schema.Struct({
    callId: Schema.String,
    latencyMs: Schema.Number,
    costUsd: Schema.Number,
    qualityScore: Schema.Number
  })),
  aggregates: Aggregates,
  summary: Schema.String
})

/** The anomaly detector's verdict on one round. */
export const Anomaly = Schema.Struct({
  driftDetected: Schema.Boolean,
  anomalies: Schema.Array(Schema.Struct({
    metric: Schema.Literals(["quality", "cost", "latency"]),
    direction: Schema.Literals(["up", "down"]),
    deltaPercent: Schema.Number,
    baselineValue: Schema.Number,
    currentValue: Schema.Number,
    severity: Severity
  })),
  shouldAlert: Schema.Boolean,
  summary: Schema.String
})

/** The report the flow settles with. */
export const Report = Schema.Struct({
  overallStatus: Schema.Literals(["healthy", "degraded", "critical"]),
  totalInvocations: Schema.Number,
  iterationsRun: Schema.Number,
  anomaliesDetected: Schema.Number,
  alerts: Schema.Array(Schema.Struct({ metric: Schema.String, message: Schema.String, severity: Severity })),
  recommendations: Schema.Array(Schema.String),
  summary: Schema.String
})

/** Invokes the endpoint once and records the call's telemetry. */
export const Invoke = AgentAction.make("examples/CollectorProbe/Invoke", {
  payload: {
    endpoint: Schema.String,
    payload: Schema.optional(Schema.Json),
    baselines: Baselines,
    iteration: Schema.Number
  },
  output: Invocation,
  seat,
  prompt: ({ baselines, endpoint, iteration, payload }) =>
    `Invoke the probed endpoint and record the call's telemetry (iteration ${iteration}).\n\nEndpoint: ${endpoint}\nPayload: ${
      JSON.stringify(payload ?? null)
    }\nBaselines: ${JSON.stringify(baselines)}`
})

/** Aggregates every call so far. */
export const Collect = AgentAction.make("examples/CollectorProbe/Collect", {
  payload: { invocations: Schema.Array(Invocation), previousAggregates: Schema.NullOr(Aggregates) },
  output: Collection,
  seat,
  system: [
    `You are a telemetry collector. Given raw invocation data, aggregate
timing, cost, and quality metrics. Compute running statistics (mean, p95) across
the sample window. Be precise with numbers and preserve all sample data.`
  ],
  prompt: ({ invocations, previousAggregates }) =>
    `Aggregate the telemetry of these invocations.\n\nInvocations: ${
      JSON.stringify(invocations)
    }\nPrevious aggregates: ${JSON.stringify(previousAggregates)}`
})

/** Compares the aggregates with the baselines. */
export const Detect = AgentAction.make("examples/CollectorProbe/Anomaly", {
  payload: { aggregates: Aggregates, baselines: Baselines, previousAnomalies: Schema.Array(Anomaly) },
  output: Anomaly,
  seat,
  system: [
    `You are an anomaly detector for AI agent telemetry. Compare current
aggregates against the provided baselines. Flag drift when quality drops more than 5%,
cost rises more than 15%, or latency rises more than 25%. Set shouldAlert to true only
when at least one anomaly reaches warning or critical severity.`
  ],
  prompt: ({ aggregates, baselines, previousAnomalies }) =>
    `Compare the current aggregates with the baselines.\n\nAggregates: ${JSON.stringify(aggregates)}\nBaselines: ${
      JSON.stringify(baselines)
    }\nPrevious anomalies: ${JSON.stringify(previousAnomalies)}`
})

type Baselines = typeof Baselines.Type
type Invocation = typeof Invocation.Type
type Collection = typeof Collection.Type
type Anomaly = typeof Anomaly.Type
type Report = typeof Report.Type

type Requirements = Action.Requirement<
  "examples/CollectorProbe/Invoke" | "examples/CollectorProbe/Collect" | "examples/CollectorProbe/Anomaly"
>

/**
 * Counts and lists what every round found. Each round makes one invocation
 * and one collection, so both counts are `iterations`. Pure, so it is a
 * `Node.map`, not a step.
 */
const report = (
  { anomalies, iterations }: { readonly iterations: number; readonly anomalies: ReadonlyArray<Anomaly> }
): Report => {
  const drifted = anomalies.filter((a) => a.driftDetected).length
  return {
    overallStatus: anomalies.some((a) => a.anomalies.some((x) => x.severity === "critical"))
      ? "critical"
      : drifted > 0
      ? "degraded"
      : "healthy",
    totalInvocations: iterations,
    iterationsRun: iterations,
    anomaliesDetected: drifted,
    alerts: anomalies.filter((a) => a.shouldAlert).flatMap((a) =>
      a.anomalies.map((x) => ({
        metric: x.metric,
        message: `${x.metric} drifted ${x.direction} by ${x.deltaPercent}% (${x.baselineValue} -> ${x.currentValue})`,
        severity: x.severity
      }))
    ),
    recommendations: drifted > 0
      ? [
        "Review model configuration for quality regression",
        "Check upstream latency contributors",
        "Consider adjusting cost thresholds if usage patterns changed"
      ]
      : ["All metrics within acceptable thresholds"],
    summary:
      `Collector probe ran ${iterations} iterations over ${iterations} invocations. ${drifted} drift events detected.`
  }
}

interface Probe {
  readonly endpoint: string
  readonly payload: Schema.Json | undefined
  readonly baselines: Baselines
  readonly maxIterations: number
}

/**
 * Round `iteration`: invoke, aggregate every call so far, detect; report once
 * a round finds no drift or the last round has run, otherwise go again.
 */
const round = (
  probe: Probe,
  iteration: number,
  invocations: ReadonlyArray<Planned.Planned<Invocation>>,
  previous: Planned.Planned<Collection> | undefined,
  anomalies: ReadonlyArray<Planned.Planned<Anomaly>>
): Node.Node<Report, AgentAction.AgentFailure, Requirements> => {
  const { baselines, endpoint, maxIterations, payload } = probe
  return Node.bindPlanned(
    Invoke.call({ endpoint, payload, baselines, iteration }),
    (invocation: Planned.Planned<Invocation>) =>
      Node.bindPlanned(
        Collect.call({
          invocations: [...invocations, invocation],
          previousAggregates: previous === undefined ? null : previous.aggregates
        }),
        (collection: Planned.Planned<Collection>) =>
          Node.branch(Detect.call({ aggregates: collection.aggregates, baselines, previousAnomalies: anomalies }), {
            if: (anomaly) => !anomaly.driftDetected,
            then: (anomaly) =>
              Node.map(Node.succeed({ iterations: iteration, anomalies: [...anomalies, anomaly] }), report),
            else: (anomaly) =>
              iteration >= maxIterations
                ? Node.map(Node.succeed({ iterations: iteration, anomalies: [...anomalies, anomaly] }), report)
                : round(probe, iteration + 1, [...invocations, invocation], collection, [...anomalies, anomaly])
          })
      )
  )
}

/** The flow. `maxIterations` is real at plan time, so it sets how many rounds the plan holds. */
export const CollectorProbe = Flow.make("examples/CollectorProbe", {
  payload: {
    endpoint: Schema.String,
    payload: Schema.optional(Schema.Json),
    baselines: Schema.optional(Baselines),
    maxIterations: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0)))
  },
  success: Report,
  error: AgentAction.AgentFailure,
  body: ({ baselines = { quality: 0.92, costUsd: 0.02, latencyMs: 500 }, endpoint, maxIterations = 5, payload }) =>
    round({ endpoint, payload, baselines, maxIterations }, 1, [], undefined, [])
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(Invoke.layer, Collect.layer, Detect.layer)
