/**
 * Run the visual tests, pair each failure's screenshots, explain what changed, and report.
 *
 * Port of the 0.x `visual-diff-explainer.jsx`. Four agents run in sequence: a
 * runner executes the visual suite and lists the failed tests with their
 * baseline and current screenshot paths, a collector pairs and encodes each
 * failure's images, a vision analyst explains every pair in one call, and a
 * reporter ranks the findings by severity. There is no branch: a run with no
 * failures still asks every step.
 *
 * 0.x's prompts were placeholders that printed their props; these prompts state the same props.
 * 0.x gave the agents `bash`, `read` and `write` tools and the reporter wrote `outputFile`; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`), so the report carries its markdown.
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** The failed visual tests the runner found. */
export const FailedTests = Schema.Struct({
  tests: Schema.Array(Schema.Struct({
    name: Schema.String,
    suite: Schema.String,
    baselinePath: Schema.String,
    currentPath: Schema.String,
    diffPercentage: Schema.Number
  })),
  totalFailed: Schema.Number,
  runner: Schema.String
})

/** Each failure's screenshots, encoded. */
export const ImagePairs = Schema.Struct({
  pairs: Schema.Array(Schema.Struct({
    testName: Schema.String,
    suite: Schema.String,
    baselineImage: Schema.String.annotate({ description: "Base64-encoded baseline screenshot" }),
    currentImage: Schema.String.annotate({ description: "Base64-encoded current screenshot" }),
    diffPercentage: Schema.Number,
    viewport: Schema.optional(Schema.String)
  }))
})

/** What changed in each pair, and why. */
export const Analysis = Schema.Struct({
  findings: Schema.Array(Schema.Struct({
    testName: Schema.String,
    changedRegion: Schema.String.annotate({ description: "Human-readable description of the changed UI area" }),
    changeType: Schema.Literals([
      "layout-shift",
      "color-change",
      "content-change",
      "visibility-toggle",
      "spacing",
      "typography",
      "z-index",
      "other"
    ]),
    likelyCause: Schema.String.annotate({ description: "Most probable code-level cause of the visual change" }),
    severity: Schema.Literals(["critical", "major", "minor", "cosmetic"]),
    affectedComponents: Schema.Array(Schema.String),
    summary: Schema.String
  }))
})

/** The regression report the flow settles with. */
export const Report = Schema.Struct({
  title: Schema.String,
  totalRegressions: Schema.Number,
  criticalCount: Schema.Number,
  findings: Schema.Array(Schema.Struct({
    testName: Schema.String,
    changedRegion: Schema.String,
    changeType: Schema.String,
    likelyCause: Schema.String,
    severity: Schema.String,
    summary: Schema.String
  })),
  recommendation: Schema.String,
  markdown: Schema.String
})

/** Runs the visual suite and lists its failures. */
export const RunTests = AgentAction.make("examples/VisualDiffExplainer/RunTests", {
  payload: { testCommand: Schema.String, baselineDir: Schema.String, currentDir: Schema.String },
  output: FailedTests,
  seat,
  system: [
    `You are a visual regression test runner. Execute the visual test suite,
identify failed tests, and collect the file paths for baseline and current screenshots.
Parse test output to extract diff percentages and test metadata.`
  ],
  prompt: ({ baselineDir, currentDir, testCommand }) =>
    `Run the visual tests.\n\nCommand: ${testCommand}\nBaseline directory: ${baselineDir}\nCurrent directory: ${currentDir}`
})

/** Pairs and encodes each failure's screenshots. */
export const CollectPairs = AgentAction.make("examples/VisualDiffExplainer/CollectPairs", {
  payload: { tests: FailedTests.fields.tests, totalFailed: Schema.Number },
  output: ImagePairs,
  seat,
  system: [
    `You are an image pair collector. Read baseline and current screenshot files
for each failed visual test. Encode images as base64 and pair them with their test metadata.
Extract viewport information from file names or test config when available.`
  ],
  prompt: ({ tests, totalFailed }) =>
    `Collect the screenshot pairs for ${totalFailed} failed tests.\n\nTests: ${JSON.stringify(tests)}`
})

/** Explains every pair in one call. */
export const AnalyzeDiff = AgentAction.make("examples/VisualDiffExplainer/AnalyzeDiff", {
  payload: { pairs: ImagePairs.fields.pairs },
  output: Analysis,
  seat,
  system: [
    `You are a visual regression analyst with deep UI/UX expertise.
Compare baseline and current screenshots side by side. Identify exactly what changed,
which UI region is affected, and infer the most likely code-level cause (CSS change,
component re-render, data change, layout reflow, etc). Be specific about selectors
and component names when possible.`
  ],
  prompt: ({ pairs }) => `Explain what changed in each screenshot pair.\n\nPairs: ${JSON.stringify(pairs)}`
})

/** Writes the regression report. */
export const WriteReport = AgentAction.make("examples/VisualDiffExplainer/Report", {
  payload: { findings: Analysis.fields.findings, outputFile: Schema.String, repository: Schema.String },
  output: Report,
  seat,
  system: [
    `You are a visual regression report writer. Synthesize analysis findings
into a clear, actionable report. Prioritize by severity. Include a recommendation on
whether the changes are intentional (update baselines) or bugs (file issues).`
  ],
  prompt: ({ findings, outputFile, repository }) =>
    `Write the visual regression report.\n\nRepository: ${repository}\nOutput file: ${outputFile}\nFindings: ${
      JSON.stringify(findings)
    }`
})

/** The pipeline: run, collect, analyze, report. */
export const VisualDiffExplainer = Flow.make("examples/VisualDiffExplainer", {
  payload: {
    testCommand: Schema.optional(Schema.String),
    baselineDir: Schema.optional(Schema.String),
    currentDir: Schema.optional(Schema.String),
    outputFile: Schema.optional(Schema.String),
    repository: Schema.optional(Schema.String)
  },
  success: Report,
  error: AgentAction.AgentFailure,
  body: ({
    baselineDir = "__screenshots__/baseline",
    currentDir = "__screenshots__/current",
    outputFile = "visual-regression-report.md",
    repository = "unknown",
    testCommand = "npx playwright test --reporter=json"
  }) =>
    Node.bindPlanned(
      RunTests.call({ testCommand, baselineDir, currentDir }),
      (failed: Planned.Planned<typeof FailedTests.Type>) =>
        Node.bindPlanned(
          CollectPairs.call({ tests: failed.tests, totalFailed: failed.totalFailed }),
          (collected: Planned.Planned<typeof ImagePairs.Type>) =>
            Node.bindPlanned(
              AnalyzeDiff.call({ pairs: collected.pairs }),
              (analysis: Planned.Planned<typeof Analysis.Type>) =>
                WriteReport.call({ findings: analysis.findings, outputFile, repository })
            )
        )
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(RunTests.layer, CollectPairs.layer, AnalyzeDiff.layer, WriteReport.layer)
