/**
 * Rerun a test a fixed number of times and report whether it is flaky.
 *
 * Port of the 0.x `flake-hunter.jsx`. A runner agent reruns the command
 * `runs` times (default 5), each attempt told the previous outcome. The runs
 * are packed into evidence, and only divergent evidence, some passes and some
 * failures, goes to the analyst agent. Consistent evidence gets a static
 * report with no model call.
 *
 * 0.x's `<Loop until={results.length >= maxRuns}>` always ran `maxRuns` times; here the plan unrolls exactly `runs` attempts.
 * 0.x gave the agents `bash`, `read` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const Outcome = Schema.Literals(["pass", "fail"])
const Fraction = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

/** One attempt's result, as the runner reports it. */
export const RunResult = Schema.Struct({
  attempt: Schema.Number,
  outcome: Outcome,
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
  signature: Schema.String.annotate({
    description: "Short fingerprint of the failure, e.g. error message or stack trace head"
  })
})

/** Every attempt, collated. `divergent` is true when the runs both passed and failed. */
export const Evidence = Schema.Struct({
  totalRuns: Schema.Number,
  passes: Schema.Number,
  failures: Schema.Number,
  uniqueSignatures: Schema.Array(Schema.String),
  divergent: Schema.Boolean,
  runs: Schema.Array(Schema.Struct({
    attempt: Schema.Number,
    outcome: Outcome,
    signature: Schema.String,
    durationMs: Schema.Number
  }))
})

/** The flakiness report the flow settles with. */
export const Report = Schema.Struct({
  classification: Schema.Literals(["flaky", "consistent-pass", "consistent-fail"]),
  confidence: Fraction,
  flakeRate: Fraction,
  rootCauseCandidates: Schema.Array(Schema.String),
  recommendation: Schema.String,
  summary: Schema.String
})

/** One attempt: run the command and report what happened. */
export const RunTest = AgentAction.make("examples/FlakeHunter/Run", {
  payload: { command: Schema.String, attempt: Schema.Number, maxRuns: Schema.Number, previousOutcome: Schema.String },
  output: RunResult,
  seat,
  system: [
    `You are a test runner. Execute the provided test command exactly as given.
Capture stdout, stderr, exit code, and wall-clock duration. Parse the output to extract
a short failure signature (the key error message or stack trace head). Do not modify the command.`
  ],
  prompt: ({ attempt, command, maxRuns, previousOutcome }) =>
    `Run attempt ${attempt} of ${maxRuns}.\n\nCommand: ${command}\nPrevious outcome: ${previousOutcome}`
})

/** The analyst, asked only when the runs diverged. */
export const Analyze = AgentAction.make("examples/FlakeHunter/Analyze", {
  payload: { command: Schema.String, evidence: Evidence },
  output: Report,
  seat,
  system: [
    `You are a flake analyst. Examine the evidence from multiple test runs.
Identify patterns in timing, error signatures, and environmental factors that explain
divergent outcomes. Be specific about root-cause candidates and actionable in recommendations.`
  ],
  prompt: ({ command, evidence }) =>
    `Analyze why this test's outcomes diverged.\n\nCommand: ${command}\nEvidence: ${JSON.stringify(evidence)}`
})

type RunResult = typeof RunResult.Type
type Evidence = typeof Evidence.Type
type Report = typeof Report.Type

/** Collates every attempt. Pure, so it is a `Node.map`, not a step. */
const pack = (results: ReadonlyArray<RunResult>): Evidence => {
  const passes = results.filter((r) => r.outcome === "pass").length
  const failures = results.filter((r) => r.outcome === "fail").length
  return {
    totalRuns: results.length,
    passes,
    failures,
    uniqueSignatures: [...new Set(results.map((r) => r.signature))],
    divergent: passes > 0 && failures > 0,
    runs: results.map(({ attempt, durationMs, outcome, signature }) => ({ attempt, outcome, signature, durationMs }))
  }
}

/** The report for runs that all passed or all failed. */
const consistent = (evidence: Evidence): Report => {
  const passed = evidence.passes === evidence.totalRuns
  return {
    classification: passed ? "consistent-pass" : "consistent-fail",
    confidence: 1,
    flakeRate: passed ? 0 : 1,
    rootCauseCandidates: [],
    recommendation: passed
      ? "Test passes consistently — original failure may have been environmental."
      : `Test fails consistently with signature: ${evidence.uniqueSignatures[0] ?? "unknown"}`,
    summary: `${evidence.totalRuns} runs, all ${passed ? "passed" : "failed"}. No flakiness detected.`
  }
}

type Requirements = Action.Requirement<"examples/FlakeHunter/Run" | "examples/FlakeHunter/Analyze">

/**
 * Attempt `attempt`, then the next, then the report. `results` holds planned
 * references, so the report step reads them only once they have run.
 */
const rerun = (
  command: string,
  maxRuns: number,
  attempt: number,
  previousOutcome: Planned.Planned<string> | string,
  results: ReadonlyArray<Planned.Planned<RunResult>>
): Node.Node<Report, AgentAction.AgentFailure, Requirements> =>
  attempt > maxRuns
    ? Node.branch(Node.map(Node.succeed(results), pack), {
      if: (evidence) => evidence.divergent,
      then: (evidence) => Analyze.call({ command, evidence }),
      else: (evidence) => Node.map(Node.succeed(evidence), consistent)
    })
    : Node.bindPlanned(
      RunTest.call({ command, attempt, maxRuns, previousOutcome }),
      (result: Planned.Planned<RunResult>) => rerun(command, maxRuns, attempt + 1, result.outcome, [...results, result])
    )

/** The flow. `runs` is real at plan time, so it sets how many attempts the plan holds. */
export const FlakeHunter = Flow.make("examples/FlakeHunter", {
  payload: { command: Schema.String, runs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))) },
  success: Report,
  error: AgentAction.AgentFailure,
  body: ({ command, runs = 5 }) => rerun(command, runs, 1, "none", [])
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(RunTest.layer, Analyze.layer)
