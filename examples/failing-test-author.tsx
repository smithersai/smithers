// @ts-nocheck
/**
 * <FailingTestAuthor> — Given an issue or traceback, write the smallest failing test
 * before any fix is attempted.
 *
 * Pattern: Issue reader → repro/test author agent → test runner → downstream handoff.
 */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, write, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import AnalyzePrompt from "./prompts/failing-test-author/analyze.mdx";
import AuthorPrompt from "./prompts/failing-test-author/author.mdx";
import RunnerPrompt from "./prompts/failing-test-author/runner.mdx";

const analysisSchema = z.object({
  component: z.string(),
  reproSteps: z.array(z.string()),
  expectedBehavior: z.string(),
  actualBehavior: z.string(),
  summary: z.string(),
});

const testSchema = z.object({
  testPath: z.string(),
  testName: z.string(),
  assertion: z.string(),
  linesOfCode: z.number(),
  summary: z.string(),
});

const runResultSchema = z.object({
  testPath: z.string(),
  didFail: z.boolean(),
  exitCode: z.number(),
  errorOutput: z.string(),
  summary: z.string(),
});

const reportSchema = z.object({
  reproTestPath: z.string(),
  verified: z.boolean(),
  readyForFix: z.boolean(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  analysis: analysisSchema,
  test: testSchema,
  runResult: runResultSchema,
  report: reportSchema,
});

const issueReader = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are a bug triage specialist. Read the issue description and any
traceback provided, then identify the affected component, minimal reproduction steps,
and the gap between expected and actual behavior. Be precise and concise.`,
});

const testAuthor = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, write, grep },
  instructions: `You are a test engineer. Write the smallest possible failing test that
reproduces the reported bug. The test must fail for the right reason — it should assert
the expected behavior that is currently broken. Follow existing test conventions in the
codebase. Do NOT attempt to fix the bug.`,
});

const testRunner = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `Run the specified test file and report whether it fails. The test MUST
fail to confirm it captures the bug. If it passes, report that verification failed.`,
});

export default smithers((ctx) => {
  const analysis = ctx.outputMaybe("analysis", { nodeId: "analyze" });
  const test = ctx.outputMaybe("test", { nodeId: "author-test" });
  const runResult = ctx.outputMaybe("runResult", { nodeId: "run-test" });

  return (
    <Workflow name="failing-test-author">
      <Sequence>
        <Task id="analyze" output={outputs.analysis} agent={issueReader}>
          <AnalyzePrompt
            title={ctx.input.issue?.title}
            traceback={ctx.input.issue?.traceback}
            description={ctx.input.issue?.description}
            endpoint={ctx.input.issue?.endpoint}
          />
        </Task>

        {analysis && (
          <Task id="author-test" output={outputs.test} agent={testAuthor}>
            <AuthorPrompt
              component={analysis.component}
              reproSteps={analysis.reproSteps}
              expectedBehavior={analysis.expectedBehavior}
              actualBehavior={analysis.actualBehavior}
              testDir={ctx.input.testDir ?? "tests"}
            />
          </Task>
        )}

        {test && (
          <Task id="run-test" output={outputs.runResult} agent={testRunner}>
            <RunnerPrompt
              testPath={test.testPath}
              testCmd={ctx.input.testCmd ?? "npx vitest run"}
            />
          </Task>
        )}

        {runResult && (
          <Task id="report" output={outputs.report}>
            {{
              reproTestPath: test?.testPath ?? "unknown",
              verified: runResult.didFail,
              readyForFix: runResult.didFail,
              summary: runResult.didFail
                ? `Verified failing test at ${test?.testPath} — ready for fix`
                : `Test did not fail as expected — repro may be incomplete`,
            }}
          </Task>
        )}
      </Sequence>
    </Workflow>
  );
});
