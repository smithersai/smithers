/**
 * Turn an issue or traceback into the smallest failing test before any fix is attempted.
 *
 * Port of the 0.x `failing-test-author.jsx`. An issue reader agent names the
 * component, the reproduction steps and the gap between expected and actual
 * behavior. A test author agent writes the smallest test that asserts the
 * expected behavior, and a run step runs it. The report marks the issue ready
 * for a fix only when the test failed; nothing in the flow attempts one.
 *
 * 0.x ran the test with an agent told to report the result; here the run is a deterministic `Action` a host implements with the repository's test runner, because the 1.0 completion brake refuses an agent's report of commands its run never recorded.
 * 0.x's `.mdx` prompts were placeholders that printed their props; the prompts here state the same props.
 * 0.x gave the agents `read`, `write` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** The issue as the caller reports it. Every field is optional, as in 0.x. */
export const IssueReport = Schema.Struct({
  title: Schema.optional(Schema.String),
  traceback: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  endpoint: Schema.optional(Schema.String)
})

/** What the issue reader found. */
export const Analysis = Schema.Struct({
  component: Schema.String,
  reproSteps: Schema.Array(Schema.String),
  expectedBehavior: Schema.String,
  actualBehavior: Schema.String,
  summary: Schema.String
})

/** The test the author wrote. */
export const AuthoredTest = Schema.Struct({
  testPath: Schema.String,
  testName: Schema.String,
  assertion: Schema.String,
  linesOfCode: Schema.Number,
  summary: Schema.String
})

/** What running the test showed. */
export const RunResult = Schema.Struct({
  testPath: Schema.String,
  didFail: Schema.Boolean,
  exitCode: Schema.Number,
  errorOutput: Schema.String,
  summary: Schema.String
})

/** The handoff the flow settles with. */
export const Report = Schema.Struct({
  reproTestPath: Schema.String,
  verified: Schema.Boolean,
  readyForFix: Schema.Boolean,
  summary: Schema.String
})

/** Reads the issue and pins down what is broken. */
export const AnalyzeIssue = AgentAction.make("examples/FailingTestAuthor/Analyze", {
  payload: { issue: IssueReport },
  output: Analysis,
  seat,
  system: [
    `You are a bug triage specialist. Read the issue description and any
traceback provided, then identify the affected component, minimal reproduction steps,
and the gap between expected and actual behavior. Be precise and concise.`
  ],
  prompt: ({ issue }) => `Analyze this issue.\n\nIssue: ${JSON.stringify(issue)}`
})

/** Writes the smallest test that reproduces the bug. */
export const AuthorTest = AgentAction.make("examples/FailingTestAuthor/Author", {
  payload: {
    component: Schema.String,
    reproSteps: Schema.Array(Schema.String),
    expectedBehavior: Schema.String,
    actualBehavior: Schema.String,
    testDir: Schema.String
  },
  output: AuthoredTest,
  seat,
  system: [
    `You are a test engineer. Write the smallest possible failing test that
reproduces the reported bug. The test must fail for the right reason — it should assert
the expected behavior that is currently broken. Follow existing test conventions in the
codebase. Do NOT attempt to fix the bug.`
  ],
  prompt: ({ actualBehavior, component, expectedBehavior, reproSteps, testDir }) =>
    `Write a failing test in ${testDir}.\n\nComponent: ${component}\nReproduction steps: ${
      JSON.stringify(reproSteps)
    }\nExpected behavior: ${expectedBehavior}\nActual behavior: ${actualBehavior}`
})

/**
 * Runs `testCmd` on the new test file and reports whether it failed. A host
 * implements it with the repository's test runner; the tests implement it
 * with a deterministic layer.
 */
export const RunTest = Action.make("examples/FailingTestAuthor/Run", {
  payload: { testPath: Schema.String, testCmd: Schema.String },
  success: RunResult
})

/** The handoff. Pure, so it is a `Node.map`, not a step. */
const report = (
  { run, testPath }: { readonly testPath: string; readonly run: typeof RunResult.Type }
): typeof Report.Type => ({
  reproTestPath: testPath,
  verified: run.didFail,
  readyForFix: run.didFail,
  summary: run.didFail
    ? `Verified failing test at ${testPath} — ready for fix`
    : "Test did not fail as expected — repro may be incomplete"
})

/** The flow: analyze, author, run, report. */
export const FailingTestAuthor = Flow.make("examples/FailingTestAuthor", {
  payload: {
    issue: Schema.optional(IssueReport),
    testDir: Schema.optional(Schema.String),
    testCmd: Schema.optional(Schema.String)
  },
  success: Report,
  error: AgentAction.AgentFailure,
  body: ({ issue = {}, testCmd = "npx vitest run", testDir = "tests" }) =>
    Node.bindPlanned(
      AnalyzeIssue.call({ issue }),
      (analysis: Planned.Planned<typeof Analysis.Type>) =>
        Node.bindPlanned(
          AuthorTest.call({
            component: analysis.component,
            reproSteps: analysis.reproSteps,
            expectedBehavior: analysis.expectedBehavior,
            actualBehavior: analysis.actualBehavior,
            testDir
          }),
          (test: Planned.Planned<typeof AuthoredTest.Type>) =>
            Node.bindPlanned(
              RunTest.call({ testPath: test.testPath, testCmd }),
              (run: Planned.Planned<typeof RunResult.Type>) =>
                Node.map(Node.succeed({ testPath: test.testPath, run }), report)
            )
        )
    )
})

/** Every agent step the flow calls. The host implements {@link RunTest}. */
export const layer = Layer.mergeAll(AnalyzeIssue.layer, AuthorTest.layer)
