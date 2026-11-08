/**
 * Probe MCP servers each round and report only while availability or capabilities change materially.
 *
 * Port of the 0.x `mcp-health-probe.jsx`. Each round a scheduler agent rules
 * on the probe interval, a prober agent exercises every server (at most
 * `maxConcurrency` at a time, default 5) against its baseline capabilities,
 * and a checker agent compares every probe so far with the previous baseline.
 * A material change sends a reporter agent to write a report and starts the
 * next round; the first round without one ends the loop, as does
 * `maxIterations` (default 5).
 *
 * 0.x ran the probes whatever the scheduler's `shouldProbe` said, and so does this port.
 * 0.x's `<Loop until={noMaterialChange}>` is unrolled from the payload bound, and its `<Parallel maxConcurrency>` over the payload's servers is `Bounded.all`.
 * `DriftDetector` does not fit: 0.x's checker reads every probe of every round, not one capture against a fixed baseline.
 * 0.x returned no value of its own; this flow settles with the round count, the last check and every report written.
 * 0.x's prompts were placeholders that dumped their props; these are minimal prompts over the same props.
 * 0.x gave the agents `bash`, `read`, `grep` and `write` tools; in 1.0 tools, MCP servers included, are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow } from "@smthrs/flow"
import * as Bounded from "@smthrs/patterns/Bounded"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** The scheduler's ruling. */
export const ScheduleDecision = Schema.Struct({
  shouldProbe: Schema.Boolean,
  reason: Schema.String,
  intervalMs: Schema.Number
})

/** One server's probe. */
export const ProbeResult = Schema.Struct({
  server: Schema.String,
  healthy: Schema.Boolean,
  latencyMs: Schema.Number,
  capabilities: Schema.Array(Schema.String),
  capabilityDrift: Schema.Boolean,
  driftDetails: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String)
})

/** The checker's verdict on every probe so far. */
export const Check = Schema.Struct({
  materialChange: Schema.Boolean,
  unhealthyServers: Schema.Array(Schema.String),
  driftedServers: Schema.Array(Schema.String),
  newIssues: Schema.Array(Schema.String),
  resolvedIssues: Schema.Array(Schema.String)
})

/** One report the reporter wrote. */
export const Report = Schema.Struct({
  reported: Schema.Boolean,
  summary: Schema.String,
  details: Schema.String,
  recommendations: Schema.Array(Schema.String)
})

/** What the flow settles with. */
export const Outcome = Schema.Struct({
  iterations: Schema.Number,
  check: Check,
  reports: Schema.Array(Report)
})

/** Rules on whether the interval has passed. */
export const Schedule = AgentAction.make("examples/McpHealthProbe/Schedule", {
  payload: { intervalMs: Schema.Number, lastRun: Schema.optional(Schema.String), iteration: Schema.Number },
  output: ScheduleDecision,
  seat,
  system: [
    `You are a scheduling agent. Determine whether it is time to probe
MCP servers based on the configured interval and last probe timestamp. Check system
time and compare against the last run.`
  ],
  prompt: ({ intervalMs, iteration, lastRun }) =>
    `Decide whether to probe the MCP servers now (iteration ${iteration}).\n\nInterval (ms): ${intervalMs}\nLast run: ${
      lastRun ?? "never"
    }`
})

/** Exercises one server. */
export const Probe = AgentAction.make("examples/McpHealthProbe/Probe", {
  payload: {
    server: Schema.String,
    baselineCapabilities: Schema.Array(Schema.String),
    latencyThresholdMs: Schema.Number
  },
  output: ProbeResult,
  seat,
  system: [
    `You are an MCP health prober. Exercise the given MCP server by listing
its tools and invoking a lightweight canary call. Measure latency, check whether the
tool list matches the known baseline, and flag any capability drift. Be precise with
latency measurements and capability comparisons.`
  ],
  prompt: ({ baselineCapabilities, latencyThresholdMs, server }) =>
    `Probe the MCP server ${server}.\n\nBaseline capabilities: ${
      JSON.stringify(baselineCapabilities)
    }\nLatency threshold (ms): ${latencyThresholdMs}`
})

/** Compares every probe so far with the previous baseline. */
export const CheckResults = AgentAction.make("examples/McpHealthProbe/Check", {
  payload: {
    probeResults: Schema.Array(ProbeResult),
    previousBaseline: Schema.optional(Schema.Json),
    latencyThresholdMs: Schema.Number
  },
  output: Check,
  seat,
  system: [
    `You are a results analyst. Compare the current probe results against
the previous baseline. Determine whether any change is material — an outage, a new
capability appearing or disappearing, or a latency regression beyond the threshold.
Only flag material changes; ignore noise.`
  ],
  prompt: ({ latencyThresholdMs, previousBaseline, probeResults }) =>
    `Check these probe results for material changes.\n\nProbe results: ${
      JSON.stringify(probeResults)
    }\nPrevious baseline: ${JSON.stringify(previousBaseline ?? null)}\nLatency threshold (ms): ${latencyThresholdMs}`
})

/** Writes the report for a material change. */
export const Reporter = AgentAction.make("examples/McpHealthProbe/Report", {
  payload: {
    check: Check,
    probeResults: Schema.Array(ProbeResult),
    outputPath: Schema.String,
    notifyChannel: Schema.optional(Schema.String)
  },
  output: Report,
  seat,
  system: [
    `You are a concise incident reporter. When material changes are detected,
produce a clear, actionable report with specific recommendations. If nothing material
changed, produce a short "all clear" note. Write reports to the configured output path.`
  ],
  prompt: ({ check, notifyChannel, outputPath, probeResults }) =>
    `Report the MCP health check.\n\nCheck: ${JSON.stringify(check)}\nProbe results: ${
      JSON.stringify(probeResults)
    }\nOutput path: ${outputPath}\nNotify channel: ${notifyChannel ?? "none"}`
})

