/**
 * Rerun a command and escalate only when its exit code, output or timing becomes notable.
 *
 * Port of the 0.x `command-watchdog.jsx`. Each round a runner agent runs the
 * command, told the previous round's exit code and duration, and a detector
 * agent compares that run with the one before against a duration threshold
 * (default 25%). A notable round ends the loop and a reporter agent writes the
 * escalation report; after `maxRuns` quiet rounds (default 5) the flow settles
 * with a static steady report.
 *
 * 0.x's `<Loop until={notable} maxIterations={maxRuns}>` is unrolled from the payload bound, as in `flake-hunter`.
 * `DriftDetector` does not fit: its baseline is a fixed literal, while 0.x compares each run with the run before it.
 * 0.x ran its rounds back to back with no scheduler, and so does this port; a host schedules the flow itself, for example with an `@smthrs/triggers` `Cron` trigger.
 * 0.x's prompts were placeholders that dumped their props; these are minimal prompts over the same props.
 * 0.x gave the agents `bash`, `read` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** One run of the command, as the runner reports it. */
export const RunResult = Schema.Struct({
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  outputSignature: Schema.String,
  stdoutTail: Schema.String,
  iterationNum: Schema.Number
})

/** The detector's verdict on one run. */
export const Notability = Schema.Struct({
  notable: Schema.Boolean,
  reasons: Schema.Array(Schema.String),
  exitCodeChanged: Schema.Boolean,
  durationDeltaPercent: Schema.Number,
  signatureChanged: Schema.Boolean,
  diffSummary: Schema.String
})

/** The report the flow settles with. */
export const Report = Schema.Struct({
  status: Schema.Literals(["steady", "escalated"]),
  anomalies: Schema.Array(Schema.String),
  runCount: Schema.Number,
  summary: Schema.String
})

/** Runs the command once. */
export const RunCommand = AgentAction.make("examples/CommandWatchdog/Run", {
  payload: {
    command: Schema.String,
    iteration: Schema.Number,
    previousDurationMs: Schema.optional(Schema.Number),
    previousExitCode: Schema.optional(Schema.Number)
  },
  output: RunResult,
  seat,
  system: [
    `You are a command executor. Run the given command, capture its exit code,
measure wall-clock duration, and produce a short signature of the output (e.g. hash of
key lines or a recognisable fingerprint). Return the structured result.`
  ],
  prompt: ({ command, iteration, previousDurationMs, previousExitCode }) =>
    `Run iteration ${iteration} of the watched command.\n\nCommand: ${command}\nPrevious exit code: ${
      previousExitCode ?? "none"
    }\nPrevious duration (ms): ${previousDurationMs ?? "none"}`
})

/** Compares the latest run with the one before it. */
export const Detect = AgentAction.make("examples/CommandWatchdog/Detect", {
  payload: {
    command: Schema.String,
    iteration: Schema.Number,
    thresholdPercent: Schema.Number,
    current: RunResult,
    previous: Schema.optional(RunResult)
  },
  output: Notability,
  seat,
  system: [
    `You are an anomaly detector. Compare the latest command run against previous
runs. Flag anything notable: non-zero exit codes, duration regressions beyond threshold,
changed output signatures, or meaningful diffs in stdout. Be precise about why something
is notable and avoid false positives.`
  ],
  prompt: ({ command, current, iteration, previous, thresholdPercent }) =>
    `Check iteration ${iteration} of the watched command for notable changes.\n\nCommand: ${command}\nDuration threshold: ${thresholdPercent}%\nCurrent run: ${
      JSON.stringify(current)
    }\nPrevious run: ${previous === undefined ? "none" : JSON.stringify(previous)}`
})

/** Writes the escalation report once a run is notable. */
export const Escalate = AgentAction.make("examples/CommandWatchdog/Report", {
  payload: {
    command: Schema.String,
    notable: Schema.Boolean,
    reasons: Schema.Array(Schema.String),
    runs: Schema.Array(RunResult),
    diffSummary: Schema.String
  },
  output: Report,
  seat,
  system: [
    `You are an escalation reporter. Summarise the anomalies detected during
the watchdog loop into a concise, actionable report suitable for on-call engineers or
CI dashboards. Include root-cause hints when possible.`
  ],
  prompt: ({ command, diffSummary, notable, reasons, runs }) =>
    `Report on the watched command.\n\nCommand: ${command}\nNotable: ${notable}\nReasons: ${
      JSON.stringify(reasons)
    }\nDiff summary: ${diffSummary}\nRuns: ${JSON.stringify(runs)}`
})

type RunResult = typeof RunResult.Type
type Report = typeof Report.Type

type Requirements = Action.Requirement<
  "examples/CommandWatchdog/Run" | "examples/CommandWatchdog/Detect" | "examples/CommandWatchdog/Report"
>

interface Bounds {
  readonly command: string
  readonly maxRuns: number
  readonly thresholdPercent: number
}

/**
 * Round `iteration`: run, detect, then report if notable, settle steady after
 * the last round, or go again. `runs` holds planned references to every run
 * so far, so the report reads them only once they have run.
 */
const round = (
  bounds: Bounds,
  iteration: number,
  previous: Planned.Planned<RunResult> | undefined,
  runs: ReadonlyArray<Planned.Planned<RunResult>>
): Node.Node<Report, AgentAction.AgentFailure, Requirements> => {
  const { command, maxRuns, thresholdPercent } = bounds
  return Node.bindPlanned(
    RunCommand.call({
      command,
      iteration,
      previousDurationMs: previous?.durationMs,
      previousExitCode: previous?.exitCode
    }),
    (current: Planned.Planned<RunResult>) =>
      Node.branch(Detect.call({ command, iteration, thresholdPercent, current, previous }), {
        if: (notability) => notability.notable,
        then: (notability) =>
          Escalate.call({
            command,
            notable: notability.notable,
            reasons: notability.reasons,
            runs: [...runs, current],
            diffSummary: notability.diffSummary
          }),
        else: () =>
          iteration >= maxRuns
            ? Node.succeed({
              status: "steady" as const,
              anomalies: [],
              runCount: iteration,
              summary: `${command} ran ${iteration} times with no notable anomalies`
            })
            : round(bounds, iteration + 1, current, [...runs, current])
      })
  )
}

/** The flow. `maxRuns` is real at plan time, so it sets how many rounds the plan holds. */
export const CommandWatchdog = Flow.make("examples/CommandWatchdog", {
  payload: {
    command: Schema.String,
    maxRuns: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    thresholdPercent: Schema.optional(Schema.Number)
  },
  success: Report,
  error: AgentAction.AgentFailure,
  body: ({ command, maxRuns = 5, thresholdPercent = 25 }) =>
    round({ command, maxRuns, thresholdPercent }, 1, undefined, [])
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(RunCommand.layer, Detect.layer, Escalate.layer)
