/**
 * Pick the tests a change most likely breaks, run them in parallel shards, and judge the results.
 *
 * Port of the 0.x `test-sharder-judge.jsx`. A change analyzer agent reads the
 * diff, and a test selector agent picks the priority tests and the ones to
 * defer. A runner agent runs each priority test, four at a time by default,
 * and a failing or timed-out runner drops only its own result. An adjudicator
 * agent reads the results, the deferred tests and the risk level, and settles
 * on a verdict.
 *
 * 0.x re-rendered its tree once the selection landed; here the runners run in a `.child()` flow whose body plans over the real selection.
 * `MapReduce` does not fit: its reducer reads only the mapped rows, and 0.x's adjudicator also reads the selection's deferred tests and the analysis's risk level.
 * 0.x's prompts were placeholders that printed their props; these are minimal prompts over the same props.
 * 0.x gave the analyzer and selector `bash`, `grep` and `read` tools and the runner `bash` and `read`; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow, Interpreter } from "@smthrs/flow"
import * as Bounded from "@smthrs/patterns/Bounded"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const Risk = Schema.Literals(["low", "medium", "high"])

/** The change analyzer's answer. */
export const Analysis = Schema.Struct({
  changedFiles: Schema.Array(Schema.String),
  affectedModules: Schema.Array(Schema.String),
  riskLevel: Risk
})

/** One test the selector wants run first. */
export const PriorityTest = Schema.Struct({
  file: Schema.String,
  reason: Schema.String,
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
})

/** The selector's answer. */
export const Selection = Schema.Struct({
  priorityTests: Schema.Array(PriorityTest),
  deferredTests: Schema.Array(Schema.String),
  totalCandidates: Schema.Number
})

/** What one runner reports. */
export const RunResult = Schema.Struct({
  testFile: Schema.String,
  status: Schema.Literals(["pass", "fail", "error", "skipped"]),
  durationMs: Schema.Number,
  errorMessage: Schema.optional(Schema.String)
})

/** The verdict the flow settles with. */
export const Adjudication = Schema.Struct({
  verdict: Schema.Literals(["green", "yellow", "red"]),
  failedTests: Schema.Array(Schema.String),
  deferredTests: Schema.Array(Schema.String),
  shouldExpandRun: Schema.Boolean,
  summary: Schema.String
})

type RunResult = typeof RunResult.Type

/** Reads the diff for changed files, affected modules and risk. */
export const AnalyzeChange = AgentAction.make("examples/TestSharderJudge/Analyze", {
  payload: { diff: Schema.String, baseBranch: Schema.String },
  output: Analysis,
  seat,
  system: [
    `You are a change analyzer. Inspect the diff and surrounding context
to determine which files changed, what modules are affected, and the overall risk level.`
  ],
  prompt: ({ baseBranch, diff }) => `Analyze this change against ${baseBranch}.\n\nDiff:\n${diff}`
})

/** Picks the highest-signal tests and defers the rest. */
export const SelectTests = AgentAction.make("examples/TestSharderJudge/Select", {
  payload: {
    changedFiles: Schema.Array(Schema.String),
    affectedModules: Schema.Array(Schema.String),
    riskLevel: Risk,
    testGlob: Schema.String
  },
  output: Selection,
  seat,
  system: [
    `You are a test selector. Given a change analysis, identify the highest-signal
tests to run first. Prioritize tests that directly cover changed code paths. Defer tests
that are unlikely to be affected.`
  ],
  prompt: ({ affectedModules, changedFiles, riskLevel, testGlob }) =>
    `Select the tests to run first among ${testGlob}.\n\nChanged files: ${
      JSON.stringify(changedFiles)
    }\nAffected modules: ${JSON.stringify(affectedModules)}\nRisk level: ${riskLevel}`
})