type ProbeResult = typeof ProbeResult.Type
type Report = typeof Report.Type
type Outcome = typeof Outcome.Type

type ProbeRequirement = Action.Requirement<"examples/McpHealthProbe/Probe">
type Requirements = Action.Requirement<
  | "examples/McpHealthProbe/Schedule"
  | "examples/McpHealthProbe/Probe"
  | "examples/McpHealthProbe/Check"
  | "examples/McpHealthProbe/Report"
>

interface Options {
  readonly servers: ReadonlyArray<string>
  readonly maxIterations: number
  readonly intervalMs: number
  readonly lastRun: string | undefined
  readonly maxConcurrency: number
  readonly baselines: Readonly<Record<string, ReadonlyArray<string>>>
  readonly latencyThresholdMs: number
  readonly previousBaseline: Schema.Json | undefined
  readonly outputPath: string
  readonly notifyChannel: string | undefined
}

/** Probes every server, `maxConcurrency` at a time. The servers are payload, so the width is real at plan time. */
const probeAll = (
  options: Options
): Node.Node<Readonly<Record<string, unknown>>, AgentAction.AgentFailure, ProbeRequirement> =>
  options.servers.length === 0
    ? Node.succeed({})
    : Bounded.all(
      Object.fromEntries(options.servers.map((server) => [
        server,
        Probe.call({
          server,
          baselineCapabilities: options.baselines[server] ?? [],
          latencyThresholdMs: options.latencyThresholdMs
        })
      ])),
      { concurrency: options.maxConcurrency }
    )

/** Every probe so far: the earlier rounds' and this round's. Pure, so it is a `Node.map`, not a step. */
const accumulate = (
  { earlier, probed }: {
    readonly earlier: ReadonlyArray<ProbeResult>
    readonly probed: Readonly<Record<string, unknown>>
  }
): ReadonlyArray<ProbeResult> => [...earlier, ...Object.values(probed).filter(Schema.is(ProbeResult))]

/**
 * Round `iteration`: schedule, probe, check; settle on a check without a
 * material change, otherwise report and go again until the last round.
 */
const round = (
  options: Options,
  iteration: number,
  earlier: Planned.Planned<ReadonlyArray<ProbeResult>> | ReadonlyArray<never>,
  reports: ReadonlyArray<Planned.Planned<Report>>
): Node.Node<Outcome, AgentAction.AgentFailure, Requirements> =>
  // The probes read nothing the scheduler says, so `Node.andThen` only orders them after it.
  Node.andThen(
    Schedule.call({ intervalMs: options.intervalMs, lastRun: options.lastRun, iteration: iteration - 1 }),
    Node.bindPlanned(probeAll(options), (probed: Planned.Planned<Readonly<Record<string, unknown>>>) =>
      Node.bindPlanned(
        Node.map(Node.succeed({ earlier, probed }), accumulate),
        (probeResults: Planned.Planned<ReadonlyArray<ProbeResult>>) =>
          Node.branch(
            CheckResults.call({
              probeResults,
              previousBaseline: options.previousBaseline,
              latencyThresholdMs: options.latencyThresholdMs
            }),
            {
              if: (check) => check.materialChange === false,
              then: (check) => Node.succeed({ iterations: iteration, check, reports }),
              else: (check) =>
                Node.bindPlanned(
                  Reporter.call({
                    check,
                    probeResults,
                    outputPath: options.outputPath,
                    notifyChannel: options.notifyChannel
                  }),
                  (report: Planned.Planned<Report>) =>
                    iteration >= options.maxIterations
                      ? Node.succeed({ iterations: iteration, check, reports: [...reports, report] })
                      // The next round reads nothing the report says either; settling
                      // the report first keeps 0.x's order, where it began the next round.
                      : Node.andThen(
                        Node.succeed(report),
                        round(options, iteration + 1, probeResults, [...reports, report])
                      )
                )
            }
          )
      ))
  )

/** The flow. `servers` and `maxIterations` are real at plan time, so they set the plan's width and depth. */
export const McpHealthProbe = Flow.make("examples/McpHealthProbe", {
  payload: {
    servers: Schema.optional(Schema.Array(Schema.String)),
    maxIterations: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    intervalMs: Schema.optional(Schema.Number),
    lastRun: Schema.optional(Schema.String),
    maxConcurrency: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    baselines: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
    latencyThresholdMs: Schema.optional(Schema.Number),
    previousBaseline: Schema.optional(Schema.Json),
    outputPath: Schema.optional(Schema.String),
    notifyChannel: Schema.optional(Schema.String)
  },
  success: Outcome,
  error: AgentAction.AgentFailure,
  body: ({
    baselines = {},
    intervalMs = 300_000,
    lastRun,
    latencyThresholdMs = 5000,
    maxConcurrency = 5,
    maxIterations = 5,
    notifyChannel,
    outputPath = "./mcp-health-report.md",
    previousBaseline,
    servers = []
  }) =>
    round(
      {
        servers,
        maxIterations,
        intervalMs,
        lastRun,
        maxConcurrency,
        baselines,
        latencyThresholdMs,
        previousBaseline,
        outputPath,
        notifyChannel
      },
      1,
      [],
      []
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(Schedule.layer, Probe.layer, CheckResults.layer, Reporter.layer)
