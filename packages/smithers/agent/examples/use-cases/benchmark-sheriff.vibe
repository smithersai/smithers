/**
 * Run benchmarks against a stored baseline and ask an agent to explain only material regressions.
 *
 * Port of the 0.x `benchmark-sheriff.jsx`. A runner agent runs the benchmark
 * command, and the flow diffs each baselined benchmark against the run. Only
 * when one slowed by at least `thresholdPercent` (default 5%) does an analyst
 * agent explain the regressions; the flow then settles `regressed`, otherwise
 * `clean`, with no model call after the run.
 *
 * The run, diff and analysis are `DriftDetector`'s capture, compare and alert: the payload's baseline and threshold are its declared baseline.
 * 0.x's diff flag `exceeded` is named `drifted` here, the field `DriftDetector` reads.
 * 0.x stored the analysis in its own table; a 1.0 flow returns one value, so the regressed result carries it.
 * 0.x gave the agents a `bash` tool; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow } from "@smthrs/flow"
import * as DriftDetector from "@smthrs/patterns/DriftDetector"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** One benchmark's value. */
export const Benchmark = Schema.Struct({ name: Schema.String, valueMs: Schema.Number })

/** The runner's parsed results. */
export const BenchmarkRun = Schema.Struct({
  benchmarks: Schema.Array(Benchmark),
  raw: Schema.String
})

/** One benchmark that slowed past the threshold. */
export const Regression = Schema.Struct({
  name: Schema.String,
  baselineMs: Schema.Number,
  currentMs: Schema.Number,
  deltaPercent: Schema.Number
})

/** The diff against the baseline. */
export const Diff = Schema.Struct({
  regressions: Schema.Array(Regression),
  drifted: Schema.Boolean
})

/** The analyst's explanation. */
export const Analysis = Schema.Struct({
  findings: Schema.Array(Schema.Struct({
    benchmark: Schema.String,
    likelyCause: Schema.String,
    severity: Schema.Literals(["low", "medium", "high"])
  })),
  summary: Schema.String
})

/** What the flow settles with. `analysis` is present exactly when the run regressed. */
export const Output = Schema.Struct({
  status: Schema.Literals(["clean", "regressed"]),
  regressionCount: Schema.Number,
  summary: Schema.String,
  analysis: Schema.optional(Analysis)
})

/** Runs the benchmark command and parses its metrics. */
export const RunBenchmarks = AgentAction.make("examples/BenchmarkSheriff/Run", {
  payload: { command: Schema.String, cwd: Schema.String },
  output: BenchmarkRun,
  seat,
  system: [
    `You are a benchmark runner. Execute the given benchmark command,
parse the output, and return structured metric values.`
  ],
  prompt: ({ command, cwd }) =>
    `Run the following benchmark command and capture the results:\n\nCommand: ${command}\nWorking directory: ${cwd}\n\nExecute the command and report the raw metric outputs.`
})

/** Explains the regressions. Asked only when one passed the threshold. */
export const Analyze = AgentAction.make("examples/BenchmarkSheriff/Analyze", {
  payload: { threshold: Schema.Number, regressions: Schema.Array(Regression) },
  output: Analysis,
  seat,
  system: [
    `You are a performance analyst. Given benchmark regressions,
investigate root causes by inspecting recent changes, resource usage, or
measurement methodology. Be specific and actionable.`
  ],
  prompt: ({ regressions, threshold }) =>
    `The following benchmarks regressed beyond the ${threshold}% threshold:\n\n${
      JSON.stringify(regressions)
    }\n\nBaseline and current values are provided. Investigate the likely causes of each\nregression. Focus on actionable explanations — code changes, resource contention,\nor measurement noise. Be concise.`
})

type Benchmark = typeof Benchmark.Type
type BenchmarkRun = typeof BenchmarkRun.Type
type Diff = typeof Diff.Type
type Analysis = typeof Analysis.Type
type Output = typeof Output.Type