/** Runs one test file. The run gives up after the payload's `timeoutMs`, as 0.x's task did. */
export const RunTest = AgentAction.make("examples/TestSharderJudge/Run", {
  payload: { testFile: Schema.String, reason: Schema.String, runner: Schema.String, timeoutMs: Schema.Number },
  output: RunResult,
  seat,
  timeout: ({ timeoutMs }) => timeoutMs,
  system: [
    `You are a test runner. Execute the assigned test file and report the result.
Capture the status, duration, and any error messages.`
  ],
  prompt: ({ reason, runner, testFile }) => `Run the test file ${testFile} with ${runner}.\nSelected because: ${reason}`
})

/** Judges the combined results. */
export const Adjudicate = AgentAction.make("examples/TestSharderJudge/Adjudicate", {
  payload: { results: Schema.Array(RunResult), deferredTests: Schema.Array(Schema.String), riskLevel: Risk },
  output: Adjudication,
  seat,
  system: [
    `You are a result adjudicator. Analyze test results and decide whether
the change is safe (green), uncertain and needs more tests (yellow), or broken (red).
If uncertainty remains, recommend expanding to deferred tests.`
  ],
  prompt: ({ deferredTests, results, riskLevel }) =>
    `Adjudicate the test results for this change.\n\nRisk level: ${riskLevel}\nResults: ${
      JSON.stringify(results)
    }\nDeferred tests: ${JSON.stringify(deferredTests)}`
})

/**
 * Runs the selected tests. It runs as a child execution, so its payload is
 * real when its body plans, and it fans out over the tests the selector
 * actually picked.
 */
export const RunShards = Flow.make("examples/TestSharderJudge/RunShards", {
  payload: {
    tests: Schema.Array(PriorityTest),
    runner: Schema.String,
    timeoutMs: Schema.Number,
    concurrency: Schema.Int.check(Schema.isGreaterThan(0))
  },
  success: Schema.Array(RunResult),
  body: ({ concurrency, runner, tests, timeoutMs }) => {
    if (tests.length === 0) return Node.succeed([])
    // 0.x `continueOnFail`: a failed or timed-out runner settles as null instead of failing its siblings.
    const members = Object.fromEntries(tests.map((test, index) => [
      `${index}`,
      Node.catch(RunTest.call({ testFile: test.file, reason: test.reason, runner, timeoutMs }), {
        onFailure: () => Node.succeed(null)
      })
    ]))
    const joined = Bounded.all(members, { concurrency })
    return Node.map(joined, (ran) => Object.values(ran).filter(Schema.is(RunResult)))
  }
})

/** The flow: analyze, select, run the shards, adjudicate. */
export const TestSharderJudge = Flow.make("examples/TestSharderJudge", {
  payload: {
    diff: Schema.String,
    baseBranch: Schema.optional(Schema.String),
    testGlob: Schema.optional(Schema.String),
    runner: Schema.optional(Schema.String),
    maxConcurrency: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    timeoutMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0)))
  },
  success: Adjudication,
  error: AgentAction.AgentFailure,
  body: ({
    baseBranch = "main",
    diff,
    maxConcurrency = 4,
    runner = "npx vitest run",
    testGlob = "**/*.test.{ts,tsx}",
    timeoutMs = 60_000
  }) =>
    Node.bindPlanned(
      AnalyzeChange.call({ diff, baseBranch }),
      (analysis: Planned.Planned<typeof Analysis.Type>) =>
        Node.bindPlanned(
          SelectTests.call({
            changedFiles: analysis.changedFiles,
            affectedModules: analysis.affectedModules,
            riskLevel: analysis.riskLevel,
            testGlob
          }),
          (selection: Planned.Planned<typeof Selection.Type>) =>
            Node.bindPlanned(
              RunShards.child({ tests: selection.priorityTests, runner, timeoutMs, concurrency: maxConcurrency }),
              (results: Planned.Planned<ReadonlyArray<RunResult>>) =>
                Adjudicate.call({ results, deferredTests: selection.deferredTests, riskLevel: analysis.riskLevel })
            )
        )
    )
})

/** Every step the flow calls, and the child flow it starts. */
export const layer = Layer.mergeAll(
  AnalyzeChange.layer,
  SelectTests.layer,
  RunTest.layer,
  Adjudicate.layer,
  Interpreter.layer(RunShards)
)
