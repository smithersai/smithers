// @ts-nocheck
/**
 * <VisualDiffExplainer> — Compare baseline/current screenshots and explain visual regressions.
 *
 * Pattern: Visual test runner → image pair collector → vision agent → report sink.
 * Use cases: visual regression triage, screenshot diff review, UI change attribution.
 */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { bash, read, write } from "smithers-orchestrator/tools";
import { z } from "zod";
import RunTestsPrompt from "./prompts/visual-diff-explainer/run-tests.mdx";
import CollectPairsPrompt from "./prompts/visual-diff-explainer/collect-pairs.mdx";
import AnalyzeDiffPrompt from "./prompts/visual-diff-explainer/analyze-diff.mdx";
import ReportPrompt from "./prompts/visual-diff-explainer/report.mdx";

const failedTestSchema = z.object({
  tests: z.array(z.object({
    name: z.string(),
    suite: z.string(),
    baselinePath: z.string(),
    currentPath: z.string(),
    diffPercentage: z.number(),
  })),
  totalFailed: z.number(),
  runner: z.string(),
});

const imagePairSchema = z.object({
  pairs: z.array(z.object({
    testName: z.string(),
    suite: z.string(),
    baselineImage: z.string().describe("Base64-encoded baseline screenshot"),
    currentImage: z.string().describe("Base64-encoded current screenshot"),
    diffPercentage: z.number(),
    viewport: z.string().optional(),
  })),
});

const analysisSchema = z.object({
  findings: z.array(z.object({
    testName: z.string(),
    changedRegion: z.string().describe("Human-readable description of the changed UI area"),
    changeType: z.enum(["layout-shift", "color-change", "content-change", "visibility-toggle", "spacing", "typography", "z-index", "other"]),
    likelyCause: z.string().describe("Most probable code-level cause of the visual change"),
    severity: z.enum(["critical", "major", "minor", "cosmetic"]),
    affectedComponents: z.array(z.string()),
    summary: z.string(),
  })),
});

const reportSchema = z.object({
  title: z.string(),
  totalRegressions: z.number(),
  criticalCount: z.number(),
  findings: z.array(z.object({
    testName: z.string(),
    changedRegion: z.string(),
    changeType: z.string(),
    likelyCause: z.string(),
    severity: z.string(),
    summary: z.string(),
  })),
  recommendation: z.string(),
  markdown: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  failedTests: failedTestSchema,
  imagePairs: imagePairSchema,
  analysis: analysisSchema,
  report: reportSchema,
});

const testRunner = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are a visual regression test runner. Execute the visual test suite,
identify failed tests, and collect the file paths for baseline and current screenshots.
Parse test output to extract diff percentages and test metadata.`,
});

const collector = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read },
  instructions: `You are an image pair collector. Read baseline and current screenshot files
for each failed visual test. Encode images as base64 and pair them with their test metadata.
Extract viewport information from file names or test config when available.`,
});

const visionAnalyst = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read },
  instructions: `You are a visual regression analyst with deep UI/UX expertise.
Compare baseline and current screenshots side by side. Identify exactly what changed,
which UI region is affected, and infer the most likely code-level cause (CSS change,
component re-render, data change, layout reflow, etc). Be specific about selectors
and component names when possible.`,
});

const reporter = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { write },
  instructions: `You are a visual regression report writer. Synthesize analysis findings
into a clear, actionable report. Prioritize by severity. Include a recommendation on
whether the changes are intentional (update baselines) or bugs (file issues).`,
});

export default smithers((ctx) => {
  const failedTests = ctx.outputMaybe("failedTests", { nodeId: "run-tests" });
  const imagePairs = ctx.outputMaybe("imagePairs", { nodeId: "collect-pairs" });
  const analysis = ctx.outputMaybe("analysis", { nodeId: "analyze-diff" });

  return (
    <Workflow name="visual-diff-explainer">
      <Sequence>
        <Task id="run-tests" output={outputs.failedTests} agent={testRunner}>
          <RunTestsPrompt
            testCommand={ctx.input.testCommand ?? "npx playwright test --reporter=json"}
            baselineDir={ctx.input.baselineDir ?? "__screenshots__/baseline"}
            currentDir={ctx.input.currentDir ?? "__screenshots__/current"}
          />
        </Task>

        <Task id="collect-pairs" output={outputs.imagePairs} agent={collector}>
          <CollectPairsPrompt
            tests={failedTests?.tests ?? []}
            totalFailed={failedTests?.totalFailed ?? 0}
          />
        </Task>

        <Task id="analyze-diff" output={outputs.analysis} agent={visionAnalyst}>
          <AnalyzeDiffPrompt
            pairs={imagePairs?.pairs ?? []}
          />
        </Task>

        <Task id="report" output={outputs.report} agent={reporter}>
          <ReportPrompt
            findings={analysis?.findings ?? []}
            outputFile={ctx.input.outputFile ?? "visual-regression-report.md"}
            repository={ctx.input.repository ?? "unknown"}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