type Requirements = Action.Requirement<"examples/BenchmarkSheriff/Run" | "examples/BenchmarkSheriff/Analyze">

/** The detector's declared baseline: the stored values and the threshold they are held to. */
interface Baseline {
  readonly benchmarks: ReadonlyArray<Benchmark>
  readonly thresholdPercent: number
}

/** What one detection settles with, as `DriftDetector.Result` describes it. */
type Detection = DriftDetector.Result<BenchmarkRun, Diff, Analysis>

/**
 * Diffs every baselined benchmark the run reported. A benchmark missing from
 * the run is skipped, and only slowdowns at or past the threshold count, as in
 * 0.x. Pure, so it is a `Node.map`, not a step.
 */
const diff = ({ baseline, snapshot }: { readonly snapshot: BenchmarkRun; readonly baseline: Baseline }): Diff => {
  const regressions = baseline.benchmarks.flatMap((b) => {
    const current = snapshot.benchmarks.find((r) => r.name === b.name)
    if (current === undefined) return []
    const delta = ((current.valueMs - b.valueMs) / b.valueMs) * 100
    return [{
      name: b.name,
      baselineMs: b.valueMs,
      currentMs: current.valueMs,
      deltaPercent: Math.round(delta * 100) / 100
    }]
  }).filter((r) => r.deltaPercent >= baseline.thresholdPercent)
  return { regressions, drifted: regressions.length > 0 }
}

/** The result for a detection. Pure, so it is a `Node.map`, not a step. */
const settle = ({ detection, threshold }: { readonly detection: Detection; readonly threshold: number }): Output =>
  detection.drifted
    ? {
      status: "regressed",
      regressionCount: detection.comparison.regressions.length,
      summary: `${detection.comparison.regressions.length} benchmark(s) exceeded the ${threshold}% threshold`,
      ...(detection.alert === undefined ? {} : { analysis: detection.alert })
    }
    : { status: "clean", regressionCount: 0, summary: `All benchmarks within the ${threshold}% threshold` }

/** The detector: run, diff against `baseline`, and explain only a drifted diff. */
const detector = (baseline: Baseline) =>
  DriftDetector.make<Requirements>({
    name: "examples/BenchmarkSheriff/Detect",
    baseline,
    capture: {
      call: ({ input }: { readonly input: { readonly command: string; readonly cwd: string } }) =>
        RunBenchmarks.call(input)
    },
    compare: {
      call: (compared: { readonly snapshot: Planned.Planned<BenchmarkRun>; readonly baseline: Baseline }) =>
        Node.map(Node.succeed(compared), diff)
    },
    alert: {
      call: ({ baseline, comparison }: { readonly comparison: Planned.Planned<Diff>; readonly baseline: Baseline }) =>
        Analyze.call({ threshold: baseline.thresholdPercent, regressions: comparison.regressions })
    }
  })

/** The flow: detect, then settle `regressed` or `clean`. */
export const BenchmarkSheriff = Flow.make("examples/BenchmarkSheriff", {
  payload: {
    command: Schema.optional(Schema.String),
    cwd: Schema.optional(Schema.String),
    baseline: Schema.optional(Schema.Array(Benchmark)),
    thresholdPercent: Schema.optional(Schema.Number)
  },
  success: Output,
  error: AgentAction.AgentFailure,
  body: ({ baseline = [], command = "npm run bench", cwd = ".", thresholdPercent = 5 }) => {
    // `DriftDetector.make` declares a loosely typed flow. Its members above are
    // this port's own typed steps, so its result is the `Detection` they make
    // and its only failure is theirs.
    const detected = detector({ benchmarks: baseline, thresholdPercent }).call({
      input: { command, cwd }
    }) as Node.Node<Detection, AgentAction.AgentFailure, Requirements>
    return Node.bindPlanned(
      detected,
      (detection: Planned.Planned<Detection>) =>
        Node.map(Node.succeed({ detection, threshold: thresholdPercent }), settle)
    )
  }
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(RunBenchmarks.layer, Analyze.layer)
